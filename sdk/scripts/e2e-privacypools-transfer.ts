/**
 * E2E test script: Privacy Pools v2 internal transfer via paymaster.
 *
 * Unlike the withdrawal e2e, this tests an INTERNAL TRANSFER where funds move
 * between notes inside the pool. Only the fee (amountOut = feeAmount) exits
 * the pool to pay the paymaster. The transfer recipient receives a shielded
 * note — no ETH leaves the pool for them.
 *
 * Prerequisites:
 *   1. Anvil fork running in a separate terminal:
 *        anvil --fork-url $SEPOLIA_RPC_URL --fork-block-number $BLOCK --hardfork prague
 *   2. PP v2 circuit artifacts built:
 *        (cd ../v2-monorepo/packages/circuits && pnpm build)
 *   3. PP v2 SDK linked locally:
 *        bun add @privacy-pools-v2/sdk@file:../../v2-monorepo/packages/sdk
 *
 * Usage:
 *   npx tsx sdk/scripts/e2e-privacypools-transfer.ts
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
    createWalletClient,
    createTestClient,
    createPublicClient,
    http,
    parseEther,
    encodeFunctionData,
    toFunctionSelector,
    type Address,
    type Hex,
    publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { randomBytes } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519";

import {
    ASPClient,
    CryptoService,
    EntrypointInteractor,
    Groth16Prover,
    HTTPClient,
    KeystoreInteractor,
    KeystoreManager,
    LocalCircuitArtifacts,
    MerkleService,
    NoteComputationService,
    NoteManager,
    PoolSessionFactory,
    PoolVaultInteractor,
    PoseidonHashService,
    ProofService,
    RelayerInteractor,
    ViemRPCInteractor,
    WitnessPreparationService,
} from "@privacy-pools-v2/sdk";
import type {
    Hash,
    IASPDataProvider,
    LabelStatus,
    AccountExport,
} from "@privacy-pools-v2/sdk";

import { startServers } from "../src/bundler-server";
import { BundlerClient } from "../src/bundlerClient";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const ANVIL_URL = "http://127.0.0.1:8545";

// Anvil default account #0
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
// Alto bundler accounts (must be funded)
const ALTO_EXECUTOR_PK = "0x4a3a02862ddcb260ed52d40ef03f8e3d78fa3d174b0ef333afdf1ffb4a648cd5" as Hex;
const ALTO_UTILITY_PK = "0xdd4b2564c83ff7de602c39ffda1146055dc1814b07c083d7971722384f1f01a6" as Hex;

// --- PP v2 contract addresses (Sepolia — latest deployment) ---
const PP_POOL_VAULT = "0x09b94d3127019298757A6ceeB7911922085f7C01" as Address;
const PP_ENTRYPOINT = "0xEB3e3961008952348445513e418ad6F43C23ca9a" as Address;
const PP_KEYSTORE = "0x6d264aCb9C3A7A3105c29470AfE2F5F1EC203C73" as Address;
const PP_ASP_REGISTRY = "0x35D29EFDCf067599ab4A53cf40229477f0b1cA9c" as Address;
const PP_RELAY = "0x762665Dc7aAeeA25DC1759AEBef1F61730497f6e" as Address;

// Operator address — holds POSTMAN_ROLE, DEFAULT_ADMIN, OPS_ADMIN, etc.
const POSTMAN_ADDRESS = "0x723a43064e73Bcf46cf7d9b8506C400Df8ac878b" as Address;

// ASP public key for ECDH encryption (only affects off-chain ciphertext, not on-chain validation)
const ASP_PUBLIC_KEY = ("0x" + Buffer.from(
    x25519.getPublicKey(randomBytes(32)),
).toString("hex")) as Hex;

// ERC-4337 EntryPoint (v0.8)
const ERC4337_ENTRYPOINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108" as Address;

// Native ETH sentinel used by PP v2
const NATIVE_ASSET = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

// --- Gas parameters (used to compute fee) ---
const MAX_FEE_PER_GAS = 2_000_000_000n;        // 2 gwei
const MAX_PRIORITY_FEE = 1_000_000_000n;        // 1 gwei
const CALL_GAS_LIMIT = 2_000_000n;
const VERIFICATION_GAS_LIMIT = 1_000_000n;
const PRE_VERIFICATION_GAS = 200_000n;
const PAYMASTER_VERIFICATION_GAS = 1_000_000n;
const PAYMASTER_POSTOP_GAS = 200_000n;

const TOTAL_GAS = CALL_GAS_LIMIT + VERIFICATION_GAS_LIMIT + PRE_VERIFICATION_GAS
    + PAYMASTER_VERIFICATION_GAS + PAYMASTER_POSTOP_GAS;
const MAX_GAS_COST = TOTAL_GAS * MAX_FEE_PER_GAS;

// Fee = max gas cost + 10% margin
const FEE_AMOUNT = MAX_GAS_COST + MAX_GAS_COST / 10n;

// Deposit must cover fee + transfer amount
const DEPOSIT_AMOUNT = parseEther("0.1");
// Transfer amount — goes to recipient note INSIDE the pool
// Computed as: deposit - fee (spend entire note)
const TRANSFER_AMOUNT = DEPOSIT_AMOUNT - FEE_AMOUNT;

// Circuit artifacts path (relative to v2-monorepo)
const CIRCUIT_ARTIFACTS_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "..", "v2-monorepo", "packages", "circuits", "build",
);

// ═══════════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════════

const ASP_REGISTRY_ABI = [
    {
        name: "updateASPRoot",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "_aspRoot", type: "uint256" },
            { name: "_ipfsCID", type: "bytes" },
        ],
        outputs: [],
    },
] as const;

const PRIVACY_ACCOUNT_ABI = [
    {
        type: "function",
        name: "execute",
        inputs: [
            { name: "feeCalldata", type: "bytes" },
            {
                name: "tail",
                type: "tuple[]",
                components: [
                    { name: "target", type: "address" },
                    { name: "data", type: "bytes" },
                ],
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function forge(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        console.log(`  [forge] ${args.join(" ")}`);
        const proc = spawn("forge", args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        let stdout = "";
        proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        proc.on("close", (code) => {
            if (code !== 0) {
                console.error(stdout);
                reject(new Error(`forge ${args[0]} failed:\n${stderr}`));
            } else resolve(stdout + "\n" + stderr);
        });
    });
}

/** Deploy paymaster + PrivacyPoolsAccount, return addresses. */
async function deployContracts(forkUrl: string, privateKey: Hex) {
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const deployEnv = "anvil-e2e-pp";
    const deploymentsPath = join(projectRoot, `config/deployments/${deployEnv}.json`);

    // Copy sepolia chain config — we're forking Sepolia but need a separate deploy env
    const chainConfigSrc = join(projectRoot, "config/chains/sepolia.toml");
    const chainConfigDst = join(projectRoot, `config/chains/${deployEnv}.toml`);
    await writeFile(chainConfigDst, await readFile(chainConfigSrc, "utf-8"));

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        DEPLOY_ENV: deployEnv,
        PRIVATE_KEY: privateKey,
    };

    const deployments: Record<string, Record<string, string>> = {};

    // Deploy paymaster — parse address from console.log output
    const deployOutput = await forge(
        ["script", "DeployPaymaster", "--fork-url", forkUrl, "--broadcast"],
        env, projectRoot,
    );
    const paymasterMatch = deployOutput.match(/Deployed Paymaster at:\s*(0x[0-9a-fA-F]{40})/);
    if (!paymasterMatch) throw new Error(`Could not parse paymaster address from forge output:\n${deployOutput}`);
    deployments.paymaster = { address: paymasterMatch[1]! };
    await writeFile(deploymentsPath, JSON.stringify(deployments, null, 2));

    // Stake paymaster (reads paymaster address from JSON)
    await forge(
        ["script", "StakePaymaster", "--fork-url", forkUrl, "--broadcast"],
        {
            ...env,
            STAKE_AMOUNT: parseEther("0.1").toString(),
            UNSTAKE_DELAY: "3600",
            DEPOSIT_AMOUNT: parseEther("0.1").toString(),
        },
        projectRoot,
    );

    // Deploy PrivacyPoolsAccount + register with paymaster
    const ppOutput = await forge(
        ["script", "DeployPrivacyPools", "--fork-url", forkUrl, "--broadcast"],
        env, projectRoot,
    );
    const ppMatch = ppOutput.match(/Deployed PrivacyPoolsAccount at:\s*(0x[0-9a-fA-F]{40})/);
    if (!ppMatch) throw new Error(`Could not parse PrivacyPoolsAccount address from forge output:\n${ppOutput}`);
    deployments.privacypools = { privacyPoolsAccount: ppMatch[1]! };
    await writeFile(deploymentsPath, JSON.stringify(deployments, null, 2));

    return {
        paymasterAddress: paymasterMatch[1] as Address,
        privacyPoolsAccountAddress: ppMatch[1] as Address,
    };
}

/** Swap PoolVault.transact selector → PrivacyPoolRelay.relay selector in calldata. */
function transactToRelayCalldata(transactCalldata: Hex): Hex {
    const relaySelector = toFunctionSelector(
        "relay((uint256[2],uint256[2][2],uint256[2],uint256[][]),(address,bytes),(bytes32,bytes)[])",
    );
    // Replace first 4 bytes (after 0x prefix = 10 chars) with relay selector
    return (relaySelector + transactCalldata.slice(10)) as Hex;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PP v2 SESSION
// ═══════════════════════════════════════════════════════════════════════════════

interface SessionContext {
    aspLeaves: Hash[];
    aspRoot: Hash;
}

function buildInMemoryASPProvider(
    aspLeaves: Hash[],
    aspRoot: Hash,
    aspPublicKey: Hex,
): IASPDataProvider {
    return {
        getRoot: async () => aspRoot,
        getLeaves: async () => aspLeaves,
        getLabelStatus: async () => ({ status: "approved" }) as LabelStatus,
        getASPPublicKey: async () => aspPublicKey,
        getEventSnapshot: async () => ({ leaves: aspLeaves, root: aspRoot }),
        getNoteEvents: async () => [],
    } as unknown as IASPDataProvider;
}

async function createPoolSession(
    ownerAddress: Address,
    keys: {
        privateNullifyingKey: Hex;
        privateRevocableKey: Hex;
        viewingPrivateKey: Hex;
        viewingPublicKey: Hex;
    },
    sessionCtx: SessionContext,
) {
    const rpcInteractor = ViemRPCInteractor.create({
        rpcUrl: ANVIL_URL,
        chain: sepolia as any, // cast: viem version mismatch between our sdk and pp-v2 sdk
    });

    const entrypointInteractor = new EntrypointInteractor({
        rpcInteractor,
        contractAddress: PP_ENTRYPOINT,
    });

    const keystoreInteractor = new KeystoreInteractor({
        rpcInteractor,
        contractAddress: PP_KEYSTORE,
    });

    const hashService = await PoseidonHashService.create();
    const merkleService = new MerkleService({ hashService });
    const cryptoService = new CryptoService();

    const noteComputationService = new NoteComputationService({
        hashService,
        cryptoService,
    });

    const witnessPreparationService = new WitnessPreparationService({
        noteComputationService,
        hashService,
        merkleService,
    });

    const groth16Prover = new Groth16Prover();
    const circuitArtifacts = new LocalCircuitArtifacts(CIRCUIT_ARTIFACTS_DIR);
    const proofService = new ProofService({ circuitArtifacts, groth16Prover });
    const noteManager = new NoteManager({});

    const keystoreManager = new KeystoreManager({
        privateNullifyingKey: keys.privateNullifyingKey,
        privateRevocableKey: keys.privateRevocableKey,
        viewingPrivateKey: keys.viewingPrivateKey,
        viewingPublicKey: keys.viewingPublicKey,
        revocableKeyIndex: "0x0" as Hex,
    });

    const poolVaultInteractor = new PoolVaultInteractor({
        rpcInteractor,
        contractAddress: PP_POOL_VAULT,
    });

    // Snapshot ASP state
    const aspLeaves = [...sessionCtx.aspLeaves];
    const aspRoot = sessionCtx.aspRoot;
    const aspDataProvider = buildInMemoryASPProvider(aspLeaves, aspRoot, ASP_PUBLIC_KEY);
    const aspClient = new ASPClient({
        providers: [aspDataProvider],
        merkleService,
        publicKey: ASP_PUBLIC_KEY,
    });

    // Dummy relayer — we submit UserOps directly, not via relayer HTTP
    const httpClient = new HTTPClient();
    const relayerInteractor = new RelayerInteractor({
        relayers: [{
            name: "dummy",
            url: "http://localhost:9999",
            address: PP_RELAY,
            processorAddress: PP_RELAY,
            chainId: sepolia.id,
            chainType: "evm",
            status: "active",
        }],
        httpClient,
    });
    relayerInteractor.getRelayers = async () => [];

    const poolSession = PoolSessionFactory.create({
        ownerAddress,
        chainId: sepolia.id,
        cryptoService,
        witnessPreparationService,
        proofService,
        entrypointInteractor,
        noteManager,
        keystoreManager,
        keystoreInteractor,
        hashService,
        merkleService,
        noteComputationService,
        poolVaultInteractor,
        aspClient,
        aspDataProvider,
        relayerInteractor,
        rpcInteractor,
    });

    return { poolSession, rpcInteractor, hashService, merkleService, cryptoService, poolVaultInteractor, keystoreManager };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTE PATCHING (PENDING → ACTIVE)
// ═══════════════════════════════════════════════════════════════════════════════

async function patchNotes(
    accountExport: AccountExport,
    hashService: Awaited<ReturnType<typeof PoseidonHashService.create>>,
    poolVaultInteractor: PoolVaultInteractor,
    privateNullifyingKey: Hex,
) {
    for (const note of accountExport.notes) {
        if (note.status === "SPENT" || (note.status as string) === "EXITED") continue;

        if (note.createdAtBlock === "0x0" || !note.createdAtBlock) {
            note.createdAtBlock = await poolVaultInteractor.getCommitmentTimestamp(
                note.commitment as Hash,
            );
        }

        if (!note.createdAtBlock || BigInt(note.createdAtBlock) === 0n) {
            continue;
        }

        const nullifierHash = hashService.hash([
            privateNullifyingKey,
            note.commitment as Hex,
        ]);
        const nullifierTs = await poolVaultInteractor.getNullifierTimestamp(
            nullifierHash as Hash,
        );

        if (BigInt(nullifierTs) !== 0n) {
            note.status = "SPENT" as typeof note.status;
            note.spentAtBlock = nullifierTs;
        } else if (note.status === "PENDING") {
            note.status = "ACTIVE" as typeof note.status;
            note.spentAtBlock = null;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log("=== Privacy Pools v2 × Paymaster E2E (Internal Transfer) ===\n");

    // ── 1. Clients ──────────────────────────────────────────────────────────
    const deployerAccount = privateKeyToAccount(DEPLOYER_PK);
    const testClient = createTestClient({ chain: sepolia, mode: "anvil", transport: http(ANVIL_URL) });
    const publicClient = createPublicClient({ chain: sepolia, transport: http(ANVIL_URL) });
    const walletClient = createWalletClient({
        chain: sepolia,
        transport: http(ANVIL_URL),
    }).extend(publicActions);

    // ── 2. Fund bundler accounts ────────────────────────────────────────────
    console.log("[1/9] Funding accounts...");
    await testClient.setBalance({ address: deployerAccount.address, value: parseEther("100") });
    await testClient.setBalance({
        address: privateKeyToAccount(ALTO_EXECUTOR_PK).address,
        value: parseEther("100"),
    });
    await testClient.setBalance({
        address: privateKeyToAccount(ALTO_UTILITY_PK).address,
        value: parseEther("100"),
    });

    // ── 3. Start Alto bundler ───────────────────────────────────────────────
    console.log("[2/9] Starting bundler...");
    const servers = await startServers({
        execRpcUrl: ANVIL_URL,
        entrypoint: ERC4337_ENTRYPOINT,
        executorPrivateKey: ALTO_EXECUTOR_PK,
        utilityPrivateKey: ALTO_UTILITY_PK,
    });
    const bundlerClient = new BundlerClient(servers.bundlerRpcUrl, ERC4337_ENTRYPOINT);

    try {
        // ── 4. Deploy paymaster + PrivacyPoolsAccount ───────────────────────
        console.log("[3/9] Deploying paymaster contracts...");
        const { paymasterAddress, privacyPoolsAccountAddress } = await deployContracts(
            ANVIL_URL, DEPLOYER_PK,
        );
        console.log(`  Paymaster: ${paymasterAddress}`);
        console.log(`  PrivacyPoolsAccount impl: ${privacyPoolsAccountAddress}`);

        // ── 5. Generate depositor keys ──────────────────────────────────────
        console.log("[4/9] Setting up depositor session...");

        // Use Anvil account #1 as depositor
        const depositorPK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
        const depositorAccount = privateKeyToAccount(depositorPK);
        await testClient.setBalance({ address: depositorAccount.address, value: parseEther("10") });

        // Generate PP v2 protocol keys (random private keys, derived viewing pubkey)
        const randHex = () => ("0x" + randomBytes(32).toString("hex")) as Hex;
        const viewingPrivKey = randHex();
        const viewingPubBytes = x25519.getPublicKey(
            Buffer.from(viewingPrivKey.slice(2), "hex"),
        );
        const depositorKeys = {
            privateNullifyingKey: randHex(),
            privateRevocableKey: randHex(),
            viewingPrivateKey: viewingPrivKey,
            viewingPublicKey: ("0x" + Buffer.from(viewingPubBytes).toString("hex")) as Hex,
        };

        // Create PP v2 session
        const sessionCtx: SessionContext = { aspLeaves: [], aspRoot: "0x0" as Hash };
        const session = await createPoolSession(
            depositorAccount.address,
            depositorKeys,
            sessionCtx,
        );

        // ── 6. Register keystore ────────────────────────────────────────────
        console.log("[5/9] Registering keystore...");
        const registration = await session.poolSession.prepareRegisterKeystore();

        if (!registration.alreadyRegistered) {
            const { keystoreCalldata, viewingKeyCalldata } = registration;
            if (keystoreCalldata) {
                const hash = await walletClient.sendTransaction({
                    account: depositorAccount,
                    to: keystoreCalldata.to as Address,
                    data: keystoreCalldata.data as Hex,
                    value: BigInt(keystoreCalldata.value),
                    chain: sepolia,
                });
                await publicClient.waitForTransactionReceipt({ hash });
            }

            if (viewingKeyCalldata) {
                const hash = await walletClient.sendTransaction({
                    account: depositorAccount,
                    to: viewingKeyCalldata.to as Address,
                    data: viewingKeyCalldata.data as Hex,
                    value: BigInt(viewingKeyCalldata.value),
                    chain: sepolia,
                });
                await publicClient.waitForTransactionReceipt({ hash });
            }
            console.log("  Keystore registered");
        } else {
            console.log("  Already registered");
        }

        // Print address legend for on-chain tracing
        console.log("\n--- Address Legend ---");
        console.log(`  Deployer:             ${deployerAccount.address}`);
        console.log(`  Depositor:            ${depositorAccount.address}`);
        console.log(`  Paymaster:            ${paymasterAddress}`);
        console.log(`  PrivacyPoolsAccount:  ${privacyPoolsAccountAddress}`);
        console.log(`  PoolVault:            ${PP_POOL_VAULT}`);
        console.log(`  Relay:                ${PP_RELAY}`);
        console.log(`  EntryPoint (4337):    ${ERC4337_ENTRYPOINT}`);
        console.log(`  Bundler executor:     ${privateKeyToAccount(ALTO_EXECUTOR_PK).address}`);
        console.log("---------------------\n");

        // ── 7. Deposit into PP v2 ──────────────────────────────────────────
        console.log("[6/9] Depositing into Privacy Pools...");
        const depositValue = `0x${DEPOSIT_AMOUNT.toString(16)}` as Hex;

        const depositResult = await session.poolSession.prepareDeposit({
            tokenId: NATIVE_ASSET,
            value: depositValue,
        });

        if (depositResult.approvalTx) {
            const hash = await walletClient.sendTransaction({
                account: depositorAccount,
                to: depositResult.approvalTx.to as Address,
                data: depositResult.approvalTx.data as Hex,
                value: BigInt(depositResult.approvalTx.value),
                chain: sepolia,
            });
            await publicClient.waitForTransactionReceipt({ hash });
        }

        const depositHash = await walletClient.sendTransaction({
            account: depositorAccount,
            to: depositResult.to as Address,
            data: depositResult.callData as Hex,
            value: BigInt(depositResult.msgValue),
            chain: sepolia,
        });
        console.log(`  Deposit tx: ${depositHash}`);
        const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
        if (depositReceipt.status === "reverted") throw new Error("Deposit reverted");

        // Manually add pending note to NoteManager (prepareDeposit doesn't persist it)
        const block = await publicClient.getBlock({ blockNumber: depositReceipt.blockNumber });
        const blockTs = `0x${block.timestamp.toString(16)}` as Hex;
        await session.poolSession.importAccount({
            notes: [{
                ...depositResult.pendingNote,
                noteSecret: depositResult.pendingNote.noteSecret!,
                status: "PENDING" as any,
                createdAtBlock: blockTs,
                spentAtBlock: null,
                txHash: depositHash,
            }],
            syncCursor: "0x0",
        });

        const depositLabel = depositResult.pendingNote.label as Hash;
        console.log(`  Deposited ${DEPOSIT_AMOUNT} wei — label: ${depositLabel}`);

        // ── 8. Impersonate POSTMAN → update ASP root ────────────────────────
        console.log("[7/9] Updating ASP root (impersonating POSTMAN)...");

        // Compute label hash + merkle root
        const labelHash = session.hashService.hash([depositLabel as Hex]);
        sessionCtx.aspLeaves.push(labelHash as Hash);
        const merkleProof = await session.merkleService.generateMerkleProof(
            sessionCtx.aspLeaves,
            labelHash as Hash,
        );
        sessionCtx.aspRoot = merkleProof.root;

        // Impersonate POSTMAN and send updateASPRoot tx
        await testClient.impersonateAccount({ address: POSTMAN_ADDRESS });
        await testClient.setBalance({ address: POSTMAN_ADDRESS, value: parseEther("1") });

        const aspCalldata = encodeFunctionData({
            abi: ASP_REGISTRY_ABI,
            functionName: "updateASPRoot",
            args: [BigInt(sessionCtx.aspRoot), "0x00" as Hex],
        });

        const aspHash = await walletClient.sendTransaction({
            account: POSTMAN_ADDRESS,
            to: PP_ASP_REGISTRY,
            data: aspCalldata,
            chain: sepolia,
        });
        console.log(`  ASP root tx: ${aspHash}`);
        await publicClient.waitForTransactionReceipt({ hash: aspHash });
        await testClient.stopImpersonatingAccount({ address: POSTMAN_ADDRESS });

        console.log(`  ASP root updated: ${sessionCtx.aspRoot}`);

        // Refresh session with new ASP state
        const savedExport = await session.poolSession.exportAccount();
        const refreshedSession = await createPoolSession(
            depositorAccount.address,
            depositorKeys,
            sessionCtx,
        );
        Object.assign(session, refreshedSession);

        // Patch notes: PENDING → ACTIVE
        await patchNotes(
            savedExport,
            session.hashService,
            session.poolVaultInteractor,
            depositorKeys.privateNullifyingKey,
        );
        await session.poolSession.importAccount(savedExport);

        // ── 9. Prepare internal transfer ────────────────────────────────────
        console.log("[8/9] Preparing internal transfer proof...");

        // UserOp sender — empty account, delegates to PrivacyPoolsAccount via EIP-7702
        const senderPK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex; // Anvil #2
        const senderAccount = privateKeyToAccount(senderPK);
        // Do NOT fund sender — paymaster covers gas

        // Transfer recipient — any address, receives a note inside the pool (not ETH)
        const transferRecipientAddress = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address; // Anvil #3

        const activeNotes = savedExport.notes.filter((n: any) => n.status === "ACTIVE");
        if (activeNotes.length === 0) throw new Error("No ACTIVE notes after deposit activation");
        const inputNote = activeNotes[0]!;

        const feeHex = `0x${FEE_AMOUNT.toString(16)}` as Hex;
        const transferHex = `0x${TRANSFER_AMOUNT.toString(16)}` as Hex;

        console.log(`  Input note: ${inputNote.commitment} (value: ${inputNote.value})`);
        console.log(`  Transfer: ${TRANSFER_AMOUNT} wei to recipient note (stays in pool)`);
        console.log(`  Fee: ${FEE_AMOUNT} wei to paymaster (exits pool)`);
        console.log(`  UserOp sender: ${senderAccount.address} (no funds)`);
        console.log(`  Transfer recipient: ${transferRecipientAddress} (gets note, not ETH)`);

        // Compute recipientNoteAddressHash = Poseidon(recipientAddress, noteSecret)
        const noteSecret = session.cryptoService.generateSecret();
        const recipientNoteAddressHash = session.hashService.hash([
            transferRecipientAddress as Hex,
            noteSecret as Hex,
        ]);

        // SDK computes amountOut = feeAmount (for transfers, only fee exits the pool)
        const transferResult = await session.poolSession.prepareTransfer({
            inputCommitments: [inputNote.commitment as Hex],
            recipientNoteAddressHash: [recipientNoteAddressHash as Hash],
            amount: transferHex,
            tokenId: NATIVE_ASSET,
            relayAddress: paymasterAddress, // SDK bug: feeRecipient not forwarded in transfer path, falls back to relayAddress
            feeAmount: feeHex,
            feeRecipient: paymasterAddress,
            processorAddress: PP_RELAY,
            nativeGas: "0x0" as Hex,
        });

        // Convert PoolVault.transact() calldata → PrivacyPoolRelay.relay() calldata
        const relayCalldata = transactToRelayCalldata(transferResult.executeOptions.callData as Hex);

        // Build execute(feeCalldata, tail=[]) calldata for the UserOp
        const executeCalldata = encodeFunctionData({
            abi: PRIVACY_ACCOUNT_ABI,
            functionName: "execute",
            args: [relayCalldata, []],
        });

        // ── 10. Build and submit UserOp ─────────────────────────────────────
        console.log("[9/9] Submitting UserOp via bundler...");

        // Sender signs EIP-7702 authorization delegating to PrivacyPoolsAccount
        const authorization = await walletClient.signAuthorization({
            account: senderAccount,
            contractAddress: privacyPoolsAccountAddress,
        });

        // Build UserOp skeleton
        const entryPointAbi = [{
            type: "function",
            name: "getNonce",
            inputs: [
                { name: "sender", type: "address" },
                { name: "key", type: "uint192" },
            ],
            outputs: [{ name: "nonce", type: "uint256" }],
            stateMutability: "view",
        }] as const;

        const nonce = await publicClient.readContract({
            address: ERC4337_ENTRYPOINT,
            abi: entryPointAbi,
            functionName: "getNonce",
            args: [senderAccount.address, 0n],
        });

        const userOp = {
            authorization,
            sender: senderAccount.address,
            nonce,
            callData: executeCalldata,
            callGasLimit: CALL_GAS_LIMIT,
            verificationGasLimit: VERIFICATION_GAS_LIMIT,
            preVerificationGas: PRE_VERIFICATION_GAS,
            maxFeePerGas: MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: MAX_PRIORITY_FEE,
            paymaster: paymasterAddress,
            paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS,
            paymasterPostOpGasLimit: PAYMASTER_POSTOP_GAS,
            paymasterData: "0x" as Hex,
            signature: "0x" as Hex,
        };

        const userOpHash = await bundlerClient.sendUserOperation(userOp);
        console.log(`  UserOp hash: ${userOpHash}`);

        console.log("  Waiting for receipt...");
        const receipt = await bundlerClient.waitForUserOperationReceipt(userOpHash);
        console.log(`  UserOp receipt: ${receipt.success ? "SUCCESS" : "FAILED"}`);
        console.log(`  Bundle tx: ${receipt.receipt?.transactionHash ?? "unknown"}`);

        // ── Verify results ──────────────────────────────────────────────────
        const senderBalance = await publicClient.getBalance({ address: senderAccount.address });
        const paymasterBalance = await publicClient.getBalance({ address: paymasterAddress });

        console.log("\n=== Results ===");
        console.log(`  UserOp sender (${senderAccount.address}): ${senderBalance} wei`);
        console.log(`  Paymaster (${paymasterAddress}): ${paymasterBalance} wei`);
        console.log(`  Transfer recipient (${transferRecipientAddress}): shielded note (${TRANSFER_AMOUNT} wei)`);
        console.log("");
        console.log(`  Fund flow: PoolVault → Relay (${FEE_AMOUNT} wei) → Paymaster (fee only — transfer stays in pool)`);
        console.log(`  Gas: Paymaster deposit → EntryPoint → Bundler`);

        if (paymasterBalance >= FEE_AMOUNT) {
            console.log("\n  ✓ Paymaster received fee from internal transfer!");
            console.log("  ✓ Funds transferred inside pool — only fee exited to paymaster");
        } else {
            console.error(`\n  ✗ Paymaster fee too low: ${paymasterBalance} < ${FEE_AMOUNT}`);
            process.exit(1);
        }
    } finally {
        await servers.stop();
    }

    process.exit(0);
}

main().catch((err) => {
    console.error("\nFATAL:", err);
    process.exit(1);
});

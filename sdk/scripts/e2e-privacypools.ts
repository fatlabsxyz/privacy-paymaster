/**
 * E2E test script: Privacy Pools v2 deposit → withdraw via paymaster.
 *
 * Prerequisites:
 *   1. Anvil fork running in a separate terminal:
 *        anvil --fork-url $SEPOLIA_RPC_URL --fork-block-number $BLOCK
 *   2. PP v2 circuit artifacts built:
 *        (cd ../v2-monorepo/packages/circuits && pnpm build)
 *   3. PP v2 SDK linked locally:
 *        bun add @privacy-pools-v2/sdk@file:../../v2-monorepo/packages/sdk
 *
 * Usage:
 *   bun run sdk/scripts/e2e-privacypools.ts
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
import { anvil, sepolia } from "viem/chains";

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
// CONSTANTS — fill these in before running
// ═══════════════════════════════════════════════════════════════════════════════

const ANVIL_URL = "http://127.0.0.1:8545";

// Anvil default account #0
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
// Alto bundler accounts (must be funded)
const ALTO_EXECUTOR_PK = "0x4a3a02862ddcb260ed52d40ef03f8e3d78fa3d174b0ef333afdf1ffb4a648cd5" as Hex;
const ALTO_UTILITY_PK = "0xdd4b2564c83ff7de602c39ffda1146055dc1814b07c083d7971722384f1f01a6" as Hex;

// --- PP v2 contract addresses (Sepolia) ---
const PP_POOL_VAULT = "0x0000000000000000000000000000000000000000" as Address; // TODO: fill in
const PP_ENTRYPOINT = "0x0000000000000000000000000000000000000000" as Address; // TODO: fill in
const PP_KEYSTORE = "0x0000000000000000000000000000000000000000" as Address; // TODO: fill in
const PP_ASP_REGISTRY = "0x0000000000000000000000000000000000000000" as Address; // TODO: fill in
const PP_RELAY = "0x0000000000000000000000000000000000000000" as Address; // TODO: fill in

// Account holding POSTMAN_ROLE on ASPRegistry (can call updateASPRoot)
const POSTMAN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address; // TODO: fill in

// ASP public key for ECDH encryption
const ASP_PUBLIC_KEY = "0x00" as Hex; // TODO: fill in

// ERC-4337 EntryPoint (v0.8)
const ERC4337_ENTRYPOINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108" as Address;

// Native ETH sentinel used by PP v2
const NATIVE_ASSET = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

// Deposit amount
const DEPOSIT_AMOUNT = parseEther("0.01");
// Fee amount the paymaster takes from withdrawal
const FEE_AMOUNT = parseEther("0.001");

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

function findProjectRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (true) {
        try {
            const { existsSync } = require("fs");
            if (existsSync(join(dir, "foundry.toml"))) return dir;
        } catch {
            // fallback
        }
        const parent = dirname(dir);
        if (parent === dir) throw new Error("Could not find foundry.toml");
        dir = parent;
    }
}

function forge(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
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
            } else resolve();
        });
    });
}

/** Deploy paymaster + PrivacyPoolsAccount, return addresses. */
async function deployContracts(forkUrl: string, privateKey: Hex) {
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const deployEnv = "anvil-e2e-pp";
    const deploymentsPath = join(projectRoot, `config/deployments/${deployEnv}.json`);

    await writeFile(deploymentsPath, "{}");

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        DEPLOY_ENV: deployEnv,
        PRIVATE_KEY: privateKey,
    };

    // Deploy paymaster
    await forge(
        ["script", "DeployPaymaster", "--fork-url", forkUrl, "--broadcast"],
        env, projectRoot,
    );

    // Stake paymaster
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
    await forge(
        ["script", "DeployPrivacyPools", "--fork-url", forkUrl, "--broadcast"],
        env, projectRoot,
    );

    const deployments = JSON.parse(await readFile(deploymentsPath, "utf-8"));
    return {
        paymasterAddress: deployments.paymaster.address as Address,
        privacyPoolsAccountAddress: deployments.privacypools.privacyPoolsAccount as Address,
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
    } satisfies IASPDataProvider;
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
        chain: sepolia,
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

    const witnessPreparationService = new WitnessPreparationService({
        hashService,
        merkleService,
    });

    const groth16Prover = new Groth16Prover();
    const circuitArtifacts = new LocalCircuitArtifacts(CIRCUIT_ARTIFACTS_DIR);
    const proofService = new ProofService({ circuitArtifacts, groth16Prover });

    const cryptoService = new CryptoService();
    const noteManager = new NoteManager({});

    const keystoreManager = new KeystoreManager({
        privateNullifyingKey: keys.privateNullifyingKey,
        privateRevocableKey: keys.privateRevocableKey,
        viewingPrivateKey: keys.viewingPrivateKey,
        viewingPublicKey: keys.viewingPublicKey,
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

    const poolSession = PoolSessionFactory.create({
        ownerAddress,
        chainId: sepolia.id,
        poolAddress: PP_POOL_VAULT,
        cryptoService,
        witnessPreparationService,
        proofService,
        entrypointInteractor,
        noteManager,
        keystoreManager,
        keystoreInteractor,
        hashService,
        poolVaultInteractor,
        aspClient,
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

        if (!note.createdAtBlock || BigInt(note.createdAtBlock) === 0n) continue;

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
    console.log("=== Privacy Pools v2 × Paymaster E2E ===\n");

    // ── 1. Clients ──────────────────────────────────────────────────────────
    const deployerAccount = privateKeyToAccount(DEPLOYER_PK);
    const testClient = createTestClient({ chain: anvil, mode: "anvil", transport: http(ANVIL_URL) });
    const publicClient = createPublicClient({ chain: anvil, transport: http(ANVIL_URL) });
    const walletClient = createWalletClient({
        chain: anvil,
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
        console.log(`  PrivacyPoolsAccount: ${privacyPoolsAccountAddress}`);

        // ── 5. Generate depositor keys ──────────────────────────────────────
        console.log("[4/9] Setting up depositor session...");

        // Use Anvil account #1 as depositor
        const depositorPK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
        const depositorAccount = privateKeyToAccount(depositorPK);
        await testClient.setBalance({ address: depositorAccount.address, value: parseEther("10") });

        // Derive PP v2 protocol keys from a deterministic signature
        const cryptoService = new CryptoService();
        const depositorKeys = {
            privateNullifyingKey: `0x${Buffer.from(cryptoService.generateSecret() as string, "hex").toString("hex")}` as Hex,
            privateRevocableKey: `0x${Buffer.from(cryptoService.generateSecret() as string, "hex").toString("hex")}` as Hex,
            viewingPrivateKey: `0x${Buffer.from(cryptoService.generateSecret() as string, "hex").toString("hex")}` as Hex,
            viewingPublicKey: `0x${Buffer.from(cryptoService.generateSecret() as string, "hex").toString("hex")}` as Hex,
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
                    chain: anvil,
                });
                await publicClient.waitForTransactionReceipt({ hash });
            }

            if (viewingKeyCalldata) {
                const hash = await walletClient.sendTransaction({
                    account: depositorAccount,
                    to: viewingKeyCalldata.to as Address,
                    data: viewingKeyCalldata.data as Hex,
                    value: BigInt(viewingKeyCalldata.value),
                    chain: anvil,
                });
                await publicClient.waitForTransactionReceipt({ hash });
            }
            console.log("  Keystore registered");
        } else {
            console.log("  Already registered");
        }

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
                chain: anvil,
            });
            await publicClient.waitForTransactionReceipt({ hash });
        }

        const depositHash = await walletClient.sendTransaction({
            account: depositorAccount,
            to: depositResult.to as Address,
            data: depositResult.callData as Hex,
            value: BigInt(depositResult.msgValue),
            chain: anvil,
        });
        const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
        if (depositReceipt.status === "reverted") throw new Error("Deposit reverted");

        const depositLabel = depositResult.receipt.label as Hash;
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
            chain: anvil,
        });
        await publicClient.waitForTransactionReceipt({ hash: aspHash });
        await testClient.stopImpersonatingAccount({ address: POSTMAN_ADDRESS });

        console.log(`  ASP root updated: ${sessionCtx.aspRoot}`);

        // Refresh session with new ASP state
        const savedExport = session.poolSession.exportAccount();
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
        session.poolSession.importAccount(savedExport);

        // ── 9. Prepare withdrawal ───────────────────────────────────────────
        console.log("[8/9] Preparing withdrawal proof...");

        // Generate recipient wallet (empty — the whole point of paymaster sponsorship)
        const recipientPK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex; // Anvil #2
        const recipientAccount = privateKeyToAccount(recipientPK);
        // Do NOT fund recipient — they have 0 ETH

        const activeNotes = savedExport.notes.filter((n) => n.status === "ACTIVE");
        if (activeNotes.length === 0) throw new Error("No ACTIVE notes after deposit activation");
        const inputNote = activeNotes[0];

        const withdrawAmount = BigInt(inputNote.value);
        const feeHex = `0x${FEE_AMOUNT.toString(16)}` as Hex;
        const withdrawHex = `0x${withdrawAmount.toString(16)}` as Hex;

        console.log(`  Input note: ${inputNote.commitment} (value: ${inputNote.value})`);
        console.log(`  Withdrawing: ${withdrawAmount}, fee: ${FEE_AMOUNT}`);
        console.log(`  Recipient: ${recipientAccount.address} (no funds)`);

        const withdrawResult = await session.poolSession.prepareWithdraw({
            inputCommitments: [inputNote.commitment as Hex],
            amount: withdrawHex,
            tokenId: NATIVE_ASSET,
            recipientAddress: recipientAccount.address,
            relayAddress: recipientAccount.address,
            feeAmount: feeHex,
            feeRecipient: paymasterAddress,
            processorAddress: PP_RELAY,
            nativeGas: "0x0" as Hex,
        });

        // Convert PoolVault.transact() calldata → PrivacyPoolRelay.relay() calldata
        const relayCalldata = transactToRelayCalldata(withdrawResult.callData as Hex);

        // Build execute(feeCalldata, tail=[]) calldata for the UserOp
        const executeCalldata = encodeFunctionData({
            abi: PRIVACY_ACCOUNT_ABI,
            functionName: "execute",
            args: [relayCalldata, []],
        });

        // ── 10. Build and submit UserOp ─────────────────────────────────────
        console.log("[9/9] Submitting UserOp via bundler...");

        // Recipient signs EIP-7702 authorization delegating to PrivacyPoolsAccount
        const authorization = await walletClient.signAuthorization({
            account: recipientAccount,
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
            args: [recipientAccount.address, 0n],
        });

        const userOp = {
            authorization,
            sender: recipientAccount.address,
            nonce,
            callData: executeCalldata,
            callGasLimit: 2_000_000n,
            verificationGasLimit: 1_000_000n,
            preVerificationGas: 200_000n,
            maxFeePerGas: 1_000_000_000n,
            maxPriorityFeePerGas: 10_000_000_000n,
            paymaster: paymasterAddress,
            paymasterVerificationGasLimit: 1_000_000n,
            paymasterPostOpGasLimit: 200_000n,
            paymasterData: "0x" as Hex,
            signature: "0x" as Hex,
        };

        const userOpHash = await bundlerClient.sendUserOperation(userOp);
        console.log(`  UserOp hash: ${userOpHash}`);

        console.log("  Waiting for receipt...");
        const receipt = await bundlerClient.waitForUserOperationReceipt(userOpHash);
        console.log(`  UserOp receipt: ${receipt.success ? "SUCCESS" : "FAILED"}`);

        // ── Verify balances ─────────────────────────────────────────────────
        const recipientBalance = await publicClient.getBalance({ address: recipientAccount.address });
        const paymasterBalance = await publicClient.getBalance({ address: paymasterAddress });

        console.log("\n=== Results ===");
        console.log(`  Recipient balance: ${recipientBalance} wei`);
        console.log(`  Paymaster balance: ${paymasterBalance} wei`);
        console.log(`  Expected recipient: ~${withdrawAmount - FEE_AMOUNT} wei`);
        console.log(`  Expected paymaster fee: ${FEE_AMOUNT} wei`);

        if (recipientBalance > 0n) {
            console.log("\n  ✓ Recipient received funds despite having 0 ETH!");
        } else {
            console.error("\n  ✗ Recipient balance is 0 — something went wrong");
            process.exit(1);
        }
    } finally {
        await servers.stop();
    }
}

main().catch((err) => {
    console.error("\nFATAL:", err);
    process.exit(1);
});

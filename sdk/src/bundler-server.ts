import { Instance } from "prool";
import { createTestClient, http, parseEther } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { anvil } from "viem/chains";
import type { Address, Hex } from "viem";

const DEFAULT_EXECUTOR_PK = "0x4a3a02862ddcb260ed52d40ef03f8e3d78fa3d174b0ef333afdf1ffb4a648cd5" as Hex;
const DEFAULT_UTILITY_PK = "0xdd4b2564c83ff7de602c39ffda1146055dc1814b07c083d7971722384f1f01a6" as Hex;

const DEFAULT_ALTO_PORT = 3000;
const MAX_ALTO_START_ATTEMPTS = 20;

// Multiple test files can start an alto instance concurrently; since prool doesn't
// pick a free port itself, a taken port makes the process exit immediately with a
// generic "exited" error (alto doesn't surface EADDRINUSE distinctly), so on any
// start failure we just retry on the next port rather than trying to classify the error.
async function startAltoWithRetry(
    params: Omit<Instance.alto.Parameters, "port"> & { port?: number },
    maxAttempts = MAX_ALTO_START_ATTEMPTS
): Promise<ReturnType<typeof Instance.alto>> {
    let port = params.port ?? DEFAULT_ALTO_PORT;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const bundlerServer = Instance.alto({ ...params, port });
        try {
            await bundlerServer.start();
            return bundlerServer;
        } catch (error) {
            if (attempt === maxAttempts) throw error;
            port++;
        }
    }

    throw new Error("unreachable");
}

export interface StartServersOptions {
    // Provide execRpcUrl to connect to an existing node, or forkUrl to spin up a local anvil fork.
    execRpcUrl?: string;
    forkUrl?: string;
    forkBlockNumber?: bigint | number;
    entrypoint: Address;
    executorPrivateKey?: Hex;
    utilityPrivateKey?: Hex;
    port?: number;
    // Starting port for the alto bundler; incremented automatically if already taken.
    bundlerPort?: number;
    // Only applies in fork mode — anvil_setBalance is unavailable on external nodes.
    fundedPrivateKeys?: Hex[];
    safeMode?: boolean;
}

type BundlerServerEventEmitter = ReturnType<typeof Instance.alto>['on'];

export interface ServersResult {
    execRpcUrl: string;
    bundlerRpcUrl: string;
    stop: () => Promise<void>;
    bundlerServerEventEmitter: BundlerServerEventEmitter;
}

export async function startServers(options: StartServersOptions): Promise<ServersResult> {
    const {
        forkUrl,
        forkBlockNumber,
        entrypoint,
        executorPrivateKey = DEFAULT_EXECUTOR_PK,
        utilityPrivateKey = DEFAULT_UTILITY_PK,
        fundedPrivateKeys = [],
        safeMode = false,
        port = 8545,
        bundlerPort
    } = options;

    if (!options.execRpcUrl && !forkUrl)
        throw new Error("Either execRpcUrl or forkUrl must be provided");

    let execRpcUrl: string;
    let stopExec: (() => Promise<void>) | undefined;

    if (options.execRpcUrl) {
        execRpcUrl = options.execRpcUrl;
    } else {
        const execServer = Instance.anvil({
            forkUrl: forkUrl!,
            forkBlockNumber,
            chainId: anvil.id,
            port,
        });
        await execServer.start();
        execRpcUrl = `http://localhost:${execServer.port}`;
        stopExec = () => execServer.stop();

        const allPks = [executorPrivateKey, utilityPrivateKey, ...fundedPrivateKeys];
        const testClient = createTestClient({ chain: anvil, mode: "anvil", transport: http(execRpcUrl) });
        for (const pk of allPks) {
            await testClient.setBalance({ address: privateKeyToAddress(pk), value: parseEther("1000") });
        }
    }

    const bundlerServer = await startAltoWithRetry({
        rpcUrl: execRpcUrl,
        entrypoints: [entrypoint],
        executorPrivateKeys: [executorPrivateKey],
        utilityPrivateKey,
        safeMode,
        port: bundlerPort,
    });
    const bundlerRpcUrl = `http://127.0.0.1:${bundlerServer.port}`;
    const bundlerServerEventEmitter = bundlerServer.on.bind(bundlerServer);

    return {
        execRpcUrl,
        bundlerRpcUrl,
        stop: async () => {
            await stopExec?.();
            await bundlerServer.stop();
        },
        bundlerServerEventEmitter
    };
}

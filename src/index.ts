import "module-alias/register";

import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { Contract, SmartWeave, SmartWeaveNodeFactory } from "redstone-smartweave";
import got from "got";
import Arlocal from "arlocal";

import { setupContract, ContractInfos } from "@/setupContract";
import { ARLOCALDB_PATH, ARLOCAL_URL, arweave, ARWEAVE_PORT, CONTRACT_INFOS_PATH } from "@/env";
import { createWallet, pathExists, runEvery } from "@/utils";
import { feedUser } from "@/reproduceCacheBug";

type SmartweaveEnv = {
    smartweave: SmartWeave;
    contract: Contract;
};

async function createSmartweaveEnv(contractId: string, cachePath: string): Promise<SmartweaveEnv> {
    // export const smartweave = SmartWeaveNodeFactory.memCached(arweave, 500);
    const smartweave = SmartWeaveNodeFactory.fileCached(arweave, cachePath, 5);
    const contract = smartweave.contract(contractId);

    const randomJWK = await arweave.wallets.generate();
    contract.connect(randomJWK);

    return { smartweave, contract };
}

async function getBalance(contract: Contract, userAddress: string) {
    // eslint-disable-next-line
    const state = (await contract.readState()).state as any;
    return state.tokens.PTY.balances[userAddress];
}

async function loadContractInfos() {
    if (!(await pathExists(CONTRACT_INFOS_PATH))) {
        throw new Error("Arlocal hasn't been configured yet.");
    }

    return JSON.parse((await readFile(CONTRACT_INFOS_PATH)).toString()) as ContractInfos;
}

async function startArlocal(): Promise<Arlocal> {
    const shouldSetupArlocal = !(await pathExists(ARLOCALDB_PATH));

    console.log("starting arlocal");
    const arlocal = new Arlocal(ARWEAVE_PORT, false, ARLOCALDB_PATH, true);

    await arlocal.start();

    // Simulate the mining of a block every 0.5 seconds
    runEvery(async () => {
        try {
            await got.get(`${ARLOCAL_URL}/mine`);
            // const { height } = (await got.get(`${ARLOCAL_URL}/info`).json()) as any;
            // console.log(`Just mined a block, height: ${height}`);
        } catch (e) {
            console.log("Error: Couldn't mine: ", e);
        }
    }, 0.5);

    if (shouldSetupArlocal) {
        console.log("setting up arlocal...");

        await setupContract();

        console.log("setting up the contract");
        const contractInfos = await setupContract();

        await writeFile(join(ARLOCALDB_PATH, "contractInfos.json"), JSON.stringify(contractInfos));

        console.log("done!");
    } else {
        console.log("arlocal has already been set up!");
    }

    return arlocal;
}

async function runBugReproduction(arlocal?: Arlocal) {
    const originalEnvCachePath = "./original-smartweave-cache";
    const freshEnvCachePath = "./fresh-smartweave-cache";

    await rm(originalEnvCachePath, { recursive: true, force: true });
    await rm(freshEnvCachePath, { recursive: true, force: true });

    const { apiWallet, apiAddress, contractId } = await loadContractInfos();

    const originalEnv = await createSmartweaveEnv(contractId, originalEnvCachePath);

    const [_userWallet, userAddress] = await createWallet();
    await feedUser(originalEnv.contract, apiWallet, apiAddress, userAddress, 100);
    const balanceOriginalEnv = await getBalance(originalEnv.contract, userAddress);

    console.log("The original client reports a balance of:", balanceOriginalEnv);

    const freshEnv = await createSmartweaveEnv(contractId, freshEnvCachePath);

    const balanceNewEnv = await getBalance(freshEnv.contract, userAddress);

    console.log("The freshly created env reports a balance of:", balanceNewEnv);

    const balanceOriginalEnv2 = await getBalance(originalEnv.contract, userAddress);

    console.log("The original client still reports a balance of:", balanceOriginalEnv2);

    await rm(originalEnvCachePath, { recursive: true, force: true });
    await rm(freshEnvCachePath, { recursive: true, force: true });

    if (arlocal) {
        await arlocal.stop();
        process.exit(0);
    }
}

(async () => {
    if (process.argv[2] === "--run-arlocal") {
        await startArlocal();
    } else if (process.argv[2] === "--run-bug") {
        await runBugReproduction();
    } else if (process.argv[2] === "--run-both") {
        const arlocal = await startArlocal();
        await runBugReproduction(arlocal);
    } else {
        console.log("Not enough argument");
    }
})();

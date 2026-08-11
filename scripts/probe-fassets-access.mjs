#!/usr/bin/env node
/**
 * Phase 00 access probe for the FAssets side.
 *
 * The Phase 00 stop boundary is "do not implement protocol logic if a credible Coston2
 * redemption path cannot be obtained". This answers that question with live reads only:
 * is FXRP live, what are the redemption-relevant settings, are there agents available to
 * mint from, and is agent ownership gated by a whitelist we cannot pass.
 *
 * It never sends a transaction and never needs a key.
 */
import { createPublicClient, http, getAddress } from "viem";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readSourceLock } from "./lib/source-lock.mjs";
import { loadAbi } from "./lib/abi.mjs";

const lock = readSourceLock();
const RPC_URL = process.env.COSTON2_RPC_URL ?? lock.networks.coston2.rpc;
const assetManager = getAddress(lock.contracts.find((c) => c.id === "asset-manager-fxrp").address);

const client = createPublicClient({ transport: http(RPC_URL, { timeout: 60_000 }) });
const assetManagerAbi = loadAbi("IAssetManager.sol", "IAssetManager");
const agentOwnerRegistryAbi = loadAbi("IAgentOwnerRegistry.sol", "IAgentOwnerRegistry");

const read = (functionName, args = []) =>
  client.readContract({ address: assetManager, abi: assetManagerAbi, functionName, args });

const settings = await read("getSettings");
const [lotSize, mintingDecimals, controller] = await Promise.all([
  read("lotSize"),
  read("assetMintingDecimals"),
  read("assetManagerController"),
]);

const availableAgents = await read("getAvailableAgentsDetailedList", [0n, 50n]);
const agents = availableAgents[0];

const agentOwnerRegistry = getAddress(settings.agentOwnerRegistry);
const whitelistProbe = await client
  .readContract({
    address: agentOwnerRegistry,
    abi: agentOwnerRegistryAbi,
    functionName: "isWhitelisted",
    args: ["0x0000000000000000000000000000000000000001"],
  })
  .then((value) => ({ callable: true, zeroAddressWhitelisted: value }))
  .catch((error) => ({ callable: false, error: String(error).split("\n")[0] }));

const report = {
  probedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  network: "coston2",
  rpc: RPC_URL,
  assetManager,
  assetManagerController: controller,
  fAsset: settings.fAsset,
  agentOwnerRegistry,
  redemptionRelevantSettings: {
    lotSizeAMG: lotSize.toString(),
    assetMintingDecimals: Number(mintingDecimals),
    assetMintingGranularityUBA: settings.assetMintingGranularityUBA.toString(),
    lotSizeAMGRaw: settings.lotSizeAMG.toString(),
    underlyingBlocksForPayment: Number(settings.underlyingBlocksForPayment),
    underlyingSecondsForPayment: Number(settings.underlyingSecondsForPayment),
    redemptionFeeBIPS: Number(settings.redemptionFeeBIPS),
    confirmationByOthersAfterSeconds: Number(settings.confirmationByOthersAfterSeconds),
    attestationWindowSeconds: Number(settings.attestationWindowSeconds),
    averageBlockTimeMS: Number(settings.averageBlockTimeMS),
    chainId: settings.chainId,
    maxRedeemedTickets: Number(settings.maxRedeemedTickets),
  },
  availableAgents: {
    count: agents.length,
    sample: agents.slice(0, 5).map((a) => ({
      agentVault: a.agentVault,
      ownerManagementAddress: a.ownerManagementAddress,
      freeCollateralLots: a.freeCollateralLots.toString(),
      feeBIPS: Number(a.feeBIPS),
      status: Number(a.status),
    })),
    totalFreeCollateralLots: agents.reduce((sum, a) => sum + a.freeCollateralLots, 0n).toString(),
  },
  agentOwnerWhitelist: whitelistProbe,
};

const serialize = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

mkdirSync(join(REPO_ROOT, "docs", "protocol-seams"), { recursive: true });
writeFileSync(join(REPO_ROOT, "docs", "protocol-seams", "fassets-access-probe.json"), `${serialize(report)}\n`);

console.log(serialize(report));

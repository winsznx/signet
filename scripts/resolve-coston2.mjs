#!/usr/bin/env node
/**
 * Resolves every Coston2 address Signet depends on and proves it by RPC.
 *
 * Nothing here trusts an address copied from a document. Registry-managed contracts are read
 * from the live FlareContractRegistry; FCC contracts come from the pinned scaffold manifest.
 * Every resolved address is then checked for deployed code, a runtime code hash, and for each
 * selector Signet actually calls: presence in the runtime dispatcher, or - for diamonds - a
 * DiamondLoupe facet lookup, plus a behavioral eth_call where the function is a safe view.
 *
 * Writes deployments/coston2.json and the contracts[] section of docs/source-lock.json.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readSourceLock, writeSourceLock } from "./lib/source-lock.mjs";
import { rpc, ethCall, keccak256Hex, hexToBytes, selectorOf, selectorInRuntimeCode, decodeNamesAndAddresses, decodeAddress } from "./lib/evm.mjs";
import { selectorsFor } from "./lib/abi.mjs";

const LOCKED_RPCS = readSourceLock().networks.coston2.rpc;
const RPC_URL = process.env.COSTON2_RPC_URL ?? LOCKED_RPCS[0];
// A single RPC operator can lie about code. Every runtime code hash is re-read from an
// independently operated endpoint and a mismatch halts resolution, per the PRD threat table.
const CROSS_CHECK_RPCS = LOCKED_RPCS.filter((url) => url !== RPC_URL);
const NOW = process.env.SIGNET_VERIFIED_AT ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");

const lock = readSourceLock();
const scaffoldAddresses = JSON.parse(
  readFileSync(join(REPO_ROOT, "upstream", "fce-extension-scaffold", "config", "coston2", "deployed-addresses.json"), "utf8"),
);

const DIAMOND_LOUPE_FACET_ADDRESS = selectorOf("facetAddress(bytes4)");
// keccak256("eip1967.proxy.implementation") - 1
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const TARGETS = [
  {
    id: "flare-contract-registry",
    name: "FlareContractRegistry",
    resolvedFrom: "flare-foundry-periphery-package src/coston2/ContractRegistry.sol FLARE_CONTRACT_REGISTRY_ADDRESS",
    address: lock.networks.coston2.contractRegistry,
    sourceLockRef: "flare-foundry-periphery-package",
    probes: () => selectorsFor("IFlareContractRegistry.sol", "IFlareContractRegistry", ["getContractAddressByName", "getAllContracts"]),
    knownLimitation: "Registry contents can change by governance. Re-resolve before every deployment.",
  },
  {
    id: "asset-manager-fxrp",
    name: "AssetManagerFXRP",
    registryName: "AssetManagerFXRP",
    sourceLockRef: "flare-foundry-periphery-package",
    probes: () => [
      ...selectorsFor("IAssetManager.sol", "IAssetManager", [
        "redemptionRequestInfo",
        "confirmRedemptionPayment",
        "redemptionPaymentDefault",
        "finishRedemptionWithoutPayment",
        "redeem",
        "lotSize",
        "assetMintingDecimals",
        "getAgentInfo",
        "getSettings",
      ]),
      // Destination-tag redemption is a separate protocol adapter per FR-015/FR-033.
      // Its entry points live in IRedeemExtended and must be proven live independently.
      ...selectorsFor("IRedeemExtended.sol", "IRedeemExtended", [
        "redeemAmount",
        "redeemWithTag",
        "confirmXRPRedemptionPayment",
        "xrpRedemptionPaymentDefault",
        "redeemWithTagSupported",
        "redemptionRequestInfoExt",
      ]),
    ],
    knownLimitation: "FAssets on Coston2 is a diamond-style deployment; selector presence is proven through the live dispatcher, not through a source match.",
  },
  {
    id: "asset-manager-controller",
    name: "AssetManagerController",
    registryName: "AssetManagerController",
    sourceLockRef: "flare-foundry-periphery-package",
    probes: () => selectorsFor("IAssetManagerController.sol", "IAssetManagerController", ["getAssetManagers", "assetManagerExists"]),
    knownLimitation: "Used only to enumerate asset managers; never a payment authority.",
  },
  {
    id: "fdc-hub",
    name: "FdcHub",
    registryName: "FdcHub",
    sourceLockRef: "flare-foundry-periphery-package",
    probes: () => selectorsFor("IFdcHub.sol", "IFdcHub", ["requestAttestation", "fdcRequestFeeConfigurations", "requestsOffsetSeconds"]),
    knownLimitation: "Attestation requests are payable; the fee must be read from FdcRequestFeeConfigurations at request time.",
  },
  {
    id: "fdc-verification",
    name: "FdcVerification",
    registryName: "FdcVerification",
    sourceLockRef: "flare-foundry-periphery-package",
    probes: () => [
      ...selectorsFor("IFdcVerification.sol", "IFdcVerification", ["fdcProtocolId", "relay"]),
      ...selectorsFor("IPaymentVerification.sol", "IPaymentVerification", ["verifyPayment"]),
      ...selectorsFor("IReferencedPaymentNonexistenceVerification.sol", "IReferencedPaymentNonexistenceVerification", [
        "verifyReferencedPaymentNonexistence",
      ]),
      // FAssets confirms XRP redemptions through the XRPL-specific attestation type, not the
      // chain-agnostic one: TransactionAttestation.verifyXRPPayment calls these two directly.
      ...selectorsFor("IXRPPaymentVerification.sol", "IXRPPaymentVerification", ["verifyXRPPayment"]),
      ...selectorsFor("IXRPPaymentNonexistenceVerification.sol", "IXRPPaymentNonexistenceVerification", [
        "verifyXRPPaymentNonexistence",
      ]),
    ],
    knownLimitation: "Deployed behind FdcVerificationProxy, so selectors are not expected in the proxy runtime code; presence in the EIP-1967 implementation is the authoritative check.",
  },
  {
    id: "fdc-request-fee-configurations",
    name: "FdcRequestFeeConfigurations",
    registryName: "FdcRequestFeeConfigurations",
    sourceLockRef: "flare-foundry-periphery-package",
    probes: () => selectorsFor("IFdcRequestFeeConfigurations.sol", "IFdcRequestFeeConfigurations", ["getRequestFee"]),
    knownLimitation: "Fee schedule is governance-controlled and must be read per request.",
  },
  {
    id: "relay",
    name: "Relay",
    registryName: "Relay",
    sourceLockRef: "flare-foundry-periphery-package",
    probes: () => selectorsFor("IRelay.sol", "IRelay", ["merkleRoots", "getVotingRoundId"]),
    knownLimitation: "Relay holds the FDC Merkle roots; proof verification is only as fresh as the relayed round.",
  },
  {
    id: "fcc-flare-tee-manager",
    name: "FlareTeeManager",
    scaffoldName: "FlareTeeManager",
    sourceLockRef: "fce-extension-scaffold",
    diamond: true,
    probes: () => [
      ...selectorsFor("ITeeExtensionRegistry.sol", "ITeeExtensionRegistry", [
        "sendInstructions",
        "nextPublicExtensionId",
        "getTeeExtensionInstructionsSender",
      ]),
      ...selectorsFor("ITeeMachineRegistry.sol", "ITeeMachineRegistry", ["getRandomTeeIds"]),
    ],
    knownLimitation: "FCC is beta and the manager is a diamond. Selectors are proven through DiamondLoupe.facetAddress, and the resolved facet must match the pinned scaffold manifest.",
  },
];

async function getCode(address, url = RPC_URL) {
  const code = await rpc(url, "eth_getCode", [address, "latest"]);
  const bytes = hexToBytes(code);
  return { code, runtimeCodeHash: keccak256Hex(bytes), runtimeCodeSize: bytes.length };
}

/**
 * Re-reads runtime code from every other locked endpoint and requires byte-identical results.
 * Returns the endpoints that agreed. Any disagreement is a halt condition, not a warning.
 */
async function crossCheckCode(address, expectedHash) {
  const agreed = [];
  for (const url of CROSS_CHECK_RPCS) {
    try {
      const observed = await getCode(address, url);
      if (observed.runtimeCodeHash !== expectedHash) {
        return { agreed, mismatch: { url, observed: observed.runtimeCodeHash } };
      }
      agreed.push(url);
    } catch (error) {
      return { agreed, unreachable: { url, error: error.message } };
    }
  }
  return { agreed };
}

async function behavioralCall(address, probe) {
  if (probe.inputCount !== 0 || probe.stateMutability !== "view") return null;
  try {
    const result = await ethCall(RPC_URL, address, probe.selector);
    return { ok: true, returnData: result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function diamondFacetFor(address, selector) {
  try {
    const data = `${DIAMOND_LOUPE_FACET_ADDRESS}${selector.slice(2).padEnd(64, "0")}`;
    const result = await ethCall(RPC_URL, address, data);
    const facet = decodeAddress(result);
    return facet && facet !== ZERO_ADDRESS ? facet : null;
  } catch {
    return null;
  }
}

/**
 * EIP-1967 implementation behind a transparent/UUPS proxy. Selector presence must be checked
 * against the implementation runtime code, because the proxy itself only holds a delegate stub.
 */
async function eip1967Implementation(address) {
  const word = await rpc(RPC_URL, "eth_getStorageAt", [address, EIP1967_IMPLEMENTATION_SLOT, "latest"]);
  const implementation = decodeAddress(word);
  return implementation && implementation !== ZERO_ADDRESS ? implementation : null;
}

const chainIdHex = await rpc(RPC_URL, "eth_chainId");
const chainId = Number(BigInt(chainIdHex));
if (chainId !== lock.networks.coston2.chainId) {
  throw new Error(`RPC chainId ${chainId} does not match locked ${lock.networks.coston2.chainId}`);
}
const blockNumber = Number(BigInt(await rpc(RPC_URL, "eth_blockNumber")));

const registryAddress = lock.networks.coston2.contractRegistry;
const registryDump = await ethCall(RPC_URL, registryAddress, selectorOf("getAllContracts()"));
const { names, addresses } = decodeNamesAndAddresses(registryDump);
const registry = new Map(names.map((n, i) => [n, addresses[i]]));

const scaffoldMap = new Map(scaffoldAddresses.map((c) => [c.name, c.address]));
const scaffoldByAddress = new Map(scaffoldAddresses.map((c) => [c.address.toLowerCase(), c.name]));

const resolved = [];
let problems = 0;

for (const target of TARGETS) {
  let address = target.address;
  let resolvedFrom = target.resolvedFrom;

  if (target.registryName) {
    address = registry.get(target.registryName);
    resolvedFrom = `FlareContractRegistry.getAllContracts() name=${target.registryName}`;
    if (!address) {
      console.error(`UNRESOLVED ${target.id}: ${target.registryName} is not in the live registry`);
      problems += 1;
      continue;
    }
  }
  if (target.scaffoldName) {
    address = scaffoldMap.get(target.scaffoldName);
    resolvedFrom = `fce-extension-scaffold@${lock.upstream.find((u) => u.id === "fce-extension-scaffold").commit} config/coston2/deployed-addresses.json name=${target.scaffoldName}`;
    if (!address) {
      console.error(`UNRESOLVED ${target.id}: ${target.scaffoldName} is not in the pinned scaffold manifest`);
      problems += 1;
      continue;
    }
  }

  const { code, runtimeCodeHash, runtimeCodeSize } = await getCode(address);
  if (runtimeCodeSize === 0) {
    console.error(`NO CODE ${target.id} at ${address}`);
    problems += 1;
    continue;
  }

  const crossCheck = await crossCheckCode(address, runtimeCodeHash);
  if (crossCheck.mismatch) {
    console.error(
      `RPC DISAGREEMENT ${target.id} at ${address}: ${RPC_URL} says ${runtimeCodeHash}, ${crossCheck.mismatch.url} says ${crossCheck.mismatch.observed}`,
    );
    problems += 1;
    continue;
  }
  if (crossCheck.unreachable) {
    console.error(`CROSS-CHECK UNREACHABLE ${target.id}: ${crossCheck.unreachable.url} — ${crossCheck.unreachable.error}`);
    problems += 1;
    continue;
  }

  const implementation = await eip1967Implementation(address);
  const implementationCode = implementation ? (await getCode(implementation)).code : null;

  const selectors = [];
  for (const probe of target.probes()) {
    const presentInRuntimeCode = selectorInRuntimeCode(code, probe.selector);
    const presentInImplementationCode = implementationCode ? selectorInRuntimeCode(implementationCode, probe.selector) : false;
    const facet = presentInRuntimeCode || presentInImplementationCode ? null : await diamondFacetFor(address, probe.selector);
    const behavior = await behavioralCall(address, probe);
    const reachable = presentInRuntimeCode || presentInImplementationCode || facet !== null || behavior?.ok === true;
    if (!reachable) {
      console.error(`UNREACHABLE ${target.id} ${probe.signature} ${probe.selector}`);
      problems += 1;
    }
    // A live facet that the pinned scaffold manifest does not name is protocol drift.
    // It is recorded rather than tolerated silently, because the manifest is the only
    // non-registry source of FCC addresses Signet has.
    const facetInScaffoldManifest = facet ? (scaffoldByAddress.get(facet.toLowerCase()) ?? null) : null;

    selectors.push({
      signature: probe.signature,
      selector: probe.selector,
      abiSource: probe.source,
      presentInRuntimeCode,
      presentInImplementationCode,
      diamondFacet: facet,
      facetInScaffoldManifest,
      behavioralCall: behavior,
      reachable,
    });
  }

  resolved.push({
    id: target.id,
    network: "coston2",
    name: target.name,
    address,
    resolvedFrom,
    crossCheckedWith: crossCheck.agreed,
    proxyImplementation: implementation,
    proxyImplementationCodeHash: implementation ? (await getCode(implementation)).runtimeCodeHash : null,
    runtimeCodeHash,
    runtimeCodeSize,
    selectors,
    verifiedAt: NOW,
    verifiedAtBlock: blockNumber,
    sourceLockRef: target.sourceLockRef,
    knownLimitation: target.knownLimitation,
  });
  console.log(`ok ${target.id.padEnd(32)} ${address} code=${runtimeCodeSize}B selectors=${selectors.length}`);
}

lock.contracts = resolved;
lock.verifiedAt = NOW;
writeSourceLock(lock);

mkdirSync(join(REPO_ROOT, "deployments"), { recursive: true });
writeFileSync(
  join(REPO_ROOT, "deployments", "coston2.json"),
  `${JSON.stringify(
    {
      network: "coston2",
      chainId,
      rpc: RPC_URL,
      resolvedAt: NOW,
      resolvedAtBlock: blockNumber,
      contractRegistry: registryAddress,
      crossCheckRpcs: CROSS_CHECK_RPCS,
      registryEntryCount: names.length,
      protocol: Object.fromEntries(resolved.map((c) => [c.id, { name: c.name, address: c.address, runtimeCodeHash: c.runtimeCodeHash }])),
      signet: {},
    },
    null,
    2,
  )}\n`,
);

if (problems > 0) {
  console.error(`\n${problems} resolution problem(s).`);
  process.exit(1);
}
console.log(`\nresolved ${resolved.length} contracts on coston2 at block ${blockNumber}`);

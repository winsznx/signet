#!/usr/bin/env node
/**
 * Deploys the Signet contracts to Coston2.
 *
 * The deployer key never appears in a log line, an error message, an argument this script prints, or
 * the deployment record. It is read from `.runtime/secrets/`, which is deny-read in the sandbox
 * config precisely so that an accident here is a permission error rather than a leak, and it is
 * handed to `cast` as a process argument rather than through a shell.
 *
 * Before spending anything the script proves the key controls the address the repository expects.
 * A funded address and a key that derives a different one is the kind of mismatch that otherwise
 * shows up as a confusing out-of-gas failure halfway through a deployment.
 *
 * Deployment is idempotent by record: if `deployments/coston2.json` already names a Signet registry
 * with code at that address, the script stops rather than deploying a second one. Two registries on
 * one chain is two sources of truth about who may sign.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readSourceLock } from "./lib/source-lock.mjs";

const FOUNDRY = `${process.env.HOME}/.foundry/bin`;
const lock = readSourceLock();
const RPC = process.env.COSTON2_RPC_URL ?? lock.networks.coston2.rpc[0];
const CHAIN_ID = 114n;
const ASSET_MANAGER = lock.contracts.find((c) => c.id === "asset-manager-fxrp").address;

const SECRET_PATH = join(REPO_ROOT, ".runtime", "secrets", "coston2-deployer.json");
const ADDRESS_PATH = join(REPO_ROOT, ".runtime", "coston2-deployer.address");
const RECORD_PATH = join(REPO_ROOT, "deployments", "coston2.json");

function loadDeployerKey() {
  if (!existsSync(SECRET_PATH)) {
    throw new Error(
      `no deployer key at ${SECRET_PATH.replace(REPO_ROOT, ".")}. Generate a testnet-only key there; it is gitignored and deny-read.`,
    );
  }
  // The file shape follows whatever produced it, so several spellings are accepted rather than one
  // being assumed. What is not accepted is guessing: an unrecognised shape fails loudly, because a
  // deployment that proceeds with the wrong key spends real funds before anyone notices.
  const parsed = JSON.parse(readFileSync(SECRET_PATH, "utf8"));
  const holder = Array.isArray(parsed) ? parsed[0] : parsed;
  const key = holder?.private_key ?? holder?.privateKey ?? holder?.key ?? holder?.secret;
  if (typeof key !== "string") {
    throw new Error(
      `${SECRET_PATH.replace(REPO_ROOT, ".")} has no recognised private key field (private_key, privateKey, key, secret)`,
    );
  }
  return key.startsWith("0x") ? key : `0x${key}`;
}

const PRIVATE_KEY = loadDeployerKey();

/** Runs cast. The key is an argument, never interpolated into a shell string, and never echoed. */
function cast(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("cast", [...args, "--rpc-url", RPC], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    // Scrub before rethrowing. cast echoes its arguments on some failures.
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`.split(PRIVATE_KEY).join("<redacted>");
    throw new Error(text);
  }
}

const send = (to, sig, args) =>
  JSON.parse(
    cast(["send", to, sig, ...args.map(String), "--private-key", PRIVATE_KEY, "--json"]),
  );

/** `cast keccak` is a local computation and takes no RPC, so it cannot go through `cast()`. */
function keccakOfCode(address) {
  const code = cast(["code", address]);
  return execFileSync("cast", ["keccak", code], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function deploy(contract, constructorArgs) {
  const out = execFileSync(
    "forge",
    [
      "create",
      contract,
      "--rpc-url",
      RPC,
      "--private-key",
      PRIVATE_KEY,
      "--broadcast",
      ...(constructorArgs.length ? ["--constructor-args", ...constructorArgs.map(String)] : []),
    ],
    { encoding: "utf8", env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` }, maxBuffer: 32 * 1024 * 1024 },
  );
  const address = out.match(/Deployed to: (0x[0-9a-fA-F]{40})/)?.[1];
  const txHash = out.match(/Transaction hash: (0x[0-9a-fA-F]{64})/)?.[1];
  if (!address) throw new Error(`could not read deployed address from forge output:\n${out.split(PRIVATE_KEY).join("<redacted>")}`);
  return { address, txHash };
}

// ---------------------------------------------------------------- preflight

const expectedDeployer = readFileSync(ADDRESS_PATH, "utf8").trim();
const derived = execFileSync("cast", ["wallet", "address", "--private-key", PRIVATE_KEY], {
  encoding: "utf8",
  env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
}).trim();

if (derived.toLowerCase() !== expectedDeployer.toLowerCase()) {
  throw new Error(`the key derives ${derived} but the repository expects ${expectedDeployer}`);
}
console.log(`deployer ${derived}`);

const chainId = cast(["chain-id"]);
if (BigInt(chainId) !== CHAIN_ID) throw new Error(`expected chain ${CHAIN_ID}, got ${chainId}`);

const balance = BigInt(cast(["balance", derived]));
console.log(`balance  ${(Number(balance) / 1e18).toFixed(4)} C2FLR on chain ${chainId}`);
if (balance === 0n) throw new Error("deployer has no C2FLR");

const record = JSON.parse(readFileSync(RECORD_PATH, "utf8"));
if (record.signet?.registry) {
  const existing = cast(["code", record.signet.registry], { allowFailure: true });
  if (existing && existing !== "0x") {
    console.log(`signet already deployed at ${record.signet.registry}; refusing to deploy a second registry`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------- deploy

// The approved code hash is the measurement of the extension binary that will decide. It is passed
// in rather than defaulted, because a deployment that invents its own measurement approves a build
// nobody has.
const CODE_HASH = process.env.SIGNET_EXTENSION_CODE_HASH;
if (!CODE_HASH || !/^0x[0-9a-fA-F]{64}$/.test(CODE_HASH)) {
  throw new Error("set SIGNET_EXTENSION_CODE_HASH to the keccak256 of the built extension binary");
}
const EXTENSION_ID = process.env.SIGNET_EXTENSION_ID ?? "1";
const POLICY_VERSION = process.env.SIGNET_POLICY_VERSION ?? "1";

// The result signer is the key that attests a decision. It must not be governance: a governance
// address that could also sign results could authorize its own decisions, so the registry rejects
// it, and the first run of this script hit exactly that. Pass a distinct address.
const RESULT_SIGNER = process.env.SIGNET_RESULT_SIGNER;
if (!RESULT_SIGNER || !/^0x[0-9a-fA-F]{40}$/.test(RESULT_SIGNER)) {
  throw new Error("set SIGNET_RESULT_SIGNER to the attestation signer address; it may not be governance");
}
if (RESULT_SIGNER.toLowerCase() === derived.toLowerCase()) {
  throw new Error("the result signer may not be the governance address");
}

/**
 * Deployment resumes rather than restarting.
 *
 * A partial deployment is the normal case when a later step reverts, and starting over would leave
 * an orphaned registry on chain holding an approved code hash. Each step below is skipped when the
 * chain already shows it done.
 */
// A resumed run cannot know the hashes of transactions a previous run sent, so it recovers them
// from the chain rather than recording null. Evidence with a null transaction link is not evidence.
async function recoverDeployerTransactions() {
  const url = `https://coston2-explorer.flare.network/api?module=account&action=txlist&address=${derived}&sort=asc`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await response.json();
    return Array.isArray(body.result) ? body.result : [];
  } catch {
    return [];
  }
}

const resumeRegistry = process.env.SIGNET_REGISTRY;
const registry = resumeRegistry
  ? { address: resumeRegistry, txHash: record.signet?.transactions?.registry ?? null }
  : (console.log("deploying SignetRegistry…"), deploy("contracts/src/SignetRegistry.sol:SignetRegistry", [derived, CHAIN_ID]));
console.log(`registry ${registry.address}`);

const pinnedSender = cast(["call", registry.address, "instructionSender()(address)"]);
const senderIsPinned = pinnedSender && !/^0x0+$/.test(pinnedSender);
const sender = senderIsPinned
  ? { address: pinnedSender, txHash: record.signet?.transactions?.instructionSender ?? null }
  : (console.log("deploying SignetInstructionSender…"),
    deploy("contracts/src/SignetInstructionSender.sol:SignetInstructionSender", [registry.address, ASSET_MANAGER]));
console.log(`sender   ${sender.address}${senderIsPinned ? " (already pinned)" : ""}`);

let pinTx = null;
if (!senderIsPinned) {
  console.log("pinning the instruction sender (one-shot, never changed)…");
  pinTx = send(registry.address, "setInstructionSender(address)", [sender.address]);
}

let codeHashTx = null;
if (cast(["call", registry.address, "approvedCodeHash(bytes32)(bool)", CODE_HASH]) !== "true") {
  console.log("approving the extension code hash…");
  codeHashTx = send(registry.address, "approveCodeHash(bytes32,uint256,uint32,bool)", [
    CODE_HASH,
    EXTENSION_ID,
    POLICY_VERSION,
    "true",
  ]);
} else {
  console.log("code hash already approved");
}

let signerTx = null;
if (cast(["call", registry.address, "approvedSigner(address)(bool)", RESULT_SIGNER]) !== "true") {
  console.log("approving the result signer…");
  signerTx = send(registry.address, "approveSigner(address,bool)", [RESULT_SIGNER, "true"]);
} else {
  console.log("result signer already approved");
}

// ---------------------------------------------------------------- record

const history = await recoverDeployerTransactions();
const bySelector = (selector) =>
  history.find((t) => t.input?.startsWith(selector) && t.isError === "0")?.hash ?? null;
const byCreate = (index) => history.filter((t) => !t.to)[index]?.hash ?? null;

const deployedBlock = Number(BigInt((pinTx ?? signerTx ?? codeHashTx)?.blockNumber ?? cast(["block-number"])));
record.signet = {
  deployedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  deployedAtBlock: deployedBlock,
  governance: derived,
  registry: registry.address,
  instructionSender: sender.address,
  assetManager: ASSET_MANAGER,
  approvedCodeHash: CODE_HASH,
  extensionId: EXTENSION_ID,
  policyVersion: POLICY_VERSION,
  approvedResultSigner: RESULT_SIGNER,
  transactions: {
    registry: registry.txHash ?? record.signet?.transactions?.registry ?? byCreate(0),
    instructionSender: sender.txHash ?? record.signet?.transactions?.instructionSender ?? byCreate(1),
    setInstructionSender:
      pinTx?.transactionHash ?? record.signet?.transactions?.setInstructionSender ?? bySelector("0x1a43c404"),
    approveCodeHash: codeHashTx?.transactionHash ?? record.signet?.transactions?.approveCodeHash ?? bySelector("0x13a9b8a3"),
    approveSigner: signerTx?.transactionHash ?? record.signet?.transactions?.approveSigner ?? bySelector("0x198e206d"),
  },
  runtimeCodeHash: {
    registry: keccakOfCode(registry.address),
    instructionSender: keccakOfCode(sender.address),
  },
  explorer: {
    registry: `https://coston2.testnet.flarescan.com/address/${registry.address}`,
    instructionSender: `https://coston2.testnet.flarescan.com/address/${sender.address}`,
  },
};
writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);
console.log(`\nrecorded in deployments/coston2.json`);

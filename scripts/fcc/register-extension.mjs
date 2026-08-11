#!/usr/bin/env node
/**
 * Registers Signet's extension on the live Coston2 FlareTeeManager.
 *
 * This is step 4 of the pinned scaffold's deployment recipe, and it is the part of FCC that needs
 * only C2FLR. Steps 6 and 8 need a GCP Confidential Space VM, because FTDC rejects simulated
 * attestation, and this script does not pretend otherwise: it registers the extension and binds the
 * instruction sender, and stops there.
 *
 * What that buys is a real extension id on the real registry, and an on-chain instruction sender
 * whose only payment-bearing entry point takes a Signet decision input and no payment fields.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readSourceLock } from "../lib/source-lock.mjs";

const FOUNDRY = `${process.env.HOME}/.foundry/bin`;
const lock = readSourceLock();
const RPC = process.env.COSTON2_RPC_URL ?? lock.networks.coston2.rpc[0];
const TEE_MANAGER = lock.contracts.find((c) => c.id === "fcc-flare-tee-manager").address;
const RECORD = join(REPO_ROOT, "deployments", "coston2.json");

const SECRET = join(REPO_ROOT, ".runtime", "secrets", "coston2-deployer.json");
function loadKey() {
  if (!existsSync(SECRET)) throw new Error("no deployer key");
  const parsed = JSON.parse(readFileSync(SECRET, "utf8"));
  const holder = Array.isArray(parsed) ? parsed[0] : parsed;
  const key = holder?.private_key ?? holder?.privateKey;
  return key.startsWith("0x") ? key : `0x${key}`;
}
const KEY = loadKey();

const env = { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` };
function cast(args) {
  try {
    return execFileSync("cast", [...args, "--rpc-url", RPC], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (error) {
    throw new Error(`${error.stdout ?? ""}${error.stderr ?? ""}`.split(KEY).join("<redacted>"));
  }
}
const send = (to, sig, args, value) =>
  JSON.parse(cast(["send", to, sig, ...args.map(String), ...(value ? ["--value", value] : []), "--private-key", KEY, "--json"]));

const record = JSON.parse(readFileSync(RECORD, "utf8"));
if (record.fcc?.extensionId) {
  console.log(`already registered: extension ${record.fcc.extensionId}`);
  process.exit(0);
}

console.log(`FlareTeeManager ${TEE_MANAGER}`);
console.log(`nextPublicExtensionId before: ${cast(["call", TEE_MANAGER, "nextPublicExtensionId()(uint256)"]).split(" ")[0]}`);

// The instruction sender. Both registries are the same diamond on Coston2.
const out = execFileSync(
  "forge",
  ["create", "contracts/src/fcc/SignetFccInstructionSender.sol:SignetFccInstructionSender",
   "--rpc-url", RPC, "--private-key", KEY, "--broadcast",
   "--constructor-args", TEE_MANAGER, TEE_MANAGER],
  { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
);
const sender = out.match(/Deployed to: (0x[0-9a-fA-F]{40})/)?.[1];
if (!sender) throw new Error(`could not read deployed address:\n${out.split(KEY).join("<redacted>")}`);
console.log(`instruction sender ${sender}`);

// register(stateVerifier, instructionsSender). Signet registers no state verifier: its extension
// exposes only counters through /state, and a verifier contract for values no decision reads would
// be a contract to maintain for nothing.
const registerTx = send(TEE_MANAGER, "register(address,address)", ["0x0000000000000000000000000000000000000000", sender]);
if (registerTx.status !== "0x1") throw new Error("register reverted");
console.log(`registered in ${registerTx.transactionHash}`);

const bindTx = send(sender, "setExtensionId()", []);
if (bindTx.status !== "0x1") throw new Error("setExtensionId reverted");
const extensionId = cast(["call", sender, "extensionId()(uint256)"]).split(" ")[0];
console.log(`extension id ${extensionId}`);

record.fcc = {
  registeredAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  flareTeeManager: TEE_MANAGER,
  instructionSender: sender,
  extensionId,
  stateVerifier: "0x0000000000000000000000000000000000000000",
  opType: "SIGNET_REDEMPTION",
  commands: ["AUTHORIZE_REDEMPTION", "HEALTH_CHECK"],
  transactions: { deploy: out.match(/Transaction hash: (0x[0-9a-f]{64})/)?.[1] ?? null, register: registerTx.transactionHash, setExtensionId: bindTx.transactionHash },
  teeMachineRegistered: false,
  teeMachineNote:
    "No TEE machine is registered. Registration requires a GCP Confidential Space VM: FTDC rejects simulated attestation, so a machine running with MODE=1 cannot be promoted to production. The extension is registered and the instruction sender is bound; the machine half is not.",
  explorer: { instructionSender: `https://coston2.testnet.flarescan.com/address/${sender}` },
};
writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
console.log("recorded in deployments/coston2.json");

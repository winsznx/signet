#!/usr/bin/env node
/**
 * Takes an XRPL payment all the way through FDC: request, voting round, Merkle proof, and on-chain
 * verification.
 *
 * Phase 05 proved the verifier would answer. That is a read-only query and it is not the same claim
 * as "Flare's consensus attested to this payment". This script makes the difference concrete: it
 * pays the request fee to FdcHub, waits for the round to finalize, fetches the proof from a DA Layer
 * operator, and then asks FdcVerification on chain whether that proof is real.
 *
 * The last step is the one that matters. A proof fetched from an API is a claim by that API. A proof
 * that `verifyXRPPayment` accepts has been checked against the Merkle root Flare's validators
 * signed, which is a claim by the network.
 *
 * Every address is resolved from ContractRegistry at runtime rather than hardcoded, and the round id
 * is derived from the request transaction's own block timestamp using FlareSystemsManager's
 * published constants, not assumed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readSourceLock } from "../lib/source-lock.mjs";
import { requestBodyFor, verifierCall, VERIFIER_API_KEY } from "./verifier.mjs";

const FOUNDRY = `${process.env.HOME}/.foundry/bin`;
const lock = readSourceLock();
const RPC = process.env.COSTON2_RPC_URL ?? lock.networks.coston2.rpc[0];
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const DA_LAYER = "https://ctn2-data-availability.flare.network";

const SECRET_PATH = join(REPO_ROOT, ".runtime", "secrets", "coston2-deployer.json");

function loadKey() {
  if (!existsSync(SECRET_PATH)) throw new Error(`no deployer key at ${SECRET_PATH.replace(REPO_ROOT, ".")}`);
  const parsed = JSON.parse(readFileSync(SECRET_PATH, "utf8"));
  const holder = Array.isArray(parsed) ? parsed[0] : parsed;
  const key = holder?.private_key ?? holder?.privateKey;
  if (typeof key !== "string") throw new Error("no private key field in the deployer secret");
  return key.startsWith("0x") ? key : `0x${key}`;
}
const PRIVATE_KEY = loadKey();

function cast(args) {
  try {
    return execFileSync("cast", [...args, "--rpc-url", RPC], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`.split(PRIVATE_KEY).join("<redacted>");
    throw new Error(text);
  }
}

const resolve = (name) => cast(["call", CONTRACT_REGISTRY, "getContractAddressByName(string)(address)", name]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const txHash = process.argv[2];
if (!txHash) {
  console.error("usage: prove-on-chain.mjs <xrpl transaction hash>");
  process.exit(1);
}

const proofOwner = execFileSync("cast", ["wallet", "address", "--private-key", PRIVATE_KEY], {
  encoding: "utf8",
  env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
}).trim();

const fdcHub = resolve("FdcHub");
const feeConfig = resolve("FdcRequestFeeConfigurations");
const systemsManager = resolve("FlareSystemsManager");
const relay = resolve("Relay");
const fdcVerification = resolve("FdcVerification");
console.log(`FdcHub ${fdcHub}\nFdcVerification ${fdcVerification}\nproof owner ${proofOwner}`);

// ---------------------------------------------------------------- encode the request

const body = requestBodyFor(txHash, proofOwner);
const prepared = await verifierCall("prepareRequest", body);
if (prepared.status !== "VALID" || !prepared.abiEncodedRequest) {
  throw new Error(`verifier would not encode a request: ${prepared.status}`);
}
const abiEncodedRequest = prepared.abiEncodedRequest;
console.log(`request  ${abiEncodedRequest.slice(0, 26)}… (${(abiEncodedRequest.length - 2) / 2} bytes)`);

// ---------------------------------------------------------------- pay the fee and submit

const fee = cast(["call", feeConfig, "getRequestFee(bytes)(uint256)", abiEncodedRequest]).split(" ")[0];
console.log(`fee      ${fee} wei`);

const receipt = JSON.parse(
  cast([
    "send",
    fdcHub,
    "requestAttestation(bytes)",
    abiEncodedRequest,
    "--value",
    fee,
    "--private-key",
    PRIVATE_KEY,
    "--json",
  ]),
);
if (receipt.status !== "0x1") throw new Error("requestAttestation reverted");
console.log(`submitted ${receipt.transactionHash} in block ${BigInt(receipt.blockNumber)}`);

// ---------------------------------------------------------------- derive the voting round

// From the request transaction's own block, not from wall-clock time: the round a request lands in
// is a property of the block that carried it, and a script that guessed from `Date.now()` would be
// right only until it was not.
const blockTimestamp = BigInt(
  cast(["block", String(BigInt(receipt.blockNumber)), "--field", "timestamp"]),
);
const firstVotingRoundStartTs = BigInt(cast(["call", systemsManager, "firstVotingRoundStartTs()(uint64)"]).split(" ")[0]);
const votingEpochDurationSeconds = BigInt(
  cast(["call", systemsManager, "votingEpochDurationSeconds()(uint64)"]).split(" ")[0],
);
const roundId = (blockTimestamp - firstVotingRoundStartTs) / votingEpochDurationSeconds;
console.log(`round    ${roundId} (epoch ${votingEpochDurationSeconds}s from ${firstVotingRoundStartTs})`);
console.log(`         https://coston2-systems-explorer.flare.network/voting-round/${roundId}?tab=fdc`);

// ---------------------------------------------------------------- wait for finalization

const protocolId = cast(["call", fdcVerification, "fdcProtocolId()(uint8)"]).split(" ")[0];
process.stdout.write(`waiting for round ${roundId} to finalize under protocol ${protocolId}`);
const deadline = Date.now() + 15 * 60 * 1000;
let finalized = false;
while (Date.now() < deadline) {
  finalized = cast(["call", relay, "isFinalized(uint256,uint256)(bool)", protocolId, String(roundId)]) === "true";
  if (finalized) break;
  process.stdout.write(".");
  await sleep(10_000);
}
if (!finalized) throw new Error(`round ${roundId} did not finalize within 15 minutes`);
console.log("\nfinalized");

// ---------------------------------------------------------------- fetch the proof

async function fetchProof() {
  const response = await fetch(`${DA_LAYER}/api/v1/fdc/proof-by-request-round`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": VERIFIER_API_KEY },
    body: JSON.stringify({ votingRoundId: Number(roundId), requestBytes: abiEncodedRequest }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return null;
  const parsed = await response.json();
  return parsed?.response ? parsed : null;
}

process.stdout.write("waiting for the DA layer to publish the proof");
let proof = null;
const proofDeadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < proofDeadline) {
  proof = await fetchProof();
  if (proof) break;
  process.stdout.write(".");
  await sleep(10_000);
}
if (!proof) throw new Error("the DA layer did not publish a proof for this request");
console.log(`\nproof has ${proof.proof.length} Merkle nodes`);

// ---------------------------------------------------------------- verify on chain

const r = proof.response;
const rb = r.responseBody;

/**
 * The proof, rendered as a cast tuple in the field order `IXRPPayment` declares.
 *
 * `verifyXRPPayment` is the right entrypoint, not `verifyPayment`: our attestation type is
 * XRPPayment, whose response carries a memo and a destination tag where the generic Payment type
 * carries a standard reference and a one-to-one flag. Both selectors exist on the implementation,
 * and passing the wrong shape to the wrong one decodes to garbage rather than failing cleanly.
 *
 * FdcVerification is an EIP-1967 proxy, so the selectors live on the implementation behind it.
 */
const XRP_PAYMENT_PROOF =
  "verifyXRPPayment((bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,address),(uint64,uint64,string,bytes32,bytes32,bytes32,int256,int256,int256,int256,bool,bytes,bool,uint256,uint8))))(bool)";

const tuple = [
  `([${proof.proof.join(",")}]`,
  `,(${r.attestationType},${r.sourceId},${r.votingRound},${r.lowestUsedTimestamp}`,
  `,(${r.requestBody.transactionId},${r.requestBody.proofOwner})`,
  `,(${rb.blockNumber},${rb.blockTimestamp},"${rb.sourceAddress}",${rb.sourceAddressHash}`,
  `,${rb.receivingAddressHash},${rb.intendedReceivingAddressHash}`,
  `,${rb.spentAmount},${rb.intendedSpentAmount},${rb.receivedAmount},${rb.intendedReceivedAmount}`,
  `,${rb.hasMemoData},${rb.firstMemoData},${rb.hasDestinationTag},${rb.destinationTag},${rb.status})))`,
].join("");

const verified = cast(["call", fdcVerification, XRP_PAYMENT_PROOF, tuple]);

console.log(`\nFdcVerification.verifyXRPPayment -> ${verified}`);
if (verified !== "true") throw new Error("Flare did not accept this proof on chain");

// ---------------------------------------------------------------- record

mkdirSync(join(REPO_ROOT, "evidence", "receipts"), { recursive: true });
const out = join(REPO_ROOT, "evidence", "receipts", `fdc-proof-${txHash.toUpperCase()}.json`);
writeFileSync(
  out,
  `${JSON.stringify(
    {
      seam: "fdc-on-chain",
      network: "coston2",
      attestedPayment: txHash,
      proofOwner,
      requestTransaction: receipt.transactionHash,
      requestBlock: Number(BigInt(receipt.blockNumber)),
      requestFeeWei: fee,
      votingRoundId: Number(roundId),
      fdcProtocolId: Number(protocolId),
      merkleNodeCount: proof.proof.length,
      verifiedOnChain: verified === "true",
      fdcVerification,
      fdcHub,
      response: r,
      explorer: {
        request: `https://coston2.testnet.flarescan.com/tx/${receipt.transactionHash}`,
        votingRound: `https://coston2-systems-explorer.flare.network/voting-round/${roundId}?tab=fdc`,
      },
    },
    null,
    2,
  )}\n`,
);
console.log(`recorded ${out.replace(REPO_ROOT, ".")}`);

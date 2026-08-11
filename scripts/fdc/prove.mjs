/**
 * One FDC round trip: request, voting round, Merkle proof, on-chain verification.
 *
 * Shared because two callers need it for two different attestation types. Minting consumes
 * `Payment`, which `executeMinting` takes as `IPayment.Proof`; Signet's own evidence uses
 * `XRPPayment`, whose response carries a memo and a destination tag where the generic type carries
 * a standard reference and a one-to-one flag. Both selectors exist on the FdcVerification
 * implementation, and passing one shape to the other decodes to a different struct rather than
 * failing, so the type is chosen explicitly by the caller and never inferred.
 *
 * The on-chain verification is the point. A proof fetched from a DA Layer API is a claim by that
 * API. A proof `verifyPayment` accepts has been checked against the Merkle root Flare's validators
 * signed.
 */
import { execFileSync } from "node:child_process";
import { readSourceLock } from "../lib/source-lock.mjs";

const FOUNDRY = `${process.env.HOME}/.foundry/bin`;
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const DA_LAYER = "https://ctn2-data-availability.flare.network";
const VERIFIER_HOST = "https://fdc-verifiers-testnet.flare.network";
/** Documented public key for the testnet verifiers, from Flare's own FDC walkthrough. */
const API_KEY = "00000000-0000-0000-0000-000000000000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAYMENT_PROOF_TYPE =
  "(bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,uint256,uint256),(uint64,uint64,bytes32,bytes32,bytes32,bytes32,int256,int256,int256,int256,bytes32,bool,uint8)))";
const XRP_PAYMENT_PROOF_TYPE =
  "(bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,address),(uint64,uint64,string,bytes32,bytes32,bytes32,int256,int256,int256,int256,bool,bytes,bool,uint256,uint8)))";

async function verifierCall(verifierPath, path, body) {
  const response = await fetch(`${VERIFIER_HOST}/${verifierPath}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`${verifierPath}/${path}: HTTP ${response.status}`);
  return response.json();
}

/** Renders a DA Layer response as a cast tuple in the field order the interface declares. */
function renderProof(attestationTypeName, proof) {
  const r = proof.response;
  const rb = r.responseBody;
  const merkle = `[${proof.proof.join(",")}]`;

  if (attestationTypeName === "XRPPayment") {
    return (
      `(${merkle},(${r.attestationType},${r.sourceId},${r.votingRound},${r.lowestUsedTimestamp}` +
      `,(${r.requestBody.transactionId},${r.requestBody.proofOwner})` +
      `,(${rb.blockNumber},${rb.blockTimestamp},"${rb.sourceAddress}",${rb.sourceAddressHash}` +
      `,${rb.receivingAddressHash},${rb.intendedReceivingAddressHash}` +
      `,${rb.spentAmount},${rb.intendedSpentAmount},${rb.receivedAmount},${rb.intendedReceivedAmount}` +
      `,${rb.hasMemoData},${rb.firstMemoData},${rb.hasDestinationTag},${rb.destinationTag},${rb.status})))`
    );
  }
  return (
    `(${merkle},(${r.attestationType},${r.sourceId},${r.votingRound},${r.lowestUsedTimestamp}` +
    `,(${r.requestBody.transactionId},${r.requestBody.inUtxo},${r.requestBody.utxo})` +
    `,(${rb.blockNumber},${rb.blockTimestamp},${rb.sourceAddressHash},${rb.sourceAddressesRoot}` +
    `,${rb.receivingAddressHash},${rb.intendedReceivingAddressHash}` +
    `,${rb.spentAmount},${rb.intendedSpentAmount},${rb.receivedAmount},${rb.intendedReceivedAmount}` +
    `,${rb.standardPaymentReference},${rb.oneToOne},${rb.status})))`
  );
}

export async function proveOnChain({
  txHash,
  attestationTypeName = "XRPPayment",
  verifierPath = "verifier/xrp/XRPPayment",
  proofOwner,
  privateKey,
  rpc = readSourceLock().networks.coston2.rpc[0],
  requestBodyExtra = {},
}) {
  const cast = (args) => {
    try {
      return execFileSync("cast", [...args, "--rpc-url", rpc], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
        maxBuffer: 64 * 1024 * 1024,
      }).trim();
    } catch (error) {
      const text = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`.split(privateKey).join("<redacted>");
      throw new Error(text);
    }
  };
  const resolve = (name) => cast(["call", CONTRACT_REGISTRY, "getContractAddressByName(string)(address)", name]);

  const attestationType = `0x${Buffer.from(attestationTypeName, "utf8").toString("hex").padEnd(64, "0")}`;
  const sourceId = `0x${Buffer.from("testXRP", "utf8").toString("hex").padEnd(64, "0")}`;
  const transactionId = `0x${txHash.toLowerCase().replace(/^0x/, "")}`;

  const requestBody =
    attestationTypeName === "XRPPayment"
      ? { transactionId, proofOwner }
      : { transactionId, inUtxo: "0", utxo: "0", ...requestBodyExtra };

  /**
   * The verifier runs its own XRPL indexer, which trails the ledger.
   *
   * A payment that validated seconds ago genuinely does not exist as far as the verifier is
   * concerned, and it answers "TRANSACTION DOES NOT EXIST". That is indexer lag, not a missing
   * payment, and treating it as a failure would make the run flaky in a way that hides real
   * failures. So it is waited out, with a bound: if the payment is still unknown after ten minutes,
   * something is actually wrong.
   */
  let prepared = null;
  const encodeDeadline = Date.now() + 10 * 60 * 1000;
  process.stdout.write("  waiting for the verifier's indexer");
  while (Date.now() < encodeDeadline) {
    prepared = await verifierCall(verifierPath, "prepareRequest", { attestationType, sourceId, requestBody });
    if (prepared.status === "VALID" && prepared.abiEncodedRequest) break;
    if (!/DOES NOT EXIST|NOT CONFIRMED|INDETERMINATE/i.test(prepared.status ?? "")) {
      throw new Error(`verifier would not encode a ${attestationTypeName} request: ${prepared.status}`);
    }
    process.stdout.write(".");
    await sleep(15_000);
  }
  if (prepared?.status !== "VALID" || !prepared.abiEncodedRequest) {
    throw new Error(`verifier never saw the payment: ${prepared?.status}`);
  }
  process.stdout.write(" seen\n");
  const abiEncodedRequest = prepared.abiEncodedRequest;

  const fdcHub = resolve("FdcHub");
  const feeConfig = resolve("FdcRequestFeeConfigurations");
  const systemsManager = resolve("FlareSystemsManager");
  const relay = resolve("Relay");
  const fdcVerification = resolve("FdcVerification");

  const fee = cast(["call", feeConfig, "getRequestFee(bytes)(uint256)", abiEncodedRequest]).split(" ")[0];
  const receipt = JSON.parse(
    cast([
      "send",
      fdcHub,
      "requestAttestation(bytes)",
      abiEncodedRequest,
      "--value",
      fee,
      "--private-key",
      privateKey,
      "--json",
    ]),
  );
  if (receipt.status !== "0x1") throw new Error("requestAttestation reverted");

  // The round is a property of the block that carried the request, not of wall-clock time.
  const blockTimestamp = BigInt(cast(["block", String(BigInt(receipt.blockNumber)), "--field", "timestamp"]));
  const firstVotingRoundStartTs = BigInt(cast(["call", systemsManager, "firstVotingRoundStartTs()(uint64)"]).split(" ")[0]);
  const votingEpochDurationSeconds = BigInt(
    cast(["call", systemsManager, "votingEpochDurationSeconds()(uint64)"]).split(" ")[0],
  );
  const roundId = (blockTimestamp - firstVotingRoundStartTs) / votingEpochDurationSeconds;

  const protocolId = cast(["call", fdcVerification, "fdcProtocolId()(uint8)"]).split(" ")[0];
  process.stdout.write(`  round ${roundId}, waiting for finalization`);
  const deadline = Date.now() + 15 * 60 * 1000;
  let finalized = false;
  while (Date.now() < deadline) {
    finalized = cast(["call", relay, "isFinalized(uint256,uint256)(bool)", protocolId, String(roundId)]) === "true";
    if (finalized) break;
    process.stdout.write(".");
    await sleep(10_000);
  }
  if (!finalized) throw new Error(`round ${roundId} did not finalize within 15 minutes`);

  process.stdout.write(" finalized, fetching proof");
  let proof = null;
  const proofDeadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < proofDeadline) {
    const response = await fetch(`${DA_LAYER}/api/v1/fdc/proof-by-request-round`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ votingRoundId: Number(roundId), requestBytes: abiEncodedRequest }),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) {
      const parsed = await response.json();
      if (parsed?.response) {
        proof = parsed;
        break;
      }
    }
    process.stdout.write(".");
    await sleep(10_000);
  }
  if (!proof) throw new Error("the DA layer did not publish a proof for this request");

  const tuple = renderProof(attestationTypeName, proof);
  const verifyFn =
    attestationTypeName === "XRPPayment"
      ? `verifyXRPPayment(${XRP_PAYMENT_PROOF_TYPE})(bool)`
      : `verifyPayment(${PAYMENT_PROOF_TYPE})(bool)`;
  const verified = cast(["call", fdcVerification, verifyFn, tuple]);
  process.stdout.write(` verified=${verified}\n`);
  if (verified !== "true") throw new Error("Flare did not accept this proof on chain");

  return {
    attestationTypeName,
    attestedPayment: txHash,
    proofOwner,
    requestTransaction: receipt.transactionHash,
    requestBlock: Number(BigInt(receipt.blockNumber)),
    requestFeeWei: fee,
    votingRoundId: Number(roundId),
    fdcProtocolId: Number(protocolId),
    merkleNodeCount: proof.proof.length,
    verifiedOnChain: true,
    fdcVerification,
    fdcHub,
    tuple,
    response: proof.response,
  };
}

#!/usr/bin/env node
/**
 * The Signet lifecycle against a real Coston2 obligation.
 *
 * Phase 09 ran this on a fork. Everything here is the deployed chain: the registry and instruction
 * sender at their real addresses, an obligation FAssets created for a real agent that anyone can
 * read, an action opened on chain, a payment on XRPL Testnet, and an FDC proof Flare's validators
 * signed and its own verifier accepted.
 *
 * One thing is deliberately not done, and it is the boundary rather than an oversight. FAssets
 * completes a redemption only when the payment came from the agent's own underlying address, and
 * that address belongs to a whitelisted agent. Signet is bound to our XRPL account instead, so the
 * payment carries the right destination, amount and reference but the wrong source. The run stops
 * before `confirmRedemptionPayment` rather than pretending otherwise.
 *
 * The adversarial cases at the end are run against the deployed contracts, not simulated.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Wallet, decode as decodeXrpl } from "xrpl";
import { REPO_ROOT, readSourceLock } from "../lib/source-lock.mjs";
import { accountInfo, currentFeeDrops, validatedLedger, XRPL_NETWORK_ID } from "../xrpl/client.mjs";
import { persistBeforeSubmit, reconcile, submitPersisted } from "../xrpl/submit.mjs";
import { observeUnderlying } from "../xrpl/observe.mjs";
import { proveOnChain } from "../fdc/prove.mjs";

const FOUNDRY = `${process.env.HOME}/.foundry/bin`;
const lock = readSourceLock();
const RPC = process.env.COSTON2_RPC_URL ?? lock.networks.coston2.rpc[0];
const ASSET_MANAGER = lock.contracts.find((c) => c.id === "asset-manager-fxrp").address;
const deployment = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "coston2.json"), "utf8")).signet;
const mintState = JSON.parse(readFileSync(join(REPO_ROOT, ".runtime", "fassets-mint.json"), "utf8"));
const STATE_PATH = join(REPO_ROOT, ".runtime", "target-chain.json");

const steps = [];
let failures = 0;
function check(name, ok, note = "") {
  steps.push({ name, ok: Boolean(ok), note });
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${note ? `  ${note}` : ""}`);
}
function step(name, note = "") {
  steps.push({ name, ok: true, note });
  console.log(`ok   ${name}${note ? `  ${note}` : ""}`);
}

const SECRET_PATH = join(REPO_ROOT, ".runtime", "secrets", "coston2-deployer.json");
function loadKey(path, field = "private_key") {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const holder = Array.isArray(parsed) ? parsed[0] : parsed;
  const key = holder?.[field] ?? holder?.privateKey;
  if (typeof key !== "string") throw new Error(`no key field in ${path.replace(REPO_ROOT, ".")}`);
  return key.startsWith("0x") ? key : `0x${key}`;
}
const PRIVATE_KEY = loadKey(SECRET_PATH);

function cast(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("cast", [...args, "--rpc-url", RPC], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`.split(PRIVATE_KEY).join("<redacted>");
    if (allowFailure) return { error: text };
    throw new Error(text);
  }
}
const send = (to, sig, args) =>
  JSON.parse(cast(["send", to, sig, ...args.map(String), "--private-key", PRIVATE_KEY, "--json"]));

/** Runs a call expected to revert and returns the custom error name. */
function expectRevert(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    const text = String(error.message ?? error);
    return text.match(/custom error '?([A-Za-z0-9_]+)/)?.[1] ?? text.split("\n")[0];
  }
}

const toJson = (v) =>
  typeof v === "bigint"
    ? v.toString(10)
    : Array.isArray(v)
      ? v.map(toJson)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, toJson(v[k])]))
        : v === undefined
          ? null
          : v;
const canonical = (v) => JSON.stringify(toJson(v), null, 2);

function runDecider(command, args, input) {
  try {
    return { code: 0, decision: JSON.parse(execFileSync(command, args, { input, encoding: "utf8" })) };
  } catch (error) {
    if (error.status === 2) return { code: 2, decision: JSON.parse(error.stdout) };
    throw new Error(`${command}: ${error.stderr || error.message}`);
  }
}
const EXT = join(REPO_ROOT, ".runtime", "lifecycle", "signet-extension");
function decideBoth(label, input) {
  const json = canonical(input);
  const go = runDecider(EXT, [], json);
  const ref = runDecider("node", ["--experimental-strip-types", join(REPO_ROOT, "reference", "src", "cli-decide.ts")], json);
  const agree =
    go.decision.kind === ref.decision.kind &&
    go.decision.obligationHash === ref.decision.obligationHash &&
    (go.decision.authorizationCommitment ?? "") === (ref.decision.authorizationCommitment ?? "") &&
    (go.decision.reason ?? "") === (ref.decision.reason ?? "");
  check(`${label}: go and reference agree`, agree, `${go.decision.kind}${go.decision.reason ? ` ${go.decision.reason}` : ""}`);
  return go.decision;
}

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};
const save = () => writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

const red = mintState.redemption;
const source = JSON.parse(readFileSync(join(REPO_ROOT, ".runtime", "xrpl", "agent-source.public.json"), "utf8"));

console.log(`registry ${deployment.registry}`);
console.log(`sender   ${deployment.instructionSender}`);
console.log(`request  ${red.requestId} on Coston2\n`);

// ---------------------------------------------------------------- the obligation, read from chain

const info = cast(["call", ASSET_MANAGER, "redemptionRequestInfoExt(uint256)", red.requestId]);
check("the obligation is readable on the public chain", info && info !== "0x", `request ${red.requestId}`);

/**
 * The status is read live, not taken from the event that created the obligation.
 *
 * A cached ACTIVE is a claim about the past. FAssets is the only authority on whether an obligation
 * is still open, and reading it here rather than trusting a snapshot is the smallest version of the
 * principle the whole system is built on.
 */
const STATUSES = ["ACTIVE", "DEFAULTED_UNCONFIRMED", "SUCCESSFUL", "DEFAULTED_FAILED", "BLOCKED", "REJECTED"];
function liveStatus() {
  const words = [];
  for (let i = 2; i < info.length; i += 64) words.push(info.slice(i, i + 64));
  const start = Number(BigInt(`0x${words[0]}`)) / 32;
  return STATUSES[Number(BigInt(`0x${words[start + 1]}`))] ?? "UNKNOWN";
}
const status = liveStatus();
step("fassets status read live at decision time", status);

// ---------------------------------------------------------------- bind the agent

const bindingId = cast([
  "call",
  deployment.registry,
  "bindingIdFor(address,address)(bytes32)",
  ASSET_MANAGER,
  red.agentVault,
]);
const existingBinding = cast(["call", deployment.registry, "binding(bytes32)((address,address,uint256,address,uint32,uint256,bytes32,uint32,uint8,string))", bindingId]);
if (!state.bound) {
  const tuple = `(${ASSET_MANAGER},${red.agentVault},114,${deployment.instructionSender},${XRPL_NETWORK_ID},${deployment.extensionId},${deployment.approvedCodeHash},${deployment.policyVersion},0,"${source.classicAddress}")`;
  const receipt = send(
    deployment.registry,
    "bindAgent((address,address,uint256,address,uint32,uint256,bytes32,uint32,uint8,string))",
    [tuple],
  );
  if (receipt.status !== "0x1") throw new Error("bindAgent reverted");
  state.bound = { transactionHash: receipt.transactionHash, bindingId };
  save();
}
step("the agent is bound in the deployed registry", state.bound.transactionHash);

// ---------------------------------------------------------------- open the action on chain

if (!state.action) {
  const receipt = send(deployment.instructionSender, "requestRedemptionSignature(uint256,address,uint32)", [
    red.requestId,
    red.agentVault,
    "0",
  ]);
  if (receipt.status !== "0x1") throw new Error("requestRedemptionSignature reverted");
  state.action = { transactionHash: receipt.transactionHash, block: Number(BigInt(receipt.blockNumber)) };
  save();
}
const obligationHashOnChain = cast([
  "call",
  deployment.instructionSender,
  "obligationHashFor(address,uint256,uint32)(bytes32)",
  red.agentVault,
  red.requestId,
  "0",
]);
step("an action is open on the deployed instruction sender", state.action.transactionHash);

// ---------------------------------------------------------------- decide

const [acct, ledger, fees] = await Promise.all([
  accountInfo(source.classicAddress),
  validatedLedger(),
  currentFeeDrops(),
]);
const feeDrops = fees.openLedgerFeeDrops > fees.baseFeeDrops ? fees.openLedgerFeeDrops : fees.baseFeeDrops;

// ---------------------------------------------------------------- observe the underlying chain

/**
 * The check incident 44928272 was missing, now where it belongs.
 *
 * The first version of this guard lived in this script and scanned the destination account itself.
 * That was the right check in the wrong place: a decision that depends on an external observation
 * has to bind that observation, or nobody can tell afterwards whether it was made. V2 moved the
 * check into the decision and the observation into the commitment, and this script's job is now
 * only to be the sensor.
 */
const observation = await observeUnderlying({
  destination: red.paymentAddress,
  reference: red.paymentReference,
  currentValidatedLedger: ledger.index,
});
check(
  "the underlying observation completed across independent endpoints",
  observation.available && observation.agreed,
  `${observation.sourceCount} sources at ledger ${observation.observedAtLedger}, ${observation.payments.length} matching payment(s)`,
);

const baseInput = {
  domain: {
    schemaVersion: 2,
    flareChainId: 114n,
    instructionSender: deployment.instructionSender,
    assetManager: ASSET_MANAGER,
    xrplNetworkId: XRPL_NETWORK_ID,
  },
  binding: {
    agentVault: red.agentVault,
    assetManager: ASSET_MANAGER,
    flareChainId: 114n,
    instructionSender: deployment.instructionSender,
    xrplNetworkId: XRPL_NETWORK_ID,
    xrplSourceAddress: source.classicAddress,
    signingMode: "REGULAR_KEY",
    signerCount: 0,
    keyState: "ACTIVE",
    status: "ACTIVE",
    extensionId: BigInt(deployment.extensionId),
    approvedCodeHash: deployment.approvedCodeHash,
    policyVersion: Number(deployment.policyVersion),
  },
  redemption: {
    requestId: BigInt(red.requestId),
    requestGeneration: 0,
    status,
    agentVault: red.agentVault,
    paymentAddress: red.paymentAddress,
    paymentReference: red.paymentReference,
    valueUBA: BigInt(red.valueUBA),
    feeUBA: BigInt(red.feeUBA),
    firstUnderlyingBlock: BigInt(red.firstUnderlyingBlock),
    lastUnderlyingBlock: BigInt(red.lastUnderlyingBlock),
    lastUnderlyingTimestamp: BigInt(red.lastUnderlyingTimestamp),
    requiresDestinationTag: false,
    destinationTag: 0n,
    assetMintingDecimals: 6,
  },
  xrpl: {
    sequenceMode: "SEQUENCE",
    sequenceOrTicket: acct.account_data.Sequence,
    currentValidatedLedger: ledger.index,
    currentLedgerCloseTime: BigInt(Math.floor(Date.now() / 1000)),
    lastLedgerSequence: ledger.index + 40,
    feeDrops,
    maxFeeDrops: 50_000n,
    baseFeeDrops: fees.baseFeeDrops,
  },
  policy: {
    policyVersion: Number(deployment.policyVersion),
    extensionId: BigInt(deployment.extensionId),
    extensionCodeHash: deployment.approvedCodeHash,
    revokedCodeHashes: [],
    paused: false,
    safetyMarginLedgers: 50,
    safetyMarginSeconds: 300n,
    ledgerCloseIntervalSeconds: 4n,
    minimumUnderlyingSources: 2,
    maxObservationAgeLedgers: 20,
  },
  prior: [],
  underlying: {
    available: observation.available,
    agreed: observation.agreed,
    sourceCount: observation.sourceCount,
    observedAtLedger: observation.observedAtLedger,
    observedAtTime: BigInt(observation.observedAtTime),
    payments: observation.payments.map((p) => ({
      transactionHash: p.transactionHash,
      destinationAddress: p.destinationAddress,
      amountDrops: BigInt(p.amountDrops),
      paymentReference: p.paymentReference,
      validated: p.validated,
    })),
  },
};

// Every obligation field must be the one FAssets emitted on the real chain.
for (const field of ["paymentAddress", "paymentReference", "valueUBA", "feeUBA", "firstUnderlyingBlock", "lastUnderlyingBlock", "lastUnderlyingTimestamp"]) {
  check(`obligation field ${field} is the one coston2 emitted`, String(baseInput.redemption[field]) === String(red[field]), String(red[field]));
}

const decision = decideBoth("target-chain lifecycle", baseInput);
// A refusal is the right answer once FAssets no longer reports the obligation as open, so what is
// asserted is agreement with the chain rather than authorization unconditionally.
check(
  "the decision matches what fassets currently reports",
  status === "ACTIVE" ? decision.kind === "authorize" : decision.kind === "refuse",
  `${status} -> ${decision.kind}${decision.reason ? ` ${decision.reason}` : ""}`,
);
check(
  "obligation hash agrees between the deployed contract and both deciders",
  decision.obligationHash === obligationHashOnChain,
  obligationHashOnChain,
);

if (decision.kind !== "authorize") {
  // A refusal here is a result, not a crash. Re-running after the payment window closes, or after
  // the obligation settles, is expected and the run should say which rather than fall over.
  console.log(`\nthe extension refused: ${decision.reason}`);
  console.log(`fassets reports this obligation as ${status}`);
  console.log(`\n${steps.filter((s) => s.ok).length}/${steps.length} checks pass up to the refusal`);
  process.exit(decision.reason === "S004_INACTIVE_REDEMPTION" || decision.reason === "S007_EXPIRED_WINDOW" ? 0 : 1);
}

const payment = decision.payment;
check("destination came from fassets", payment.Destination === red.paymentAddress, payment.Destination);
check("amount is value minus fee", BigInt(payment.Amount) === BigInt(red.valueUBA) - BigInt(red.feeUBA), `${payment.Amount} drops`);
check(
  "memo carries the fassets payment reference",
  `0x${payment.Memos[0].Memo.MemoData.toLowerCase()}` === red.paymentReference.toLowerCase(),
  payment.Memos[0].Memo.MemoData,
);

// ---------------------------------------------------------------- sign, persist, pay

if (!state.payment) {
  const regularKey = JSON.parse(readFileSync(join(REPO_ROOT, ".runtime", "secrets", "xrpl-signet-regular-key.json"), "utf8"));
  const wallet = Wallet.fromSeed(regularKey.seed, { algorithm: "ed25519" });
  const signed = wallet.sign({ ...payment });
  const roundTrip = decodeXrpl(signed.tx_blob);
  const fieldsMatch = ["TransactionType", "Account", "Destination", "Amount", "Fee", "Flags", "Sequence", "LastLedgerSequence"].every(
    (f) => String(roundTrip[f]) === String(payment[f]),
  );
  check("the signed blob decodes to exactly the authorized payment", fieldsMatch, signed.hash);

  persistBeforeSubmit({
    purpose: "TargetChainRedemptionPayment",
    network: "xrpl-testnet",
    requestId: red.requestId,
    authorizationCommitment: decision.authorizationCommitment,
    obligationHash: decision.obligationHash,
    txTemplate: payment,
    txHash: signed.hash,
    txBlob: signed.tx_blob,
    signedBy: "regular-key",
    signerPublicKey: regularKey.publicKey,
    sequence: payment.Sequence,
    lastLedgerSequence: payment.LastLedgerSequence,
    feeDrops: String(payment.Fee),
    builtAt: new Date().toISOString(),
  });
  /**
   * The decision is checkpointed with the payment, not recomputed on resume.
   *
   * A resumed run that rebuilt the decision would pick up a fresh account sequence and ledger
   * height and record a template that was never signed, while still naming the transaction hash of
   * the one that was. The independent verifier caught exactly that here: the receipt's commitment
   * did not match the payment on the ledger. A receipt must describe the transaction it names.
   */
  state.payment = { txHash: signed.hash, decision, template: { ...payment } };
  save();
  check("signed transaction persisted before first submission", true, signed.hash);

  const provisional = await submitPersisted(signed.hash);
  step("provisional response received", `${provisional.engineResult} (not a result)`);
  const final = await reconcile(signed.hash);
  check("payment reached validated success on xrpl testnet", final.state === "VALIDATED_SUCCESS", `ledger ${final.validatedLedger}`);
  state.payment.validatedLedger = final.validatedLedger;
  state.payment.engineResult = provisional.engineResult;
  save();

  const replay = await submitPersisted(signed.hash);
  check("resubmitting the identical blob cannot pay twice", replay.engineResult !== "tesSUCCESS", replay.engineResult);
  state.payment.replayEngineResult = replay.engineResult;
  save();
}

// A resumed run answers from the checkpoint, so everything recorded below describes the payment that
// is actually on the ledger.
const signedDecision = state.payment.decision ?? decision;
const signedTemplate = state.payment.template ?? payment;

// ---------------------------------------------------------------- prove it through FDC

if (!state.proof) {
  console.log("proving the redemption payment through FDC…");
  state.proof = await proveOnChain({
    txHash: state.payment.txHash,
    attestationTypeName: "XRPPayment",
    verifierPath: "verifier/xrp/XRPPayment",
    proofOwner: deployment.governance,
    privateKey: PRIVATE_KEY,
    rpc: RPC,
  });
  save();
}
check("flare's own verifier accepted the proof on chain", state.proof.verifiedOnChain === true, `round ${state.proof.votingRoundId}`);

// ---------------------------------------------------------------- adversarial, on the deployed contracts

const replayError = expectRevert(() =>
  send(deployment.instructionSender, "requestRedemptionSignature(uint256,address,uint32)", [red.requestId, red.agentVault, "0"]),
);
check("replaying the action on the deployed registry reverts", replayError !== null, replayError ?? "no revert");

const unboundError = expectRevert(() =>
  send(deployment.instructionSender, "requestRedemptionSignature(uint256,address,uint32)", [
    red.requestId,
    "0x000000000000000000000000000000000000dEaD",
    "0",
  ]),
);
check("an unbound agent cannot open an action", unboundError !== null, unboundError ?? "no revert");

const wrongAgentError = expectRevert(() =>
  send(deployment.instructionSender, "requestRedemptionSignature(uint256,address,uint32)", [
    red.requestId,
    mintState.reservation.agentVault,
    "0",
  ]),
);
check("an obligation cannot be claimed for another agent", wrongAgentError !== null, wrongAgentError ?? "no revert");

const movedDestination = decideBoth("attack destination moved", {
  ...baseInput,
  redemption: { ...baseInput.redemption, paymentAddress: "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72" },
});
check(
  "moving the destination changes the commitment while the obligation identity holds",
  movedDestination.obligationHash === decision.obligationHash &&
    movedDestination.authorizationCommitment !== decision.authorizationCommitment,
  "detectable by recomputation, not refused",
);

const raisedAmount = decideBoth("attack amount raised", {
  ...baseInput,
  redemption: { ...baseInput.redemption, valueUBA: BigInt(red.valueUBA) + 1n },
});
check(
  "raising the amount changes the commitment",
  raisedAmount.authorizationCommitment !== decision.authorizationCommitment,
  "commitment moved",
);

// ---------------------------------------------------------------- receipt

mkdirSync(join(REPO_ROOT, "evidence", "receipts"), { recursive: true });
const receiptPath = join(REPO_ROOT, "evidence", "receipts", `target-chain-${state.payment.txHash}.json`);
writeFileSync(
  receiptPath,
  `${JSON.stringify(
    {
      seam: "target-chain-lifecycle",
      schemaVersion: 2,
      network: "xrpl-testnet",
      flareChain: "coston2",
      requestId: red.requestId,
      agentVault: red.agentVault,
      authorizationCommitment: signedDecision.authorizationCommitment,
      obligationHash: signedDecision.obligationHash,
      obligationHashOnChain,
      extensionCodeHash: deployment.approvedCodeHash,
      txHash: state.payment.txHash,
      validatedLedger: state.payment.validatedLedger,
      engineResult: state.payment.engineResult,
      replayEngineResult: state.payment.replayEngineResult,
      // The payment satisfies destination, amount and reference but comes from Signet's bound
      // account rather than the agent's underlying address, so FAssets cannot complete on it. That
      // is the whitelist boundary, and the receipt says so rather than letting a verifier infer it.
      settles: false,
      settlesNote:
        "FAssets completes a redemption only for a payment from the agent's own underlying address. Signet is bound to our XRPL account because the agent whitelist is a governance gate we cannot pass, so this payment is correct in destination, amount and reference but not in source.",
      fdc: {
        votingRoundId: state.proof.votingRoundId,
        requestTransaction: state.proof.requestTransaction,
        verifiedOnChain: state.proof.verifiedOnChain,
        fdcVerification: state.proof.fdcVerification,
      },
      signet: {
        registry: deployment.registry,
        instructionSender: deployment.instructionSender,
        bindTransaction: state.bound.transactionHash,
        actionTransaction: state.action.transactionHash,
      },
      decisionContext: {
        flareChainId: "114",
        assetManager: ASSET_MANAGER,
        instructionSender: deployment.instructionSender,
        agentVault: red.agentVault,
        requestGeneration: 0,
        xrplNetworkId: XRPL_NETWORK_ID,
        policyVersion: Number(deployment.policyVersion),
        extensionId: String(deployment.extensionId),
        extensionCodeHash: deployment.approvedCodeHash,
        firstUnderlyingBlock: red.firstUnderlyingBlock,
        lastUnderlyingBlock: red.lastUnderlyingBlock,
        lastUnderlyingTimestamp: red.lastUnderlyingTimestamp,
        maxFeeDrops: "50000",
        underlying: {
          available: observation.available,
          agreed: observation.agreed,
          sourceCount: observation.sourceCount,
          observedAtLedger: observation.observedAtLedger,
          observedAtTime: String(observation.observedAtTime),
          payments: observation.payments.map((p) => ({
            transactionHash: p.transactionHash,
            amountDrops: String(p.amountDrops),
          })),
        },
      },
      template: signedTemplate,
      signedBy: "regular-key",
      checksPassed: `${steps.filter((s) => s.ok).length}/${steps.length}`,
      explorer: {
        payment: `https://testnet.xrpl.org/transactions/${state.payment.txHash}`,
        redemption: `https://coston2.testnet.flarescan.com/tx/${red.transactionHash}`,
        action: `https://coston2.testnet.flarescan.com/tx/${state.action.transactionHash}`,
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`\n${steps.filter((s) => s.ok).length}/${steps.length} target-chain checks pass`);
console.log(`receipt ${receiptPath.replace(REPO_ROOT, ".")}`);
if (failures > 0) process.exit(1);

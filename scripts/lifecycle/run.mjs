#!/usr/bin/env node
/**
 * The composed Signet lifecycle, end to end, in one command.
 *
 * What is real here and what is not is worth stating plainly, because a lifecycle demo that blurs
 * the two is worse than no demo:
 *
 *   real     the FAssets code that produces the obligation (deployed Coston2 bytecode, on a fork)
 *   real     the Signet contracts, deployed and exercised through their actual entry points
 *   real     the XRPL Testnet payment: signed, submitted, validated, and reconciled against
 *            independent endpoints
 *   real     the FDC attestation request, cross-checked against a verifier
 *   local    the chain the Flare half runs on: a fork, so no C2FLR is needed and the run is
 *            repeatable
 *   local    the extension's execution environment: a process, not Confidential Space. Nothing here
 *            is hardware-attested and nothing claims to be.
 *
 * The valid lifecycle is one path. The attack lifecycles are the rest, and they are the part that
 * carries the weight: a system that pays correctly when everything is correct has proven very
 * little.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";
import { REPO_ROOT } from "../lib/source-lock.mjs";
import * as chain from "./chain.mjs";
import { Wallet, decode as decodeXrpl } from "xrpl";
import { accountInfo, currentFeeDrops, validatedLedger, XRPL_NETWORK_ID } from "../xrpl/client.mjs";
import { persistBeforeSubmit, reconcile, submitPersisted } from "../xrpl/submit.mjs";
import { observeUnderlying } from "../xrpl/observe.mjs";
import { preparePaymentAttestation } from "../fdc/verifier.mjs";

const PORT = Number(process.env.SIGNET_FORK_PORT ?? 8546);
const RPC = `http://127.0.0.1:${PORT}`;
const UPSTREAM_RPC = process.env.COSTON2_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const OUT = join(REPO_ROOT, ".runtime", "lifecycle");
const FXRP_HOLDER = "0xff02f742106b8a25c26e65c1f0d66bec3c90d429";
const GO = join(REPO_ROOT, ".runtime", "toolchain", "go", "bin", "go");

const steps = [];
let failures = 0;

function step(name, detail) {
  steps.push({ name, ...detail });
  const mark = detail.ok ? "ok  " : "FAIL";
  if (!detail.ok) failures += 1;
  console.log(`${mark} ${name}${detail.note ? `  ${detail.note}` : ""}`);
}

function check(name, condition, note) {
  step(name, { ok: Boolean(condition), note });
}

/** bigint becomes a decimal string, matching the fixture serialisation both decoders expect. */
function toJson(value) {
  if (typeof value === "bigint") return value.toString(10);
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = toJson(value[key]);
    return out;
  }
  return value;
}

const canonical = (v) => JSON.stringify(toJson(v), null, 2);

/**
 * Runs a decider over exactly these bytes. A refusal exits 2 and is a result, not an error, so the
 * exit code is read rather than treated as a failure.
 */
function runDecider(command, args, inputJson) {
  try {
    const stdout = execFileSync(command, args, { input: inputJson, encoding: "utf8" });
    return { code: 0, decision: JSON.parse(stdout) };
  } catch (error) {
    if (error.status === 2) return { code: 2, decision: JSON.parse(error.stdout) };
    throw new Error(`${command} failed: ${error.stderr || error.message}`);
  }
}

const FCC_EXT = join(OUT, "signet-fcc-extension");
const FCC_PORT = Number(process.env.SIGNET_FCC_PORT ?? 8097);

const fccDeployment = (() => {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "coston2.json"), "utf8")).fcc ?? null;
  } catch {
    return null;
  }
})();

const toBytes32Utf8 = (text) => `0x${Buffer.from(text, "utf8").toString("hex").padEnd(64, "0")}`;

/**
 * Starts the Signet FCC extension, sends one AUTHORIZE_REDEMPTION action, and returns the decision
 * the extension derived along with the ActionResult a tee-node would sign.
 *
 * The extension runs as a local process here. That is the honest limit: FTDC rejects simulated
 * attestation, so no machine running this way can be registered on Coston2, and nothing below
 * claims otherwise. What it does establish is that the payment was derived by the FCC extension
 * through the FCC action contract, rather than by a CLI that FCC has never seen.
 */
async function decideThroughFcc(input) {
  const server = spawn(FCC_EXT, ["-port", String(FCC_PORT)], { stdio: "ignore" });
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const probe = await fetch(`http://127.0.0.1:${FCC_PORT}/state`, { signal: AbortSignal.timeout(2_000) });
        if (probe.ok) break;
      } catch {
        // still starting
      }
    }

    const fixed = {
      opType: toBytes32Utf8("SIGNET_REDEMPTION"),
      opCommand: toBytes32Utf8("AUTHORIZE_REDEMPTION"),
      originalMessage: `0x${Buffer.from(canonical(input), "utf8").toString("hex")}`,
    };
    const response = await fetch(`http://127.0.0.1:${FCC_PORT}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: {
          id: `0x${"11".repeat(32)}`,
          submissionTag: `0x${"00".repeat(32)}`,
          message: `0x${Buffer.from(JSON.stringify(fixed), "utf8").toString("hex")}`,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const actionResult = await response.json();
    const decoded = JSON.parse(Buffer.from(actionResult.data.replace(/^0x/, ""), "hex").toString("utf8"));
    return { ...decoded, actionResult };
  } finally {
    server.kill();
  }
}

const goDecide = (json) => runDecider(join(OUT, "signet-extension"), [], json);
const refDecide = (json) =>
  runDecider("node", ["--experimental-strip-types", join(REPO_ROOT, "reference", "src", "cli-decide.ts")], json);

/**
 * Puts both implementations in front of the same bytes and requires them to agree. This is the
 * check that makes the reference model a specification rather than a second opinion.
 */
function decideBoth(label, input) {
  const json = canonical(input);
  const go = goDecide(json);
  const ref = refDecide(json);
  const agree =
    go.decision.kind === ref.decision.kind &&
    go.decision.obligationHash === ref.decision.obligationHash &&
    (go.decision.authorizationCommitment ?? "") === (ref.decision.authorizationCommitment ?? "") &&
    (go.decision.reason ?? "") === (ref.decision.reason ?? "");
  check(
    `${label}: go and reference agree`,
    agree,
    agree
      ? `${go.decision.kind}${go.decision.reason ? ` ${go.decision.reason}` : ""}`
      : `go=${JSON.stringify(go.decision)} ref=${JSON.stringify(ref.decision)}`,
  );
  return go.decision;
}

/**
 * Every run gets its own fork at a pinned block.
 *
 * Reusing a long-lived fork looks cheaper and is wrong: each run mints a redemption against a real
 * agent's finite backing, so the second run sees state the first one created and the third may find
 * the agent has no capacity left. A run whose result depends on how many times it has been run
 * before is not evidence of anything.
 */
async function startFork(forkBlock) {
  const anvil = spawn(
    `${process.env.HOME}/.foundry/bin/anvil`,
    ["--fork-url", UPSTREAM_RPC, "--fork-block-number", String(forkBlock), "--port", String(PORT), "--silent"],
    { stdio: "ignore", detached: false },
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      // Waiting on block-number is not enough: anvil answers it before forked state is reachable,
      // and the first contract read then fails in a way that looks like a protocol problem. Wait on
      // an actual forked state read instead.
      chain.cast(["call", chain.ASSET_MANAGER, "fAsset()(address)"], { rpc: RPC });
      return anvil;
    } catch {
      // still starting
    }
  }
  anvil.kill();
  throw new Error(`fork did not come up on ${RPC}`);
}

const FORK_BLOCK = chain.resolveForkBlock(UPSTREAM_RPC);
const fork = await startFork(FORK_BLOCK);
process.on("exit", () => fork.kill());
step("fork started", { ok: true, note: `coston2 @ ${FORK_BLOCK}` });

// ---------------------------------------------------------------- build the extension

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const command of ["signet-extension", "signet-fcc-extension"]) {
  execFileSync(GO, ["build", "-trimpath", "-o", join(OUT, command), `./cmd/${command}`], {
    cwd: join(REPO_ROOT, "extension"),
    env: { ...process.env, GOWORK: "off" },
    stdio: "inherit",
  });
}

// The code hash the registry approves is the measurement of the binary that will actually decide.
// A hash of the source, or a constant, would let a different binary run under an approved identity.
const extensionBinary = readFileSync(join(OUT, "signet-extension"));
const CODE_HASH = `0x${Buffer.from(keccak_256(extensionBinary)).toString("hex")}`;
const EXTENSION_ID = 1n;
const POLICY_VERSION = 1;
step("extension built and measured", { ok: true, note: `${CODE_HASH.slice(0, 18)}… over ${extensionBinary.length} bytes` });

// ---------------------------------------------------------------- flare half, on a fork

const accounts = chain.anvilAccounts(RPC);
const governance = accounts[0];
const caller = accounts[2];
const resultSigner = accounts[1];

const deployment = chain.deploySignet({
  rpc: RPC,
  governance,
  codeHash: CODE_HASH,
  extensionId: EXTENSION_ID,
  policyVersion: POLICY_VERSION,
  signer: resultSigner,
});
step("signet deployed on the fork", { ok: true, note: `registry ${deployment.registry}` });

const secrets = JSON.parse(readFileSync(join(REPO_ROOT, ".runtime", "xrpl", "agent-source.public.json"), "utf8"));
const destinationAccount = JSON.parse(
  readFileSync(join(REPO_ROOT, ".runtime", "xrpl", "redeemer-destination.public.json"), "utf8"),
);

const obligation = chain.createRedemption({
  rpc: RPC,
  holder: FXRP_HOLDER,
  destination: destinationAccount.classicAddress,
  lots: 1,
});
check(
  "fassets produced an obligation for our destination",
  obligation.paymentAddress === destinationAccount.classicAddress,
  `request ${obligation.requestId}, agent ${obligation.agentVault}`,
);

const bindingId = chain.bindAgent({
  rpc: RPC,
  governance,
  registry: deployment.registry,
  sender: deployment.sender,
  agentVault: obligation.agentVault,
  xrplSourceAddress: secrets.classicAddress,
  codeHash: CODE_HASH,
  extensionId: EXTENSION_ID,
  policyVersion: POLICY_VERSION,
  xrplNetworkId: XRPL_NETWORK_ID,
});

const action = chain.requestSignature({
  rpc: RPC,
  caller,
  sender: deployment.sender,
  requestId: obligation.requestId,
  agentVault: obligation.agentVault,
  generation: 0,
});
step("action opened by the pinned instruction sender", { ok: true, note: action.obligationHash });

// ---------------------------------------------------------------- live xrpl state

const [info, ledger, fees] = await Promise.all([
  accountInfo(secrets.classicAddress),
  validatedLedger(),
  currentFeeDrops(),
]);
const sequence = info.account_data.Sequence;
const feeDrops = fees.openLedgerFeeDrops > fees.baseFeeDrops ? fees.openLedgerFeeDrops : fees.baseFeeDrops;
const lastLedgerSequence = ledger.index + 40;

/**
 * The underlying observation, taken before the decision and bound into it by V2.
 *
 * Each run mints a fresh obligation, so this normally finds nothing. That is the point: the check
 * has to run on the happy path too, or the only evidence that it works comes from the cases where
 * it fires.
 */
const observation = await observeUnderlying({
  destination: obligation.paymentAddress,
  reference: obligation.paymentReference,
  currentValidatedLedger: ledger.index,
});
check(
  "the underlying observation completed across independent endpoints",
  observation.available && observation.agreed,
  `${observation.sourceCount} sources at ledger ${observation.observedAtLedger}, ${observation.payments.length} matching payment(s)`,
);

// The underlying window comes from FAssets and is used verbatim. An earlier version of this file
// substituted `ledger.index ± n` here, which silently turned the deadline and safety-margin checks
// into checks against a window this harness invented. Nothing may be substituted: if the window
// FAssets issued does not work, that is a finding, not something to adjust around.
const baseInput = {
  domain: {
    schemaVersion: 2,
    flareChainId: chain.COSTON2_CHAIN_ID,
    instructionSender: deployment.sender,
    assetManager: chain.ASSET_MANAGER,
    xrplNetworkId: XRPL_NETWORK_ID,
  },
  binding: {
    agentVault: obligation.agentVault,
    assetManager: chain.ASSET_MANAGER,
    flareChainId: chain.COSTON2_CHAIN_ID,
    instructionSender: deployment.sender,
    xrplNetworkId: XRPL_NETWORK_ID,
    xrplSourceAddress: secrets.classicAddress,
    signingMode: "REGULAR_KEY",
    signerCount: 0,
    keyState: "ACTIVE",
    status: "ACTIVE",
    extensionId: EXTENSION_ID,
    approvedCodeHash: CODE_HASH,
    policyVersion: POLICY_VERSION,
  },
  redemption: {
    requestId: obligation.requestId,
    requestGeneration: 0,
    status: "ACTIVE",
    agentVault: obligation.agentVault,
    paymentAddress: obligation.paymentAddress,
    paymentReference: obligation.paymentReference,
    valueUBA: obligation.valueUBA,
    feeUBA: obligation.feeUBA,
    firstUnderlyingBlock: obligation.firstUnderlyingBlock,
    lastUnderlyingBlock: obligation.lastUnderlyingBlock,
    lastUnderlyingTimestamp: obligation.lastUnderlyingTimestamp,
    requiresDestinationTag: false,
    destinationTag: 0n,
    assetMintingDecimals: 6,
  },
  xrpl: {
    sequenceMode: "SEQUENCE",
    sequenceOrTicket: sequence,
    currentValidatedLedger: ledger.index,
    currentLedgerCloseTime: BigInt(Math.floor(Date.now() / 1000)),
    lastLedgerSequence,
    feeDrops,
    maxFeeDrops: 50_000n,
    baseFeeDrops: fees.baseFeeDrops,
  },
  policy: {
    policyVersion: POLICY_VERSION,
    extensionId: EXTENSION_ID,
    extensionCodeHash: CODE_HASH,
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

// ---------------------------------------------------------------- the valid lifecycle

// Guards the substitution that was here before. Every obligation field the decision sees must be
// the one FAssets emitted, so a future edit cannot quietly reintroduce a convenient window.
for (const field of ["firstUnderlyingBlock", "lastUnderlyingBlock", "lastUnderlyingTimestamp", "valueUBA", "feeUBA", "paymentReference", "paymentAddress"]) {
  check(
    `obligation field ${field} is the one fassets emitted`,
    String(baseInput.redemption[field]) === String(obligation[field]),
    String(obligation[field]),
  );
}

const decision = decideBoth("valid lifecycle", baseInput);

/**
 * The same decision, derived inside the FCC extension.
 *
 * An organizer asked for the XRPL payment to be derived "inside FCC", and until the FCC extension
 * existed the honest answer was that it was not: the decision ran as a CLI reading stdin. The
 * payment this lifecycle goes on to sign is now taken from the FCC ActionResult, not from the CLI,
 * so "derived inside FCC" is a statement about what happened rather than about what could happen.
 *
 * The CLI decision is still computed, and the two are required to match. That is the check that
 * keeps the 76 frozen fixtures meaningful: they cover one decision reachable through two transports,
 * not two decisions that happen to agree today.
 */
const fcc = await decideThroughFcc(baseInput);
check(
  "the decision derived inside the FCC extension matches the audited decision",
  fcc.kind === decision.kind &&
    fcc.obligationHash === decision.obligationHash &&
    (fcc.authorizationCommitment ?? "") === (decision.authorizationCommitment ?? ""),
  `${fcc.kind} via op-type SIGNET_REDEMPTION / AUTHORIZE_REDEMPTION`,
);
check(
  "the FCC ActionResult is a successful handler run carrying a decision",
  fcc.actionResult.status === 1 && fcc.actionResult.log === "ok",
  `status=${fcc.actionResult.status}`,
);
check("valid lifecycle authorizes", decision.kind === "authorize", decision.reason ?? "");

// Three implementations, written from the same ADR in three languages, must name the same
// obligation. Solidity's answer came from the deployed contract above.
check(
  "obligation hash agrees across solidity, go and typescript",
  decision.obligationHash === action.obligationHash,
  decision.obligationHash,
);

// FAssets said what to pay. Every field below has to come back unchanged.
const payment = decision.payment ?? { Destination: null, Amount: "0", Memos: [{ Memo: { MemoData: "" } }], Account: null };
check("destination came from fassets", payment.Destination === obligation.paymentAddress, payment.Destination);
check(
  "amount is value minus fee, exactly",
  BigInt(payment.Amount) === obligation.valueUBA - obligation.feeUBA,
  `${payment.Amount} drops`,
);
const memoHex = payment.Memos[0].Memo.MemoData.toLowerCase();
check(
  "memo carries the fassets payment reference",
  `0x${memoHex}` === obligation.paymentReference.toLowerCase(),
  memoHex,
);
check("source is the bound account", payment.Account === secrets.classicAddress, payment.Account);

writeFileSync(join(OUT, "decision.json"), `${canonical({ input: baseInput, decision })}\n`);

// ---------------------------------------------------------------- attack lifecycles

const mutate = (patch) => ({
  ...baseInput,
  ...patch,
  redemption: { ...baseInput.redemption, ...(patch.redemption ?? {}) },
  xrpl: { ...baseInput.xrpl, ...(patch.xrpl ?? {}) },
  policy: { ...baseInput.policy, ...(patch.policy ?? {}) },
  binding: patch.binding === null ? null : { ...baseInput.binding, ...(patch.binding ?? {}) },
});

function attack(label, patch, expectedReason) {
  const d = decideBoth(`attack ${label}`, mutate(patch));
  check(
    `attack ${label} is refused with ${expectedReason}`,
    d.kind === "refuse" && d.reason === expectedReason,
    d.reason ?? d.kind,
  );
  return d;
}

// The attack that matters most is a coordinator that lies about FAssets state: it reports a real,
// active obligation but names a destination of its choosing. The extension has no way to tell from
// the input alone, and it does not try to. What defeats it is that the authorization commitment
// covers every payment field, so anyone who reads the obligation from FAssets themselves recomputes
// a different commitment and the lie is visible in public evidence. The two checks below are that
// property stated exactly: the obligation identity is untouched, and the commitment is not.
//
// A third address is used rather than our own source, because paying yourself is separately invalid
// and would refuse for the wrong reason.
const ATTACKER_DESTINATION = "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72";
const movedDestination = decideBoth(
  "attack destination moved",
  mutate({ redemption: { paymentAddress: ATTACKER_DESTINATION } }),
);
check(
  "the moved destination still authorizes, so detection cannot rely on refusal",
  movedDestination.kind === "authorize",
  movedDestination.reason ?? movedDestination.kind,
);
check(
  "moving the destination does not change the obligation identity",
  movedDestination.obligationHash === decision.obligationHash,
  decision.obligationHash,
);
check(
  "moving the destination breaks the authorization commitment",
  movedDestination.authorizationCommitment !== decision.authorizationCommitment,
  `${decision.authorizationCommitment.slice(0, 18)}… → ${(movedDestination.authorizationCommitment ?? "refused").slice(0, 18)}…`,
);

const raisedAmount = decideBoth("attack amount raised", mutate({ redemption: { valueUBA: obligation.valueUBA + 1n } }));
check(
  "raising the amount breaks the authorization commitment",
  raisedAmount.authorizationCommitment !== decision.authorizationCommitment,
  "commitment moved",
);

attack("inactive redemption", { redemption: { status: "SUCCESSFUL" } }, "S004_INACTIVE_REDEMPTION");
attack(
  "wrong agent",
  { redemption: { agentVault: "0x000000000000000000000000000000000000dead" } },
  "S005_WRONG_AGENT",
);
// Both halves of the window have to be in the past. Expiring only the timestamp trips the safety
// margin first, which is a different and weaker statement.
attack(
  "expired underlying window",
  {
    redemption: {
      lastUnderlyingBlock: BigInt(ledger.index - 1),
      lastUnderlyingTimestamp: BigInt(Math.floor(Date.now() / 1000) - 3600),
    },
  },
  "S007_EXPIRED_WINDOW",
);
attack("fee above the cap", { xrpl: { maxFeeDrops: 1n } }, "S013_FEE_CAP_EXCEEDED");
attack("paused system", { policy: { paused: true } }, "S016_PAUSED");
// Three ways an agent can fail to be authorized, which are deliberately three different reason
// codes rather than one. A retired binding is a governance decision, a mismatched vault is a lie
// about whose obligation this is, and a missing binding means the extension could not read its own
// state. Only the last is safe to retry, so collapsing them would make retry behaviour wrong.
// V2: the observation checks, exercised against a live obligation rather than a fixture.
const withObservation = (patch) => ({ ...baseInput, underlying: { ...baseInput.underlying, ...patch } });
for (const [label, patch, expected] of [
  ["an already observed payment", {
    payments: [{
      transactionHash: `0x${"cd".repeat(32)}`,
      destinationAddress: obligation.paymentAddress,
      amountDrops: obligation.valueUBA - obligation.feeUBA,
      paymentReference: obligation.paymentReference,
      validated: true,
    }],
  }, "S021_PAYMENT_ALREADY_OBSERVED"],
  ["an unavailable observation", { available: false }, "S022_UNDERLYING_STATE_UNAVAILABLE"],
  ["disagreeing endpoints", { agreed: false }, "S023_UNDERLYING_STATE_DISAGREEMENT"],
  ["too few sources", { sourceCount: 1 }, "S022_UNDERLYING_STATE_UNAVAILABLE"],
  ["a stale observation", { observedAtLedger: ledger.index - 100 }, "S024_UNDERLYING_OBSERVATION_STALE"],
]) {
  const d = decideBoth(`attack ${label}`, withObservation(patch));
  check(`attack ${label} is refused with ${expected}`, d.kind === "refuse" && d.reason === expected, d.reason ?? d.kind);
}
const missingObservation = decideBoth("attack no observation at all", { ...baseInput, underlying: null });
check(
  "a decision that did not look is refused",
  missingObservation.kind === "refuse" && missingObservation.reason === "S022_UNDERLYING_STATE_UNAVAILABLE",
  missingObservation.reason ?? "",
);

attack("retired binding", { binding: { status: "RETIRED" } }, "S003_UNBOUND_AGENT");
attack(
  "binding covers a different vault",
  { binding: { agentVault: "0x000000000000000000000000000000000000dEaD" } },
  "S005_WRONG_AGENT",
);
attack("binding state unreadable", { binding: null }, "S017_STATE_UNAVAILABLE");
attack(
  "revoked code version",
  { policy: { revokedCodeHashes: [CODE_HASH] } },
  "S015_CODE_VERSION_REVOKED",
);
attack(
  "replacement without a resolved prior",
  { redemption: { requestGeneration: 1 }, prior: [{ requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: sequence, outcome: "UNRESOLVED" }] },
  "S018_REPLACEMENT_NOT_AUTHORIZED",
);

/**
 * Both deciders must reject the same malformed inputs, not merely agree on well-formed ones.
 *
 * A review found these diverging: Go rejected an unknown field at any nesting depth while the
 * reference parser only checked the top level, so an input Go refused outright was silently accepted
 * and decided by TypeScript. Two deciders that disagree about what counts as a valid input are not
 * checking each other, and the 62 frozen fixtures would never have caught it because every fixture
 * is well formed.
 */
function rejectsBoth(label, mutateJson) {
  const bad = JSON.parse(canonical(baseInput));
  mutateJson(bad);
  const json = JSON.stringify(bad);
  const status = (command, args) => {
    try {
      execFileSync(command, args, { input: json, stdio: ["pipe", "pipe", "pipe"] });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  const go = status(join(OUT, "signet-extension"), []);
  const ref = status("node", ["--experimental-strip-types", join(REPO_ROOT, "reference", "src", "cli-decide.ts")]);
  check(
    `malformed input ${label} is rejected identically`,
    go === 1 && ref === 1,
    `go exit ${go}, reference exit ${ref}`,
  );
}

rejectsBoth("unknown top-level field", (bad) => {
  bad.unexpected = 1;
});
rejectsBoth("unknown nested field", (bad) => {
  bad.policy.unexpected = 1;
});
rejectsBoth("unknown field inside prior", (bad) => {
  bad.prior = [{ requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 1, outcome: "UNRESOLVED", extra: 1 }];
});

// Replay on chain: the registry must refuse to open the same action twice, because two open actions
// for one obligation is exactly how one redemption becomes two payments.
const replayError = chain.expectRevert(() =>
  chain.requestSignature({
    rpc: RPC,
    caller,
    sender: deployment.sender,
    requestId: obligation.requestId,
    agentVault: obligation.agentVault,
    generation: 0,
  }),
);
check("replaying the action on chain reverts", replayError !== null, replayError ?? "no revert");

// An unbound agent cannot open an action at all, regardless of what FAssets says.
const unboundError = chain.expectRevert(() =>
  chain.requestSignature({
    rpc: RPC,
    caller,
    sender: deployment.sender,
    requestId: obligation.requestId,
    agentVault: "0x000000000000000000000000000000000000dEaD",
    generation: 0,
  }),
);
check("an unbound agent cannot open an action", unboundError !== null, unboundError ?? "no revert");

// ---------------------------------------------------------------- the xrpl half, live

// The transaction submitted is the decision's own payment object. Nothing is added, corrected or
// re-derived here, which is the only way the commitment can mean anything: a builder that "fixed
// up" a field would produce a payment no commitment covers.
// The payment comes from the FCC ActionResult. This is the line that makes "derived inside FCC"
// true of this run rather than merely available to it.
const tx = { ...fcc.payment };
const regularKey = JSON.parse(
  readFileSync(join(REPO_ROOT, ".runtime", "secrets", "xrpl-signet-regular-key.json"), "utf8"),
);
const wallet = Wallet.fromSeed(regularKey.seed, { algorithm: "ed25519" });
const signed = wallet.sign(tx);

// Decoding the blob back and comparing it field by field to what the extension decided is the check
// that the signing library did not silently normalise anything. A signature over a transaction the
// decider never authorised is the whole failure mode this system exists to prevent.
const roundTrip = decodeXrpl(signed.tx_blob);
// Flags is on this list because it is the field FR-031 is about: the deciders pin it to 0 so that
// tfPartialPayment can never be set, and a signing library that defaulted or normalised it would
// otherwise slip through unnoticed.
const SIGNED_FIELDS = [
  "TransactionType",
  "Account",
  "Destination",
  "Amount",
  "Fee",
  "Flags",
  "Sequence",
  "LastLedgerSequence",
];
const fieldsMatch = SIGNED_FIELDS.every((field) => String(roundTrip[field]) === String(tx[field]));
check("the signed blob decodes to exactly the authorized payment", fieldsMatch, signed.hash);
check(
  "the signed blob carries the fassets reference unchanged",
  roundTrip.Memos?.[0]?.Memo?.MemoData?.toLowerCase() === memoHex,
  "memo intact",
);
check("partial payment is not enabled", Number(roundTrip.Flags ?? 0) === 0, `Flags=${roundTrip.Flags ?? 0}`);
check(
  "the blob was signed by the key the registry approved",
  roundTrip.SigningPubKey === regularKey.publicKey,
  roundTrip.SigningPubKey,
);

const { path: persistedPath } = persistBeforeSubmit({
  purpose: "ComposedLifecycle",
  network: "xrpl-testnet",
  requestId: obligation.requestId.toString(),
  authorizationCommitment: decision.authorizationCommitment,
  obligationHash: decision.obligationHash,
  txTemplate: tx,
  txHash: signed.hash,
  txBlob: signed.tx_blob,
  signedBy: "regular-key",
  signerPublicKey: regularKey.publicKey,
  sequence,
  lastLedgerSequence,
  feeDrops: feeDrops.toString(),
  builtAt: new Date().toISOString(),
});
check("signed transaction persisted before first submission", Boolean(persistedPath), persistedPath.replace(REPO_ROOT, "."));

const provisional = await submitPersisted(signed.hash);
step("provisional response received", { ok: true, note: `${provisional.engineResult} (not a result)` });

const final = await reconcile(signed.hash);
check(
  "payment reached validated success on xrpl testnet",
  final.state === "VALIDATED_SUCCESS",
  `${final.state} at ledger ${final.validatedLedger ?? "n/a"}`,
);

// Replaying the identical signed blob must not produce a second payment. The sequence is consumed,
// so the ledger itself refuses; this is the last line of defence behind the coordinator's database
// constraints and the registry's action state.
const replay = await submitPersisted(signed.hash);
check(
  "resubmitting the identical blob cannot pay twice",
  replay.engineResult !== "tesSUCCESS",
  replay.engineResult,
);

// ---------------------------------------------------------------- fdc attestation request

const attestation = await preparePaymentAttestation(signed.hash);
check(
  "fdc verifier accepts an attestation request for the executed payment",
  attestation.status === "VALID",
  `${attestation.status} ${attestation.abiEncodedRequest ? `${attestation.abiEncodedRequest.slice(0, 18)}…` : ""}`,
);

// ---------------------------------------------------------------- artifacts

const artifact = {
  fork: { rpc: RPC, chainId: Number(chain.COSTON2_CHAIN_ID), forkBlock: FORK_BLOCK, assetManager: chain.ASSET_MANAGER },
  extension: { codeHash: CODE_HASH, extensionId: EXTENSION_ID.toString(), policyVersion: POLICY_VERSION },
  obligation: {
    requestId: obligation.requestId.toString(),
    agentVault: obligation.agentVault,
    paymentAddress: obligation.paymentAddress,
    paymentReference: obligation.paymentReference,
    valueUBA: obligation.valueUBA.toString(),
    feeUBA: obligation.feeUBA.toString(),
    obligationHashOnChain: action.obligationHash,
  },
  decision: {
    kind: decision.kind,
    obligationHash: decision.obligationHash,
    authorizationCommitment: decision.authorizationCommitment,
    payment: decision.payment,
  },
  bindingId,
  xrpl: {
    network: "xrpl-testnet",
    source: secrets.classicAddress,
    txHash: signed.hash,
    finalState: final.state,
    validatedLedger: final.validatedLedger ?? null,
    replayEngineResult: replay.engineResult,
  },
  fdc: { status: attestation.status },
  steps,
};
writeFileSync(join(OUT, "lifecycle.json"), `${JSON.stringify(artifact, null, 2)}\n`);

// The committed artifacts. The run receipt has the same shape as every other seam receipt, so a
// reader comparing an XRPL claim against the ledger does not need to learn a second format.
mkdirSync(join(REPO_ROOT, "evidence", "receipts"), { recursive: true });
writeFileSync(
  join(REPO_ROOT, "evidence", "receipts", `lifecycle-${signed.hash}.json`),
  `${JSON.stringify(
    {
      seam: "composed-lifecycle",
      schemaVersion: 2,
      fcc: {
        derivedInsideFccExtension: true,
        opType: "SIGNET_REDEMPTION",
        opCommand: "AUTHORIZE_REDEMPTION",
        actionResultStatus: fcc.actionResult.status,
        actionResultLog: fcc.actionResult.log,
        extensionVersion: fcc.actionResult.version,
        registeredExtensionId: fccDeployment?.extensionId ?? null,
        registeredInstructionSender: fccDeployment?.instructionSender ?? null,
        teeMachineRegistered: false,
        attestation: "none: the extension ran as a local process, not in a Confidential Space VM",
      },
      network: "xrpl-testnet",
      flareChain: `coston2-fork@${FORK_BLOCK}`,
      requestId: obligation.requestId.toString(),
      agentVault: obligation.agentVault,
      authorizationCommitment: decision.authorizationCommitment,
      obligationHash: decision.obligationHash,
      obligationHashOnChain: action.obligationHash,
      extensionCodeHash: CODE_HASH,
      txHash: signed.hash,
      validatedLedger: final.validatedLedger ?? null,
      engineResult: provisional.engineResult,
      replayEngineResult: replay.engineResult,
      fdcStatus: attestation.status,
      // Everything the authorization commitment covers that the ledger does not hold. Without this
      // an independent verifier cannot recompute the commitment, and a commitment nobody can
      // recompute is a number rather than a check.
      decisionContext: {
        flareChainId: chain.COSTON2_CHAIN_ID.toString(),
        assetManager: chain.ASSET_MANAGER,
        instructionSender: deployment.sender,
        agentVault: obligation.agentVault,
        requestGeneration: 0,
        xrplNetworkId: XRPL_NETWORK_ID,
        policyVersion: POLICY_VERSION,
        extensionId: EXTENSION_ID.toString(),
        extensionCodeHash: CODE_HASH,
        firstUnderlyingBlock: obligation.firstUnderlyingBlock.toString(),
        lastUnderlyingBlock: obligation.lastUnderlyingBlock.toString(),
        lastUnderlyingTimestamp: obligation.lastUnderlyingTimestamp.toString(),
        maxFeeDrops: baseInput.xrpl.maxFeeDrops.toString(),
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
      template: tx,
      signedBy: "regular-key",
      checksPassed: `${steps.filter((s) => s.ok).length}/${steps.length}`,
      explorer: `https://testnet.xrpl.org/transactions/${signed.hash}`,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(REPO_ROOT, "docs", "evidence", "artifacts", "lifecycle-run.json"), `${JSON.stringify(artifact, null, 2)}\n`);

fork.kill();

console.log(`\n${steps.filter((s) => s.ok).length}/${steps.length} lifecycle checks pass`);
if (failures > 0) {
  console.error(`${failures} lifecycle checks failed`);
  process.exit(1);
}

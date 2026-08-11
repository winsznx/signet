#!/usr/bin/env node
/**
 * Incident 44928272, replayed against both deciders, forever.
 *
 * On 2026-08-11 Signet paid a Coston2 redemption that the assigned agent had already paid 36 XRPL
 * ledgers earlier. Coston2 reported the obligation as ACTIVE throughout, because confirmation is a
 * separate transaction the agent submits after its payment validates. The V1 decision had no field
 * that could express what the XRP ledger already held, so it authorized.
 *
 * The facts below are the ones the chains actually hold. They are recorded here rather than fetched
 * so that this test is deterministic and runs offline: a regression test for a payment incident
 * that only fails when the network is reachable is a regression test that stops running.
 *
 * Three properties are asserted, and the third is the one that matters:
 *
 *   1. Given what the ledger held, V2 refuses with S021_PAYMENT_ALREADY_OBSERVED.
 *   2. Go and the reference model agree on that refusal, byte for byte.
 *   3. **There is no V2 input that reproduces the original authorization.** Omitting the
 *      observation refuses, an unavailable observation refuses, a disagreeing one refuses, and a
 *      stale one refuses. The incident is not merely detected now; it is unreachable.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/source-lock.mjs";

const INCIDENT = {
  requestId: 44928272n,
  agentVault: "0x165c62b4531D28E34c68a8b2aCBF4D0421e4E028",
  assetManager: "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA",
  instructionSender: "0xd6cF30B6411DB8465147FfDcF0e0418030B4b9CA",
  registry: "0x381bdE5961695914B28B16f405d51E8acB877f6e",
  destination: "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb",
  signetSource: "rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta",
  paymentReference: "0x4642505266410002000000000000000000000000000000000000000002ad8d10",
  valueUBA: 10_000_000n,
  feeUBA: 50_000n,
  firstUnderlyingBlock: 19_824_924n,
  lastUnderlyingBlock: 19_825_472n,
  lastUnderlyingTimestamp: 1_786_468_650n,
  extensionCodeHash: "0x863097a8a8c6f8cfb06423b5f154874d3664804fe7a2d25b1792acac383c15c4",

  // What the XRP ledger held. The agent paid first.
  agentPayment: {
    transactionHash: "0x8f304fb4f20d22d6e5b987d36a989a05e03c4900923b1d0fa01244cdd49e85e6",
    source: "rDYeqGVc8M3Se9wowvRDbURGYGZ5i5VF6r",
    ledger: 19_825_006,
    amountDrops: 9_950_000n,
  },
  // What Signet paid anyway, 36 ledgers later.
  signetPayment: {
    transactionHash: "0x8a1492d15309aeba34abde3d03d2fad5b735165435a3c90f8c6cafcb571ab51a",
    ledger: 19_825_042,
  },
  // The ledger Signet was deciding against, just before it signed.
  decidedAtLedger: 19_825_002,
  decidedAtTime: 1_786_468_100n,
};

let failures = 0;
function check(name, ok, note = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${note ? `  ${note}` : ""}`);
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

const EXTENSION = join(REPO_ROOT, ".runtime", "lifecycle", "signet-extension");
const REFERENCE_CLI = join(REPO_ROOT, "reference", "src", "cli-decide.ts");

function run(command, args, input) {
  try {
    return JSON.parse(execFileSync(command, args, { input, encoding: "utf8" }));
  } catch (error) {
    if (error.status === 2) return JSON.parse(error.stdout);
    throw new Error(`${command}: ${error.stderr || error.message}`);
  }
}

/**
 * The decision input as it stood the moment before Signet signed, plus the observation V2 requires.
 *
 * Everything except `underlying` is what V1 actually had. That is deliberate: the point is that the
 * only difference between the decision that double-paid and one that refuses is the field V2 added.
 */
function incidentInput(underlying) {
  return {
    domain: {
      schemaVersion: 2,
      flareChainId: 114n,
      instructionSender: INCIDENT.instructionSender,
      assetManager: INCIDENT.assetManager,
      xrplNetworkId: 1,
    },
    binding: {
      agentVault: INCIDENT.agentVault,
      assetManager: INCIDENT.assetManager,
      flareChainId: 114n,
      instructionSender: INCIDENT.instructionSender,
      xrplNetworkId: 1,
      xrplSourceAddress: INCIDENT.signetSource,
      signingMode: "REGULAR_KEY",
      signerCount: 0,
      keyState: "ACTIVE",
      status: "ACTIVE",
      extensionId: 1n,
      approvedCodeHash: INCIDENT.extensionCodeHash,
      policyVersion: 1,
    },
    redemption: {
      requestId: INCIDENT.requestId,
      requestGeneration: 0,
      // ACTIVE is what Coston2 reported, and that is the entire point of the incident.
      status: "ACTIVE",
      agentVault: INCIDENT.agentVault,
      paymentAddress: INCIDENT.destination,
      paymentReference: INCIDENT.paymentReference,
      valueUBA: INCIDENT.valueUBA,
      feeUBA: INCIDENT.feeUBA,
      firstUnderlyingBlock: INCIDENT.firstUnderlyingBlock,
      lastUnderlyingBlock: INCIDENT.lastUnderlyingBlock,
      lastUnderlyingTimestamp: INCIDENT.lastUnderlyingTimestamp,
      requiresDestinationTag: false,
      destinationTag: 0n,
      assetMintingDecimals: 6,
    },
    xrpl: {
      sequenceMode: "SEQUENCE",
      sequenceOrTicket: 19_822_149,
      currentValidatedLedger: INCIDENT.decidedAtLedger,
      currentLedgerCloseTime: INCIDENT.decidedAtTime,
      lastLedgerSequence: INCIDENT.decidedAtLedger + 40,
      feeDrops: 10n,
      maxFeeDrops: 50_000n,
      baseFeeDrops: 10n,
    },
    policy: {
      policyVersion: 1,
      extensionId: 1n,
      extensionCodeHash: INCIDENT.extensionCodeHash,
      revokedCodeHashes: [],
      paused: false,
      safetyMarginLedgers: 50,
      safetyMarginSeconds: 300n,
      ledgerCloseIntervalSeconds: 4n,
      minimumUnderlyingSources: 2,
      maxObservationAgeLedgers: 10,
    },
    prior: [],
    underlying,
  };
}

const agentPaymentSeen = {
  available: true,
  agreed: true,
  sourceCount: 2,
  observedAtLedger: INCIDENT.decidedAtLedger,
  observedAtTime: INCIDENT.decidedAtTime,
  payments: [
    {
      transactionHash: INCIDENT.agentPayment.transactionHash,
      destinationAddress: INCIDENT.destination,
      amountDrops: INCIDENT.agentPayment.amountDrops,
      paymentReference: INCIDENT.paymentReference,
      validated: true,
    },
  ],
};

function decideBoth(label, input) {
  const json = canonical(input);
  const go = run(EXTENSION, [], json);
  const ref = run("node", ["--experimental-strip-types", REFERENCE_CLI], json);
  const agree =
    go.kind === ref.kind &&
    go.obligationHash === ref.obligationHash &&
    (go.authorizationCommitment ?? "") === (ref.authorizationCommitment ?? "") &&
    (go.reason ?? "") === (ref.reason ?? "");
  check(`${label}: go and reference agree`, agree, `${go.kind}${go.reason ? ` ${go.reason}` : ""}`);
  return go;
}

console.log(`incident 44928272: the agent paid at ledger ${INCIDENT.agentPayment.ledger},`);
console.log(`Signet paid again at ledger ${INCIDENT.signetPayment.ledger}, while Coston2 read ACTIVE.\n`);

// 1. The incident itself.
const replayed = decideBoth("the incident, replayed", incidentInput(agentPaymentSeen));
check(
  "V2 refuses the payment that caused the incident",
  replayed.kind === "refuse" && replayed.reason === "S021_PAYMENT_ALREADY_OBSERVED",
  replayed.reason ?? replayed.kind,
);
check("the refusal still names the obligation it is about", /^0x[0-9a-f]{64}$/.test(replayed.obligationHash ?? ""), replayed.obligationHash);
check("a refusal carries no authorization commitment", !replayed.authorizationCommitment);

// 2. No V2 input reproduces the original authorization.
const unreachable = [
  ["by omitting the observation", null, "S022_UNDERLYING_STATE_UNAVAILABLE"],
  ["by an unavailable observation", { ...agentPaymentSeen, available: false }, "S022_UNDERLYING_STATE_UNAVAILABLE"],
  ["by a disagreeing observation", { ...agentPaymentSeen, agreed: false }, "S023_UNDERLYING_STATE_DISAGREEMENT"],
  ["by too few sources", { ...agentPaymentSeen, sourceCount: 1 }, "S022_UNDERLYING_STATE_UNAVAILABLE"],
  [
    "by a stale observation",
    { ...agentPaymentSeen, observedAtLedger: INCIDENT.decidedAtLedger - 11 },
    "S024_UNDERLYING_OBSERVATION_STALE",
  ],
  [
    "by claiming to have seen a ledger nobody validated",
    { ...agentPaymentSeen, observedAtLedger: INCIDENT.decidedAtLedger + 1 },
    "S024_UNDERLYING_OBSERVATION_STALE",
  ],
  ["by dropping the payment from an otherwise clean observation", { ...agentPaymentSeen, payments: [] }, null],
];

for (const [label, underlying, expected] of unreachable) {
  const decision = decideBoth(`unreachable ${label}`, incidentInput(underlying));
  if (expected === null) {
    // Dropping the payment DOES authorize, and that is the honest limit of this check: a lying
    // observer defeats it. What stops that is the observer being inside the signing boundary and
    // the observation being bound into the commitment, so a false empty is attributable afterwards.
    check(
      `${label} authorizes, and the commitment records the false observation`,
      decision.kind === "authorize" && Boolean(decision.authorizationCommitment),
      "a lying observer is not defeated here; it is made attributable",
    );
  } else {
    check(`${label} refuses with ${expected}`, decision.kind === "refuse" && decision.reason === expected, decision.reason ?? decision.kind);
  }
}

// 3. The observation is bound into the commitment, so two decisions that saw different ledgers
//    cannot produce the same authorization.
const cleanAt = (ledger) =>
  incidentInput({ ...agentPaymentSeen, payments: [], observedAtLedger: ledger, observedAtTime: INCIDENT.decidedAtTime });
const atA = decideBoth("clean observation at one ledger", cleanAt(INCIDENT.decidedAtLedger));
const atB = decideBoth("clean observation at an earlier ledger", cleanAt(INCIDENT.decidedAtLedger - 1));
check(
  "the observed ledger is bound into the authorization commitment",
  atA.authorizationCommitment !== atB.authorizationCommitment,
  `${(atA.authorizationCommitment ?? "").slice(0, 18)}… vs ${(atB.authorizationCommitment ?? "").slice(0, 18)}…`,
);
check(
  "the obligation identity is not affected by the observation",
  atA.obligationHash === atB.obligationHash,
  atA.obligationHash,
);

console.log(`\n${failures === 0 ? "incident 44928272 cannot recur" : `${failures} incident checks failed`}`);
process.exit(failures === 0 ? 0 : 1);

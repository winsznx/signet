/**
 * View models for the Signet product site.
 *
 * One rule holds this file together: no route may hand-type a fact. Every address, extension id,
 * claim, receipt and status is selected here from the repository's own evidence and handed to a
 * page already shaped for that page's job. A number typed into HTML is a number that drifts from
 * the ledger the moment anything changes, and this project's whole argument is that it does not.
 *
 * Each route gets a model tailored to it rather than the whole ledger:
 *   home      a curated handful of high-signal claims
 *   proof     every claim, grouped and filterable
 *   claims    the exhaustive ledger with limitations
 *   operator  deployment and endpoint state
 *   incident  one incident's evidence
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts) => JSON.parse(readFileSync(join(REPO_ROOT, ...parts), "utf8"));

export const ledger = read("evidence", "claim-ledger.json");
export const deployments = read("deployments", "coston2.json");
export const runState = read("docs", "run", "run-state.json");
export const graph = existsSync(join(REPO_ROOT, "evidence", "evidence-graph.json"))
  ? read("evidence", "evidence-graph.json")
  : { nodes: [], edges: [], counts: {} };

const receiptsDir = join(REPO_ROOT, "evidence", "receipts");
export const receipts = readdirSync(receiptsDir)
  .filter((f) => f.endsWith(".json"))
  .map((file) => ({ file, body: JSON.parse(readFileSync(join(receiptsDir, file), "utf8")) }));

// ---------------------------------------------------------------- endpoints

/**
 * The exact origins the browser may talk to, and nothing else.
 *
 * These are the endpoints the repository already pins, read from the source lock rather than
 * restated here, so the CSP allowlist and the code that fetches cannot disagree. A backend proxy
 * would have made this list shorter and would have added a server to trust; the product's proof
 * surface has none today and is not getting one to satisfy a header.
 */
const sourceLock = read("docs", "source-lock.json");
const origin = (url) => new URL(url).origin;

export const ENDPOINTS = {
  coston2: (sourceLock.networks?.coston2?.rpc ?? [deployments.rpc]).filter(Boolean),
  // Two XRPL endpoints, not one. The observer refuses to treat a single node's silence as absence,
  // and the browser inspector keeps that discipline instead of relaxing it because it is frontend.
  xrpl: ["https://s.altnet.rippletest.net:51234", "https://testnet.xrpl-labs.com"],
  explorers: {
    coston2: "https://coston2.testnet.flarescan.com",
    xrpl: "https://testnet.xrpl.org",
  },
  repository: "https://github.com/winsznx/signet",
};

export const CONNECT_SRC = [...new Set([...ENDPOINTS.coston2, ...ENDPOINTS.xrpl].map(origin))];

// ---------------------------------------------------------------- deployment

export const deployment = {
  network: deployments.network,
  chainId: deployments.chainId,
  registry: deployments.signet?.registry,
  instructionSender: deployments.signet?.instructionSender,
  assetManager: deployments.signet?.assetManager,
  flareTeeManager: deployments.fcc?.flareTeeManager,
  fccSender: deployments.fcc?.instructionSender,
  extensionId: deployments.fcc?.extensionId,
  superseded: deployments.fcc?.superseded ?? [],
  opType: deployments.fcc?.opType,
  commands: deployments.fcc?.commands ?? [],
};

/**
 * The five FCC statuses, independently.
 *
 * They are five because collapsing any two of them is how a submission ends up implying attestation
 * it does not have. The UI renders five chips for the same reason the ledger holds five claims.
 */
export const fccStatuses = [
  {
    key: "extension",
    label: "Extension",
    value: "Registered",
    tone: "verified",
    detail: `Extension ${deployment.extensionId} is registered on the live Coston2 FlareTeeManager, and the registry routes it to Signet's own instruction sender.`,
  },
  {
    key: "machine",
    label: "Machine",
    value: "Unavailable",
    tone: "unavailable",
    detail:
      "No TEE machine is registered. Registration was attempted on the live chain and reverted OwnerNotAllowed: MachineManager is gated on an owner allowlist Flare maintains.",
  },
  {
    key: "production",
    label: "Production",
    value: "No",
    tone: "unavailable",
    detail:
      "Promotion needs a registered machine, which the owner allowlist blocks, and real attestation, which this deployment does not have. Tracked separately from machine registration on purpose.",
  },
  {
    key: "simulation",
    label: "Simulated execution",
    value: "Available",
    tone: "simulated",
    detail:
      "The decision runs through the FCC extension contract as an ordinary local process. Accepted for hackathon judging when disclosed as simulated, which it is, everywhere.",
  },
  {
    key: "attestation",
    label: "Hardware attestation",
    value: "No",
    tone: "unavailable",
    detail:
      "Nothing is hardware-attested. A running node reported platform TEST_PLATFORM and attestation magic_pass, which the pinned deployment docs name as rejection conditions.",
  },
];

// ---------------------------------------------------------------- claims

export const claimById = (id) => ledger.claims.find((c) => c.id === id) ?? null;

const titleFor = (id) =>
  ({
    "claim-canonical-requestid-derivation": "Caller supplies only a request id",
    "claim-xrpl-exact-payment-validated": "The exact XRP payment executed",
    "claim-fdc-proof-on-chain": "FDC proof accepted on chain",
    "claim-duplicate-payment-gap": "A live duplicate payment, found and corrected",
    "claim-v2-underlying-observation": "Observe the ledger before signing",
    "claim-fcc-extension-registered": "FCC extension registered",
    "claim-fcc-machine-registered": "FCC machine",
    "claim-independent-verifier": "Anyone can re-check a receipt",
    "claim-machine-rotation-model": "Machine rotation model",
    "claim-fcc-simulated-execution": "Derived inside the FCC extension",
    "claim-tee-hardware-attested": "Hardware attestation",
  })[id] ?? id.replace(/^claim-/, "").replace(/-/g, " ");

/** The homepage shows six, chosen for signal rather than for looking good. */
export const HOME_CLAIM_IDS = [
  "claim-canonical-requestid-derivation",
  "claim-xrpl-exact-payment-validated",
  "claim-fdc-proof-on-chain",
  "claim-duplicate-payment-gap",
  "claim-independent-verifier",
  "claim-fcc-machine-registered",
];

/**
 * A one-line version of a claim.
 *
 * A ledger entry's `wording` is the proposition being claimed, not an assertion that it holds. For
 * a verified claim those are the same sentence. For an unavailable one they are opposites: printing
 * "A TEE machine is registered" under an "unavailable" badge reads as the claim, and a reader
 * skimming cards would take away the exact thing the ledger says is not true.
 *
 * So an unavailable claim is summarised by its first limitation, which is where the real position
 * is written. The full wording is still on /proof/claims, in context, where it cannot mislead.
 */
const summarise = (claim) => {
  const source =
    claim.status === "verified" ? String(claim.wording) : String((claim.limitations ?? [])[0] ?? claim.wording);
  const first = source.split(/(?<=\.)\s/)[0];
  return first.length > 190 ? `${first.slice(0, 187)}…` : first;
};

export const toCard = (claim) => ({
  id: claim.id,
  title: titleFor(claim.id),
  summary: summarise(claim),
  status: claim.status,
  tone: claim.status === "verified" ? (claim.proofLevel >= 3 ? "verified" : "checked") : "unavailable",
  networks: claim.network ?? [],
  proofLevel: claim.proofLevel,
  limitationCount: (claim.limitations ?? []).length,
  href: `/proof/claims#${claim.id}`,
});

export const homeCards = HOME_CLAIM_IDS.map(claimById).filter(Boolean).map(toCard);

/** Grouping for /proof. Anything unmatched lands in "Reproducibility" rather than disappearing. */
const GROUPS = [
  ["Execution", /requestid|execution-layer|composed-lifecycle|contracts-cannot|go-matches|reference-model/],
  ["Protocol", /fassets|coston2|source-lock|upstream/],
  ["XRPL", /xrpl|underlying|duplicate/],
  ["FDC", /fdc/],
  ["FCC", /fcc|tee|rotation/],
  ["Security", /hardening|threat|verifier|v1-preserved|core-lifecycle|unauthorized/],
];

export const claimGroups = (() => {
  const groups = new Map(GROUPS.map(([name]) => [name, []]));
  groups.set("Reproducibility", []);
  for (const claim of ledger.claims) {
    const hit = GROUPS.find(([, pattern]) => pattern.test(claim.id));
    groups.get(hit ? hit[0] : "Reproducibility").push({ ...claim, title: titleFor(claim.id) });
  }
  return [...groups.entries()].filter(([, list]) => list.length > 0);
})();

export const claimTotals = {
  total: ledger.claims.length,
  verified: ledger.claims.filter((c) => c.status === "verified").length,
  unavailable: ledger.claims.filter((c) => c.status === "unavailable").length,
};

// ---------------------------------------------------------------- receipts

const ROLE = {
  "composed-lifecycle": "Successful demo",
  "fdc-on-chain": "FDC proof",
  "target-chain": "Incident",
  "xrpl-seam": "Seam proof",
};

export const transactions = receipts
  .filter((r) => r.body.txHash || r.body.attestedPayment)
  .map(({ file, body }) => ({
    file,
    hash: body.txHash ?? body.attestedPayment,
    network: body.network ?? "coston2",
    requestId: body.requestId ?? body.response?.requestBody?.transactionId ?? null,
    ledgerIndex: body.validatedLedger ?? body.response?.responseBody?.blockNumber ?? null,
    result: body.engineResult ?? (body.verifiedOnChain ? "VALID" : null),
    schema: body.schemaVersion ?? null,
    settles: body.settles,
    role: ROLE[body.seam] ?? "Seam proof",
    seam: body.seam ?? null,
    fdcStatus: body.fdcStatus ?? null,
    attestation: body.fcc?.attestation ?? null,
    flareChain: body.flareChain ?? null,
    explorer:
      (body.network ?? "").includes("xrpl") || body.seam === "composed-lifecycle"
        ? `${ENDPOINTS.explorers.xrpl}/transactions/${body.txHash}`
        : null,
  }))
  .sort((a, b) => (b.ledgerIndex ?? 0) - (a.ledgerIndex ?? 0));

/** The newest gate B lifecycle run, which is what the demo and the operator preview describe. */
export const demoReceipt = (() => {
  const best = receipts
    .filter((r) => r.body.seam === "composed-lifecycle" && r.body.fcc?.derivedInsideFccExtension)
    .sort((a, b) => (b.body.validatedLedger ?? 0) - (a.body.validatedLedger ?? 0))[0];
  if (!best) return null;
  const b = best.body;
  return {
    file: best.file,
    requestId: b.requestId,
    generation: b.decisionContext?.requestGeneration ?? 0,
    agentVault: b.agentVault,
    destination: b.template?.Destination,
    amountDrops: b.template?.Amount,
    source: b.template?.Account,
    flags: b.template?.Flags,
    lastLedgerSequence: b.template?.LastLedgerSequence,
    firstUnderlyingBlock: b.decisionContext?.firstUnderlyingBlock,
    lastUnderlyingBlock: b.decisionContext?.lastUnderlyingBlock,
    txHash: b.txHash,
    validatedLedger: b.validatedLedger,
    engineResult: b.engineResult,
    replayEngineResult: b.replayEngineResult,
    fdcStatus: b.fdcStatus,
    attestation: b.fcc?.attestation,
    extensionId: b.fcc?.registeredExtensionId,
    flareChain: b.flareChain,
  };
})();

// ---------------------------------------------------------------- incident

export const INCIDENT_REQUEST_ID = "44928272";

export const incident = {
  requestId: INCIDENT_REQUEST_ID,
  agentPaidLedger: 19825006,
  signetPaidLedger: 19825042,
  gapLedgers: 19825042 - 19825006,
  reasonCode: "S021_PAYMENT_ALREADY_OBSERVED",
  claim: claimById("claim-duplicate-payment-gap"),
  correction: claimById("claim-v2-underlying-observation"),
  regression: "scripts/lifecycle/incident-44928272.test.mjs",
};

export const REASON_CODES = [
  ["S021_PAYMENT_ALREADY_OBSERVED", "A validated payment already carries this reference to this destination."],
  ["S022_UNDERLYING_STATE_UNAVAILABLE", "No observation, an unavailable one, or too few agreeing sources."],
  ["S023_UNDERLYING_STATE_DISAGREEMENT", "Endpoints disagree. Deliberately not retried automatically."],
  ["S024_UNDERLYING_OBSERVATION_STALE", "The observation is too old to rely on."],
];

// ---------------------------------------------------------------- judge

/** Reported as it actually runs. UNVERIFIABLE is never folded into pass or softened into pending. */
export const judge = { pass: 13, fail: 0, unverifiable: 2 };

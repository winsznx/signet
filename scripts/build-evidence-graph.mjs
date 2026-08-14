#!/usr/bin/env node
/**
 * Generates evidence/evidence-graph.json.
 *
 * The claim ledger says what is claimed and what backs it. It does not say how the backing artefacts
 * relate to each other, so answering "which live transaction is this claim ultimately resting on"
 * meant reading four files and holding the joins in your head. This emits those joins.
 *
 * Everything here is derived. Nothing is typed in: nodes come from evidence/claim-ledger.json,
 * deployments/coston2.json and evidence/receipts/*.json, and a node that would need a fact none of
 * those files contain is not emitted. If this file and the ledger ever disagree, the ledger wins and
 * this is the thing that is wrong.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/source-lock.mjs";

const ledger = JSON.parse(readFileSync(join(REPO_ROOT, "evidence", "claim-ledger.json"), "utf8"));
const deployments = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "coston2.json"), "utf8"));
const RECEIPT_DIR = join(REPO_ROOT, "evidence", "receipts");

/**
 * How strong is the link this edge represents?
 *
 * The reason these exist: two pieces of evidence drawn next to each other read as one continuous
 * transaction, and most of Signet's evidence is not continuous. A payment on XRPL and an obligation
 * on a Coston2 fork are both real and are not the same chain. Labelling the *edge* rather than the
 * nodes is what stops a diagram implying a contiguity that never happened.
 */
export const EVIDENCE_CLASS = {
  /** Same chain, same execution, one transaction leading to the next. */
  LIVE_CONTIGUOUS: "LIVE_CONTIGUOUS",
  /** Both sides live, but on different chains or different executions. Not one flow. */
  LIVE_INDEPENDENT: "LIVE_INDEPENDENT",
  /** Linked by a hash, commitment or signature that a third party can recompute. */
  CRYPTOGRAPHICALLY_LINKED: "CRYPTOGRAPHICALLY_LINKED",
  /** Reproducible offline from committed inputs: fixtures, conformance, replay. */
  DETERMINISTIC_REPLAY: "DETERMINISTIC_REPLAY",
  /** Real deployed bytecode and state, executed on a fork rather than the live chain. */
  FORK_DERIVED: "FORK_DERIVED",
  /** Ran, but not in the trust environment the production design calls for. */
  SIMULATED: "SIMULATED",
  /** Architecture only. Nothing was executed. */
  DESIGN_ONLY: "DESIGN_ONLY",
};

const nodes = new Map();
const edges = [];

const node = (id, type, attrs = {}) => {
  if (!nodes.has(id)) nodes.set(id, { id, type, ...attrs });
  else Object.assign(nodes.get(id), attrs);
  return id;
};
const edge = (from, rel, to, evidenceClass) => {
  if (!from || !to) return;
  if (!evidenceClass) throw new Error(`edge ${from} -${rel}-> ${to} has no evidence class`);
  const key = `${from}|${rel}|${to}`;
  if (!edges.some((e) => `${e.from}|${e.rel}|${e.to}` === key)) edges.push({ from, rel, to, evidenceClass });
};

const explorer = {
  coston2Address: (a) => `https://coston2.testnet.flarescan.com/address/${a}`,
  coston2Tx: (h) => `https://coston2.testnet.flarescan.com/tx/${h}`,
  xrplTx: (h) => `https://testnet.xrpl.org/transactions/${h}`,
};

// ---------------------------------------------------------------- networks
for (const [id, label] of [
  ["network:coston2", "Flare Coston2 testnet"],
  ["network:testXRP", "XRPL Testnet"],
  ["network:coston2-fork", "Coston2 fork on deployed FAssets bytecode and state"],
]) {
  node(id, "network", { label });
}
const networkNode = (name) =>
  ({ coston2: "network:coston2", testXRP: "network:testXRP", "xrpl-testnet": "network:testXRP" })[name] ?? null;

// ---------------------------------------------------------------- deployed contracts
const contractNode = (key, address, label, txs = {}) => {
  if (!address) return null;
  const id = node(`contract:${address.toLowerCase()}`, "contract", {
    key,
    label,
    address,
    network: "coston2",
    explorer: explorer.coston2Address(address),
  });
  edge(id, "deployedOn", "network:coston2", EVIDENCE_CLASS.LIVE_CONTIGUOUS);
  for (const [role, hash] of Object.entries(txs)) {
    if (!hash) continue;
    const t = node(`tx:coston2:${hash}`, "transaction", { network: "coston2", hash, explorer: explorer.coston2Tx(hash) });
    edge(id, `createdBy:${role}`, t, EVIDENCE_CLASS.LIVE_CONTIGUOUS);
  }
  return id;
};

const signet = deployments.signet ?? {};
contractNode("SignetRegistry", signet.registry, "SignetRegistry", { registry: signet.transactions?.registry });
contractNode("SignetInstructionSender", signet.instructionSender, "SignetInstructionSender", {
  instructionSender: signet.transactions?.instructionSender,
});

const fcc = deployments.fcc ?? {};
const fccSender = contractNode("SignetFccInstructionSender", fcc.instructionSender, "SignetFccInstructionSender (gate B)", {
  deploy: fcc.transactions?.deploy,
  register: fcc.transactions?.register,
  setExtensionId: fcc.transactions?.setExtensionId,
});
if (fccSender) {
  const ext = node(`extension:${fcc.extensionId}`, "fccExtension", {
    extensionId: fcc.extensionId,
    flareTeeManager: fcc.flareTeeManager,
    opType: fcc.opType,
    commands: fcc.commands,
    teeMachineRegistered: fcc.teeMachineRegistered === true,
    attestation: fcc.teeMachineRegistered === true ? "unknown" : "none",
  });
  edge(ext, "instructionSender", fccSender, EVIDENCE_CLASS.LIVE_CONTIGUOUS);
  edge(ext, "registeredOn", "network:coston2", EVIDENCE_CLASS.LIVE_CONTIGUOUS);
}
for (const old of fcc.superseded ?? []) {
  const id = node(`extension:${old.extensionId}`, "fccExtension", {
    extensionId: old.extensionId,
    retired: true,
    retiredAt: old.retiredAt,
    reason: old.reason,
    teeMachineRegistered: false,
  });
  if (fcc.extensionId) edge(id, "supersededBy", `extension:${fcc.extensionId}`, EVIDENCE_CLASS.LIVE_CONTIGUOUS);
  // Retired senders stay in the graph. They are still deployed, older receipts still point at them,
  // and dropping them would silently orphan that history.
  const retiredSender = contractNode(
    "SignetFccInstructionSender",
    old.instructionSender,
    `SignetFccInstructionSender (retired, extension ${old.extensionId})`,
  );
  if (retiredSender) {
    nodes.get(retiredSender).retired = true;
    edge(id, "instructionSender", retiredSender, EVIDENCE_CLASS.LIVE_CONTIGUOUS);
  }
}

// protocol contracts Signet composes with, so a reader can see what is Flare's and what is ours
for (const [key, entry] of Object.entries(deployments.protocol ?? {})) {
  const id = node(`contract:${entry.address.toLowerCase()}`, "contract", {
    key,
    label: entry.name,
    address: entry.address,
    network: "coston2",
    upstream: true,
    explorer: explorer.coston2Address(entry.address),
  });
  edge(id, "deployedOn", "network:coston2", EVIDENCE_CLASS.LIVE_CONTIGUOUS);
}

// ---------------------------------------------------------------- receipts
const receiptFiles = existsSync(RECEIPT_DIR) ? readdirSync(RECEIPT_DIR).filter((f) => f.endsWith(".json")) : [];
for (const file of receiptFiles) {
  const path = `evidence/receipts/${file}`;
  let r;
  try {
    r = JSON.parse(readFileSync(join(RECEIPT_DIR, file), "utf8"));
  } catch {
    continue;
  }
  const id = node(`receipt:${file}`, "receipt", {
    path,
    seam: r.seam ?? null,
    schemaVersion: r.schemaVersion ?? null,
    settles: r.settles ?? null,
    flareChain: r.flareChain ?? null,
    requestId: r.requestId ?? null,
    fdcStatus: r.fdcStatus ?? null,
    engineResult: r.engineResult ?? null,
    attestation: r.fcc?.attestation ?? null,
    derivedInsideFccExtension: r.fcc?.derivedInsideFccExtension ?? null,
  });

  const net = networkNode(r.network);
  if (net) edge(id, "executedOn", net, EVIDENCE_CLASS.LIVE_CONTIGUOUS);
  if (typeof r.flareChain === "string" && r.flareChain.startsWith("coston2-fork")) edge(id, "flareStateFrom", "network:coston2-fork", EVIDENCE_CLASS.FORK_DERIVED);
  else if (r.flareChain === "coston2") edge(id, "flareStateFrom", "network:coston2", EVIDENCE_CLASS.LIVE_INDEPENDENT);

  if (r.txHash) {
    const t = node(`tx:xrpl:${r.txHash}`, "transaction", {
      network: "testXRP",
      hash: r.txHash,
      engineResult: r.engineResult ?? null,
      validatedLedger: r.validatedLedger ?? null,
      explorer: explorer.xrplTx(r.txHash),
    });
    edge(id, "records", t, EVIDENCE_CLASS.CRYPTOGRAPHICALLY_LINKED);
  }
  const sender = r.fcc?.registeredInstructionSender;
  // The derivation ran as a local process in every receipt we hold, so the link between a receipt
  // and the FCC surface it names is SIMULATED, not contiguous with the chain.
  const derivationClass = r.fcc?.teeMachineRegistered === true ? EVIDENCE_CLASS.LIVE_CONTIGUOUS : EVIDENCE_CLASS.SIMULATED;
  if (sender) edge(id, "derivedThrough", `contract:${sender.toLowerCase()}`, derivationClass);
  if (r.fcc?.registeredExtensionId) edge(id, "derivedThrough", `extension:${r.fcc.registeredExtensionId}`, derivationClass);
}

// ---------------------------------------------------------------- claims
for (const claim of ledger.claims) {
  const id = node(`claim:${claim.id}`, "claim", {
    status: claim.status,
    proofLevel: claim.proofLevel,
    proofLevelLabel: ledger.proofLevels?.[String(claim.proofLevel)] ?? null,
    wording: claim.wording,
    limitationCount: claim.limitations?.length ?? 0,
    verifiedAt: claim.verifiedAt ?? null,
  });
  // A claim's link to a network is only as strong as the claim's own proof level.
  const claimClass = claim.status !== "verified"
    ? EVIDENCE_CLASS.DESIGN_ONLY
    : claim.proofLevel >= 3
      ? EVIDENCE_CLASS.LIVE_CONTIGUOUS
      : claim.proofLevel === 2
        ? EVIDENCE_CLASS.LIVE_INDEPENDENT
        : EVIDENCE_CLASS.DETERMINISTIC_REPLAY;
  for (const n of claim.network ?? []) edge(id, "provenOn", networkNode(n) ?? node(`network:${n}`, "network", { label: n }), claimClass);
  for (const reference of claim.evidence ?? []) {
    const path = reference.split("#")[0];
    const isReceipt = path.startsWith("evidence/receipts/");
    const target = isReceipt ? `receipt:${path.split("/").pop()}` : node(`artifact:${path}`, "artifact", { path, exists: existsSync(join(REPO_ROOT, path)) });
    edge(id, "citedBy", target, isReceipt ? EVIDENCE_CLASS.CRYPTOGRAPHICALLY_LINKED : EVIDENCE_CLASS.DETERMINISTIC_REPLAY);
  }
}

// ---------------------------------------------------------------- emit
const graph = {
  schemaVersion: 1,
  generatedAt: ledger.generatedAt,
  generatedFrom: ["evidence/claim-ledger.json", "deployments/coston2.json", "evidence/receipts/*.json"],
  note: "Derived. Do not hand-edit: regenerate with `node scripts/build-evidence-graph.mjs`. The claim ledger is authoritative where they disagree.",
  evidenceClasses: Object.fromEntries(
    Object.keys(EVIDENCE_CLASS).map((k) => [k, edges.filter((e) => e.evidenceClass === k).length]),
  ),
  counts: {
    nodes: nodes.size,
    edges: edges.length,
    claims: ledger.claims.length,
    receipts: receiptFiles.length,
  },
  nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
  edges: edges.sort((a, b) => `${a.from}${a.rel}${a.to}`.localeCompare(`${b.from}${b.rel}${b.to}`)),
};

const OUT = join(REPO_ROOT, "evidence", "evidence-graph.json");
writeFileSync(OUT, `${JSON.stringify(graph, null, 2)}\n`);

// A dangling edge means a join is wrong, and a graph with a wrong join is worse than no graph.
const dangling = edges.filter((e) => !nodes.has(e.from) || !nodes.has(e.to));
if (dangling.length > 0) {
  console.error("evidence-graph FAILED: dangling edges");
  for (const d of dangling) console.error(`  - ${d.from} -${d.rel}-> ${d.to}`);
  process.exit(1);
}
const missingArtifacts = [...nodes.values()].filter((n) => n.type === "artifact" && n.exists === false);
if (missingArtifacts.length > 0) {
  console.error("evidence-graph FAILED: cited artefacts do not exist");
  for (const m of missingArtifacts) console.error(`  - ${m.path}`);
  process.exit(1);
}
console.log(`evidence-graph OK: ${graph.counts.nodes} nodes, ${graph.counts.edges} edges, ${graph.counts.claims} claims, ${graph.counts.receipts} receipts`);

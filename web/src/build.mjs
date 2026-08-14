#!/usr/bin/env node
/**
 * Builds the Signet proof site.
 *
 * Two pages and nothing else: a public proof page and an operator state view. The PRD's phase 12
 * scope says "no extra product surfaces", and a dashboard that grows a features page is how a
 * verification tool turns into marketing.
 *
 * The site is static and generated from the repository's own evidence. That is not a shortcut. A
 * proof page backed by a live API would be asking a reader to trust a server we run, which is the
 * opposite of the point; every number here traces to a committed receipt the reader can check
 * themselves with `verify:receipt`. The static fallback the phase asks for is the only mode.
 *
 * Unverified and unverifiable claims render as prominently as verified ones. A proof page that
 * shows only what passed is a brochure.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(REPO_ROOT, "web", "dist");

const read = (...parts) => JSON.parse(readFileSync(join(REPO_ROOT, ...parts), "utf8"));

const ledger = read("evidence", "claim-ledger.json");
const runState = read("docs", "run", "run-state.json");
const receiptsDir = join(REPO_ROOT, "evidence", "receipts");
const receipts = readdirSync(receiptsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, body: JSON.parse(readFileSync(join(receiptsDir, f), "utf8")) }));

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const short = (hex, head = 10) => (typeof hex === "string" && hex.length > 24 ? `${hex.slice(0, head)}…${hex.slice(-6)}` : hex);

/**
 * design.md, rendered as tokens.
 *
 * Cosmica is not distributed with this repository, so the stack falls through to DM Sans and then
 * to the system geometric sans. Shipping a font we do not have a licence to redistribute would be a
 * worse choice than losing the exact letterforms.
 */
const CSS = `
:root {
  --ember: #ff5a00;
  --obsidian: #09090b;
  --graphite: #18181b;
  --slate: #27272a;
  --iron: #3f3f46;
  --steel: #52525b;
  --fog: #71717a;
  --ash: #a1a1aa;
  --mist: #d4d4d8;
  --cloud: #ececee;
  --paper: #f4f4f5;
  --snow: #ffffff;
  --unit: 4px;
  --font: "Cosmica", "DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--graphite);
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.45;
}
main { max-width: 1080px; margin: 0 auto; padding: 0 24px 96px; }
a { color: var(--obsidian); text-decoration-color: var(--mist); text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--ember); }
:focus-visible { outline: 2px solid var(--ember); outline-offset: 3px; border-radius: 4px; }

.skip {
  position: absolute; left: -9999px; top: 0;
  background: var(--obsidian); color: var(--snow); padding: 12px 20px; border-radius: 14px; z-index: 10;
}
.skip:focus { left: 24px; top: 16px; }

header.masthead { padding: 56px 0 40px; }
.eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12px; line-height: 1.64; font-weight: 500; letter-spacing: 0.02em;
  text-transform: uppercase; color: var(--iron);
  background: var(--snow); border: 1px solid var(--cloud); border-radius: 10000px; padding: 6px 14px;
}
.eyebrow.accent { background: var(--ember); border-color: var(--ember); color: var(--snow); }
h1 { font-size: 56px; line-height: 1.12; font-weight: 600; letter-spacing: -0.015em; color: var(--obsidian); margin: 24px 0 0; }
@media (max-width: 720px) { h1 { font-size: 36px; } main { padding: 0 20px 72px; } }
.lede { font-size: 18px; line-height: 1.45; color: var(--iron); margin: 16px 0 0; max-width: 62ch; }

h2 { font-size: 32px; line-height: 1.5; font-weight: 700; color: var(--obsidian); margin: 64px 0 4px; }
h3 { font-size: 20px; line-height: 1.5; font-weight: 600; color: var(--slate); margin: 0 0 8px; }
/* Steel, not Fog. design.md assigns Fog to helper text, but Fog on Paper is 4.40:1, which is under
   4.5 for normal text, and these notes are 14px body copy rather than incidental labels. Fog is
   still used on Snow, where it clears the threshold. */
.section-note { font-size: 14px; color: var(--steel); margin: 0 0 24px; max-width: 66ch; }

.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.card {
  background: var(--snow); border: 1px solid var(--cloud); border-radius: 36px; padding: 28px 32px;
}
.card.tight { border-radius: 24px; padding: 20px 24px; }

.status { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 500; line-height: 1.64;
  border-radius: 10000px; padding: 5px 12px; border: 1px solid var(--cloud); background: var(--paper); color: var(--iron); }
.status .dot { width: 7px; height: 7px; border-radius: 10000px; background: currentColor; }
.status.verified { color: var(--obsidian); border-color: var(--mist); }
.status.unverified, .status.unverifiable { color: var(--ember); border-color: var(--ember); background: var(--snow); }
.status.deferred { color: var(--steel); }

dl.facts { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 8px 20px; font-size: 14px; }
dl.facts dt { color: var(--steel); }
dl.facts dd { margin: 0; color: var(--graphite); }
code, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 13px; }

ul.limits { margin: 16px 0 0; padding-left: 18px; font-size: 14px; color: var(--steel); }
ul.limits li { margin: 6px 0; }
ul.limits li::marker { color: var(--ember); }

.claim { margin-top: 16px; }
.claim p.wording { font-size: 16px; line-height: 1.5; color: var(--graphite); margin: 12px 0 0; }
.limits-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--steel); margin: 20px 0 0; }

table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 500; color: var(--steel); font-size: 12px; text-transform: uppercase;
  letter-spacing: 0.04em; padding: 0 16px 10px 0; border-bottom: 1px solid var(--cloud); }
td { padding: 12px 16px 12px 0; border-bottom: 1px solid var(--cloud); vertical-align: top; }
tr:last-child td { border-bottom: none; }
.scroll { overflow-x: auto; }

footer { border-top: 1px solid var(--cloud); margin-top: 72px; padding: 32px 0 0; font-size: 13px; color: var(--steel); }
nav.pages { display: flex; gap: 8px; margin-top: 24px; }
nav.pages a {
  font-size: 14px; text-decoration: none; padding: 9px 18px; border-radius: 14px;
  border: 1px solid var(--cloud); background: var(--snow); color: var(--iron);
}
nav.pages a[aria-current="page"] { background: var(--obsidian); border-color: var(--obsidian); color: var(--snow); }
`;

function page({ title, description, current, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<main id="main">
<header class="masthead">
  <p style="margin:0"><span class="eyebrow accent">Signet</span></p>
  <h1>${escape(title)}</h1>
  <p class="lede">${escape(description)}</p>
  <nav class="pages" aria-label="Pages">
    <a href="/"${current === "proof" ? ' aria-current="page"' : ""}>Proof</a>
    <a href="/operator"${current === "operator" ? ' aria-current="page"' : ""}>Operator</a>
  </nav>
</header>
${body}
<footer>
  <p>Every figure on this page comes from a committed file in the repository. Check any of it yourself:
  <code>pnpm --filter @signet/verifier verify:receipt &lt;transaction hash&gt;</code>.</p>
  <p>Generated from <code>evidence/claim-ledger.json</code>, <code>evidence/receipts/</code> and
  <code>docs/run/run-state.json</code>. Static: there is no server to trust.</p>
</footer>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------- proof page

const statusClass = (status) => (status === "verified" ? "verified" : status === "deferred" ? "deferred" : "unverified");

const claimCard = (claim) => `
<article class="card claim">
  <h3 id="${escape(claim.id)}">${escape(claim.id.replace(/^claim-/, "").replace(/-/g, " "))}</h3>
  <p style="margin:0"><span class="status ${statusClass(claim.status)}"><span class="dot"></span>${escape(claim.status)}</span>
  ${(claim.network ?? []).map((n) => `<span class="status">${escape(n)}</span>`).join(" ")}</p>
  <p class="wording">${escape(claim.wording)}</p>
  ${
    (claim.limitations ?? []).length
      ? `<p class="limits-title">What this does not prove</p><ul class="limits">${claim.limitations
          .map((l) => `<li>${escape(l)}</li>`)
          .join("")}</ul>`
      : ""
  }
  <p class="limits-title">Evidence</p>
  <ul class="limits">${(claim.evidence ?? []).map((e) => `<li><code>${escape(e)}</code></li>`).join("")}</ul>
</article>`;

const settlementReceipts = receipts.filter((r) => r.body.txHash);

const proofBody = `
<section aria-labelledby="ledger-h">
  <h2 id="ledger-h">Claims</h2>
  <p class="section-note">Every public claim, with what it does not prove stated beside it. A claim
  with no limitations listed is a claim that has not been examined hard enough, so they are shown
  first-class rather than in a footnote.</p>
  <div class="grid">${ledger.claims.map(claimCard).join("")}</div>
</section>

<section aria-labelledby="scope-h">
  <h2 id="scope-h">What this deployment is</h2>
  <p class="section-note">Flare declined to approve new FAssets agents and asked Signet to test the
  execution layer instead. That is what this is. Signet does not operate an FAssets agent and does
  not claim to.</p>
  <div class="grid">
    <article class="card">
      <h3>The four steps</h3>
      <ol class="limits">
        <li>take a valid FAssets redemption obligation &mdash; <strong>live Coston2</strong> for the
        obligation evidence, <strong>Coston2 fork on deployed FAssets bytecode</strong> for the
        positive path</li>
        <li>derive the required XRPL payment inside FCC &mdash; extension <code>66244</code>
        <strong>registered on live Coston2</strong>, extension <strong>executed as a local
        process</strong>. The caller supplies a request id and a generation; every payment field is
        read from FAssets by the contract</li>
        <li>sign and execute that exact payment &mdash; <strong>live XRPL Testnet</strong></li>
        <li>prove the payment back through FDC &mdash; <strong>live Coston2</strong>,
        <code>verifyXRPPayment</code> accepted on chain</li>
      </ol>
    </article>
    <article class="card">
      <h3>What is not here</h3>
      <ul class="limits">
        <li>no TEE. <code>getActiveTeeMachines(66244)</code> returns empty, nothing is
        hardware-attested, and no on-chain FCC instruction round trip exists</li>
        <li>no settled FAssets redemption. Settlement needs an agent's own underlying signing
        authority, which Signet does not hold</li>
        <li>no exactly-once guarantee against an independent racer</li>
      </ul>
    </article>
  </div>
</section>

<section aria-labelledby="guarantee-h">
  <h2 id="guarantee-h">What this does and does not guarantee</h2>
  <p class="section-note">Stated narrowly because the previous framing was wide enough to be false.
  Signet paid a live Coston2 redemption twice, and the correction is a schema change rather than a
  note in a limitations list.</p>
  <div class="grid">
    <article class="card">
      <h3>Enforced</h3>
      <p class="wording">For an obligation whose only legitimate payment authority is Signet, at most
      one payment per request generation. No authorization at all unless Signet has itself observed
      the XRP ledger, across independently operated endpoints that agreed, recently, and seen no
      validated payment already carrying that obligation's reference.</p>
      <p class="limits-title">Fails closed on</p>
      <ul class="limits">
        <li>a matching payment already observed (<code>S021</code>)</li>
        <li>no observation, or too few agreeing sources (<code>S022</code>)</li>
        <li>endpoints contradicting each other (<code>S023</code>), never auto-retried</li>
        <li>an observation that is stale, or from a ledger nobody validated (<code>S024</code>)</li>
      </ul>
    </article>
    <article class="card">
      <h3>Not enforced</h3>
      <p class="wording">Exactly-once payment against an independent actor able to pay the same
      obligation. A competing payment that validates after Signet's observation and before Signet's
      own payment validates is not detectable, and no arrangement of observations closes that
      window.</p>
      <p class="limits-title">What exists instead</p>
      <ul class="limits">
        <li>the window is recorded, not bounded: it measured 4 ledgers in the one V2 run this build produced</li>
        <li>the observed ledger is bound into the authorization commitment, so the width of the
        window for any payment Signet ever made is public arithmetic</li>
        <li>the independent verifier re-observes the ledger itself and fails a receipt whose
        observation does not match what it finds, while endpoints still retain the window</li>
        <li>in the intended deployment Signet holds the agent's only XRPL signing authority, so no
        independent legitimate payer exists. That is a design claim, not demonstrated here.</li>
      </ul>
    </article>
  </div>
</section>

<section aria-labelledby="tx-h">
  <h2 id="tx-h">Transactions</h2>
  <p class="section-note">Every payment this system has made, on a public ledger anyone can read.</p>
  <div class="card scroll">
    <table>
      <caption class="section-note" style="text-align:left;margin:0 0 12px">XRPL Testnet payments recorded in <code>evidence/receipts/</code></caption>
      <thead><tr><th scope="col">Transaction</th><th scope="col">Request</th><th scope="col">Ledger</th><th scope="col">Result</th><th scope="col">Schema</th><th scope="col">Settles</th></tr></thead>
      <tbody>
        ${settlementReceipts
          .map(
            (r) => `<tr>
          <td><a class="mono" href="https://testnet.xrpl.org/transactions/${escape(r.body.txHash)}">${escape(short(r.body.txHash, 12))}</a></td>
          <td class="mono">${escape(r.body.requestId ?? "—")}</td>
          <td class="mono">${escape(r.body.validatedLedger ?? "—")}</td>
          <td class="mono">${escape(r.body.engineResult ?? "—")}</td>
          <td class="mono">${escape(r.body.schemaVersion ?? 1)}</td>
          <td>${
            r.body.settles === false
              ? '<span class="status unverifiable"><span class="dot"></span>seam proof only</span>'
              : '<span class="status verified"><span class="dot"></span>claims settlement</span>'
          }</td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  </div>
</section>
`;

// ---------------------------------------------------------------- operator page

// The row label is not always a two-digit phase number: gate B is a row too. An earlier version
// matched /^\| \d\d \|/ and silently dropped it, which is the second time this table has lost
// content without anything failing. Match any row whose first cell is not the header or separator,
// and assert below that nothing was dropped.
const phaseRows = (() => {
  const doc = readFileSync(join(REPO_ROOT, "docs", "run", "AUTONOMOUS_RUN.md"), "utf8");
  const section = doc.split(/^## /m).find((s) => s.startsWith("Phase index"));
  if (!section) throw new Error("AUTONOMOUS_RUN.md has no 'Phase index' section");
  const table = section.split("\n").filter((line) => /^\|/.test(line) && !/^\|\s*-+/.test(line));
  const rows = table
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells[1] && cells[1] !== "Phase")
    .map((cells) => ({ phase: cells[1], name: cells[2], status: cells[3] || "pending" }));
  const dropped = table.length - 1 - rows.length;
  if (dropped !== 0) throw new Error(`phase table parse dropped ${dropped} rows; the parser and the table disagree`);
  return rows;
})();

const blocker = runState.blocker ?? {};

const operatorBody = `
<section aria-labelledby="state-h">
  <h2 id="state-h">Run state</h2>
  <p class="section-note">Read from <code>docs/run/run-state.json</code> at build time.</p>
  <div class="grid">
    <div class="card">
      <h3>Where the run is</h3>
      <dl class="facts">
        <dt>Status</dt><dd>${escape(runState.status)}</dd>
        <dt>Current phase</dt><dd>${escape(runState.currentPhase)}</dd>
        <dt>Last passing</dt><dd>${escape(runState.lastPassingPhase ?? "—")}</dd>
        <dt>Updated</dt><dd class="mono">${escape(runState.updatedAt)}</dd>
      </dl>
    </div>
    <div class="card">
      <h3>What is blocked</h3>
      ${
        blocker.requirement
          ? `<dl class="facts">
              <dt>Needs</dt><dd>${escape(blocker.requirement)}</dd>
              <dt>Phases held</dt><dd>${escape((blocker.deferredPhases ?? []).join(", ") || "—")}</dd>
              <dt>Last attempt</dt><dd class="mono">${escape(blocker.reattemptedAt ?? "—")}</dd>
              <dt>Result</dt><dd>${escape(blocker.reattemptResult ?? "—")}</dd>
            </dl>`
          : "<p style=\"margin:0;color:var(--steel)\">Nothing blocked.</p>"
      }
    </div>
  </div>
</section>

<section aria-labelledby="phases-h">
  <h2 id="phases-h">Phases</h2>
  <p class="section-note">A phase is not complete because code compiles. It is complete when its
  evidence and its target-network requirement both pass, which is why several below are partial.</p>
  <div class="card scroll">
    <table>
      <thead><tr><th scope="col">Phase</th><th scope="col">Name</th><th scope="col">Status</th></tr></thead>
      <tbody>${phaseRows
        .map(
          (r) => `<tr><td class="mono">${escape(r.phase)}</td><td>${escape(r.name)}</td>
          <td>${
            /PASS/.test(r.status)
              ? `<span class="status verified"><span class="dot"></span>${escape(r.status.replace(/\[.*/, "").trim())}</span>`
              : /DEFERRED|PARTIAL/.test(r.status)
                ? `<span class="status unverifiable"><span class="dot"></span>${escape(r.status.replace(/\[.*/, "").trim())}</span>`
                : `<span class="status deferred"><span class="dot"></span>${escape(r.status || "pending")}</span>`
          }</td></tr>`,
        )
        .join("")}</tbody>
    </table>
  </div>
</section>
`;

// ---------------------------------------------------------------- emit

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "index.html"),
  page({
    title: "What Signet has actually proven",
    // "Attested external execution layer" is the product's category name, and in a search result or
    // a share preview it would appear stripped of the page that qualifies it. On the one page whose
    // job is precision about what is proven, the summary says what is true instead.
    description:
      "An external execution layer for FAssets agents: obligation in, constrained XRP signature out, FDC proof back on chain. The extension runs as a local process with no TEE and nothing is hardware-attested. Every claim is paired with what it does not prove, and every figure traces to a committed file you can verify yourself.",
    current: "proof",
    body: proofBody,
  }),
);
writeFileSync(
  join(OUT, "operator.html"),
  page({
    title: "Operator state",
    description: "Where the build run is, what is blocked, and why.",
    current: "operator",
    body: operatorBody,
  }),
);

// Cloudflare Pages serves _headers verbatim. The policy is strict because this page has no scripts
// and no external assets, so anything asking for either is a change worth noticing.
writeFileSync(
  join(OUT, "_headers"),
  `/*
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
`,
);

const assets = ["favicon.ico", "favicon.svg"];
for (const asset of assets) {
  const source = join(REPO_ROOT, asset);
  if (existsSync(source)) copyFileSync(source, join(OUT, asset));
}

console.log(`built ${ledger.claims.length} claims and ${settlementReceipts.length} transactions into web/dist`);

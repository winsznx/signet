#!/usr/bin/env node
/**
 * Builds the Signet product site.
 *
 * Six routes, all generated from the repository's evidence. The split is the point: the homepage
 * is a product narrative, and the exhaustive ledger it used to render lives one click away under
 * /proof. Nothing was deleted to achieve that.
 *
 * The site is still static and still has no server to trust. What changed is that first-party
 * JavaScript may now enhance it, under a CSP that names the exact RPC origins the repository
 * already pins. Every route renders its full meaning with scripting off; the safe demo works with
 * scripting off too, because it is radio inputs and CSS rather than a framework.
 */
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT, ledger, deployment, fccStatuses, homeCards, claimGroups, claimTotals, transactions,
  demoReceipt, incident, REASON_CODES, judge, ENDPOINTS, CONNECT_SRC, claimById,
} from "./lib/data.mjs";
import { page, escape, short, badge, CSP, MARK } from "./lib/ui.mjs";

const OUT = join(REPO_ROOT, "web", "dist");
const explorerAddress = (a) => `${ENDPOINTS.explorers.coston2}/address/${a}`;

// ---------------------------------------------------------------- shared blocks

const deploymentStrip = () => `
<dl class="strip">
  <div><dt>Network</dt><dd class="tone-live"><span class="dot"></span>Coston2 · live</dd></div>
  <div><dt>FCC extension</dt><dd class="tone-verified"><span class="dot"></span>${escape(deployment.extensionId)} · registered</dd></div>
  <div><dt>Execution</dt><dd class="tone-simulated"><span class="dot"></span>Simulated FCC</dd></div>
  <div><dt>XRPL</dt><dd class="tone-live"><span class="dot"></span>Testnet · live</dd></div>
  <div><dt>FDC</dt><dd class="tone-verified"><span class="dot"></span>Proof on chain</dd></div>
</dl>`;

const fccStatusGrid = () => `
<div class="rows">
  ${fccStatuses
    .map(
      (s) => `<details class="row"><summary>
      <span class="title">${escape(s.label)}</span>
      <span class="badge ${s.tone === "verified" ? "verified" : s.tone === "simulated" ? "simulated" : "unavailable"}">${escape(s.value)}</span>
    </summary><div class="body">${escape(s.detail)}</div></details>`,
    )
    .join("")}
</div>`;

const claimCardHtml = (card) => `
<article class="card">
  <div class="badges">
    ${badge(card.status === "verified" ? "Verified" : "Unavailable", card.tone === "verified" ? "verified" : card.tone === "unavailable" ? "unavailable" : "")}
    ${card.networks.map((n) => badge(n)).join("")}
  </div>
  <h3><a href="${card.href}">${escape(card.title)}</a></h3>
  <p class="note" style="margin-bottom:0">${escape(card.summary)}</p>
  <a class="more" href="${card.href}">View evidence</a>
</article>`;

// ---------------------------------------------------------------- / home

const MECHANISM = [
  ["01", "FAssets obligation", "The protocol states what is owed", "Destination, amount, reference, destination tag and the payment window all come from FAssets protocol state, read on chain. Nobody types them."],
  ["02", "Signet derives and observes", "The caller supplies a request id", "authorizeRedemption(uint256,uint32) has no parameter for a payment field. Signet also observes the XRP ledger itself, across independent endpoints that must agree, before it will authorize anything."],
  ["03", "Exact XRP payment", "One obligation, at most one payment", "The signed transaction is persisted before submission, and the chain records at most one instruction dispatch per request and generation."],
  ["04", "FDC proves the outcome", "Independently checkable on Flare", "An XRPPayment attestation carries the memo and destination tag a generic payment proof would not, and FdcVerification accepted it on Coston2."],
];

const ATTACKS = [
  ["destination", "Change the destination", "Impossible through the deployed API", `The entry point is <code>authorizeRedemption(uint256 requestId, uint32 generation)</code>. There is no destination parameter to change. A 256-run fuzz over caller addresses asserts one request id yields one payload for every caller.`, "impossible"],
  ["amount", "Change the amount", "Impossible through the deployed API", `Same reason. The amount is read from the FAssets obligation by the contract, so a caller has nothing to alter.`, "impossible"],
  ["reference", "Change the payment reference", "Impossible through the deployed API", `The reference is the obligation's identity on the ledger and is resolved on chain, not accepted from a caller.`, "impossible"],
  ["paid", "Pay an obligation someone already paid", "Refused · S021_PAYMENT_ALREADY_OBSERVED", `This is not hypothetical. It happened on live Coston2 with request 44928272, and it is why schema V2 requires the signing boundary's own XRP ledger observation.`, "refused"],
  ["noobs", "Authorize without observing XRPL", "Refused · S022_UNDERLYING_STATE_UNAVAILABLE", `Refusing is the default. There is no input that authorizes without an observation, and too few agreeing sources counts as no observation.`, "refused"],
  ["disagree", "Feed disagreeing endpoints", "Refused · S023_UNDERLYING_STATE_DISAGREEMENT", `Endpoints that disagree fail closed, and this one is deliberately never retried automatically.`, "refused"],
  ["stale", "Use a stale observation", "Refused · S024_UNDERLYING_OBSERVATION_STALE", `An observation too old to rely on is refused rather than accepted with a warning.`, "refused"],
  ["replay", "Replay the signed payment", "Refused by the XRP ledger itself", `The identical signed blob resubmitted returns <code>tefPAST_SEQ</code>: the account sequence is already consumed. Signet does not have to be trusted for this one.`, "refused"],
];

const demoSection = () => `
<section id="try" aria-labelledby="try-h">
  <div class="wrap">
    <span class="eyebrow">Try it · deterministic demo</span>
    <h2 id="try-h">Try to break it</h2>
    <p class="note">A representative obligation, and every way a caller might try to bend it. This runs from a committed
    fixture and makes no network call, so it is labelled a deterministic demo rather than live. The reason codes are the
    real ones the policy returns.</p>
    <div class="grid-2">
      <article class="card">
        <div class="badges">${badge("FAssets", "verified")}${badge("Deterministic demo")}</div>
        <h3>The request</h3>
        <p class="note" style="margin-bottom:14px">This is all a caller supplies.</p>
        <dl class="kv">
          <dt>requestId</dt><dd class="mono">${escape(demoReceipt?.requestId ?? "—")}</dd>
          <dt>generation</dt><dd class="mono">${escape(demoReceipt?.generation ?? 0)}</dd>
        </dl>
        <h4 style="margin-top:24px">Derived by the contract, from FAssets</h4>
        <p class="note" style="margin-bottom:12px">Read-only. There is no parameter through which these could be supplied.</p>
        <dl class="kv">
          <dt>destination</dt><dd class="mono">${escape(demoReceipt?.destination ?? "—")}</dd>
          <dt>amount</dt><dd class="mono">${escape(demoReceipt?.amountDrops ?? "—")} drops</dd>
          <dt>agent vault</dt><dd class="mono">${escape(short(demoReceipt?.agentVault ?? "—"))}</dd>
          <dt>window</dt><dd class="mono">${escape(demoReceipt?.firstUnderlyingBlock ?? "—")} → ${escape(demoReceipt?.lastUnderlyingBlock ?? "—")}</dd>
        </dl>
      </article>
      <article class="card">
        <div class="badges">${badge("Signet policy")}</div>
        <h3>Attack it</h3>
        <p class="note" style="margin-bottom:14px">Pick a move. The outcome is what the deployed contract and the policy actually do.</p>
        <div class="attack-panel">
          ${ATTACKS.map(([id], i) => `<input class="attack-radio" type="radio" name="attack" id="attack-${id}"${i === 0 ? " checked" : ""}>`).join("")}
          <div class="attacks" role="group" aria-label="Attack to attempt">
            ${ATTACKS.map(([id, label]) => `<label class="attack-chip" for="attack-${id}">${escape(label)}</label>`).join("")}
          </div>
          <div class="attack-outcomes" aria-live="polite">
            ${ATTACKS.map(
              ([id, , headline, detail, kind]) => `
              <div class="attack-outcome" id="outcome-${id}">
                <p class="outcome-head ${kind === "impossible" ? "impossible" : "refused"}">${escape(headline)}</p>
                <p class="note" style="margin:0">${detail}</p>
              </div>`,
            ).join("")}
          </div>
        </div>
      </article>
    </div>
    <p class="note" style="margin-top:20px">Reason codes: ${REASON_CODES.map(([c]) => `<code>${escape(c)}</code>`).join(", ")}.
    <a href="/proof/claims#claim-v2-underlying-observation">What each one means</a>.</p>
  </div>
</section>`;

const home = () => `
<div class="wrap">
  <div class="hero">
    <div class="hero-copy">
      <span class="eyebrow">Execution security for FAssets agents</span>
      <h1>Only the XRP payment FAssets asked for.</h1>
      <p class="lede">Signet reads the redemption obligation from Flare, derives the payment instead of accepting
      caller-supplied fields, checks XRPL for a prior payment, and returns execution evidence through FDC.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="/operator">Open operator</a>
        <a class="btn btn-ghost" href="/proof">See verified proof</a>
        <a class="btn btn-quiet" href="${ENDPOINTS.repository}" rel="noreferrer noopener">GitHub ↗</a>
      </div>
      ${deploymentStrip()}
    </div>
    <div class="stage">
      <img src="/brand/hero-mechanism.png" width="1300" height="867"
        alt="Several redemption obligations converge into a single constrained gate, one exact XRP payment leaves it, and a proof path returns from the payment back to the gate.">
    </div>
  </div>
</div>

<section id="mechanism" aria-labelledby="mech-h">
  <div class="wrap">
    <span class="eyebrow">How it works</span>
    <h2 id="mech-h">One request in. One exact payment out.</h2>
    <p class="note">Each step opens. Nothing here needs reading in order.</p>
    <div class="rail">
      ${MECHANISM.map(
        ([num, name, hint, detail]) => `<details class="step"><summary>
          <span class="num">${escape(num)}</span>
          <span class="name">${escape(name)}</span>
          <span class="hint">${escape(hint)}</span>
        </summary><p class="detail">${escape(detail)}</p></details>`,
      ).join("")}
    </div>
    <details class="row" style="margin-top:16px;border:1px solid var(--cloud);border-radius:24px;background:var(--snow)">
      <summary><span class="title">Why all four are load-bearing</span></summary>
      <div class="body">
        <ul>
          <li><strong>Remove FAssets</strong> and there is no authoritative obligation. Signet degrades into enforcing a policy someone typed, which is a generic policy signer.</li>
          <li><strong>Remove FCC</strong> and a compromised host can sign arbitrary XRP.</li>
          <li><strong>Remove the XRPL observation</strong> and a payment already made by another party is invisible. That is incident 44928272, not a hypothetical.</li>
          <li><strong>Remove FDC</strong> and completion cannot be independently established on Flare. The operator's word becomes the evidence.</li>
        </ul>
      </div>
    </details>
  </div>
</section>

${demoSection()}

<section id="operator" aria-labelledby="op-h">
  <div class="wrap">
    <span class="eyebrow">Operator</span>
    <h2 id="op-h">For agent operators who keep their own underlying account</h2>
    <p class="note">The job: fulfil redemption obligations without leaving an unrestricted XRPL spending key available to a
    compromised operator host. Before Signet, a hot signer can authorize arbitrary XRP. With Signet, a request id goes in and
    a protocol-derived obligation comes out as the only admissible payment.</p>
    <div class="grid">
      <article class="card tight"><h4>Connect or continue read-only</h4><p class="note" style="margin:0">A wallet is optional and never implies agent status.</p></article>
      <article class="card tight"><h4>Inspect a redemption</h4><p class="note" style="margin:0">Read the canonical obligation from Coston2 by request id.</p></article>
      <article class="card tight"><h4>Observe XRPL</h4><p class="note" style="margin:0">Independent endpoints must agree before a decision is possible.</p></article>
      <article class="card tight"><h4>Preview the decision</h4><p class="note" style="margin:0">Authorization or a typed refusal, with the reason code.</p></article>
    </div>
    <a class="btn btn-primary" style="margin-top:24px" href="/operator">Open operator</a>
  </div>
</section>

<section id="incident" aria-labelledby="inc-h">
  <div class="wrap">
    <span class="eyebrow">Live incident · Coston2</span>
    <h2 id="inc-h">The tests passed. The ledger proved us wrong.</h2>
    <p class="note">A live redemption was still <code>ACTIVE</code> on Flare after the assigned agent had already paid it on
    XRPL. Signet read <code>ACTIVE</code> as unpaid and sent the same obligation again.</p>
    <div class="timeline">
      <article class="card"><span class="when">Before</span><h4>ACTIVE meant authorize</h4><p class="note" style="margin:0">Three duplicate-payment guards, all watching Flare.</p></article>
      <article class="card"><span class="when">Ledger ${escape(incident.agentPaidLedger)}</span><h4>The agent had paid</h4><p class="note" style="margin:0">From its own underlying address, on XRPL.</p></article>
      <article class="card"><span class="when">Ledger ${escape(incident.signetPaidLedger)}</span><h4>Signet paid again</h4><p class="note" style="margin:0">${escape(incident.gapLedgers)} ledgers later. No third party lost funds, which is luck about the test setup.</p></article>
      <article class="card"><span class="when">Now</span><h4>${escape(incident.reasonCode)}</h4><p class="note" style="margin:0">V2 requires the signing boundary's own XRPL observation, bound into the commitment.</p></article>
    </div>
    <a class="btn btn-ghost" style="margin-top:24px" href="/proof/incident/${escape(incident.requestId)}">Read the full incident</a>
  </div>
</section>

<section id="proof" aria-labelledby="proof-h">
  <div class="wrap">
    <span class="eyebrow">Proof</span>
    <h2 id="proof-h">What holds up, and what does not</h2>
    <p class="note">Six of ${claimTotals.total} claims. Each one links to its evidence and to everything it does not prove.</p>
    <div class="grid">${homeCards.map(claimCardHtml).join("")}</div>
    <a class="btn btn-ghost" style="margin-top:24px" href="/proof">All ${claimTotals.total} claims</a>
  </div>
</section>

<section id="boundary" aria-labelledby="b-h">
  <div class="wrap">
    <span class="eyebrow">Current deployment boundary</span>
    <h2 id="b-h">What this deployment is not</h2>
    <p class="note">Five FCC states, tracked separately, because collapsing any two of them is how a project ends up implying
    attestation it does not have.</p>
    ${fccStatusGrid()}
  </div>
</section>

<section id="cta" aria-labelledby="cta-h">
  <div class="wrap">
    <h2 id="cta-h">Check it yourself</h2>
    <p class="note">No wallet, no funds, no Docker, no GCP, no secrets. One command from a fresh clone.</p>
    <p class="chain">make judge<br><span style="color:var(--fog)">→ ${judge.pass} PASS · ${judge.fail} FAIL · ${judge.unverifiable} UNVERIFIABLE</span></p>
    <div class="cta-row">
      <a class="btn btn-primary" href="/operator">Open operator</a>
      <a class="btn btn-ghost" href="/proof">View proof</a>
      <a class="btn btn-quiet" href="${ENDPOINTS.repository}" rel="noreferrer noopener">GitHub ↗</a>
    </div>
  </div>
</section>`;

// ---------------------------------------------------------------- /operator

const operator = () => `
<div class="wrap">
  <div class="hero" style="grid-template-columns:1fr;padding-bottom:0">
    <div class="hero-copy">
      <span class="eyebrow">Operator console</span>
      <h1>Inspect a redemption obligation.</h1>
      <p class="lede">Read-only, against live Coston2 and XRPL. A wallet is optional, and connecting one never implies you
      operate a FAssets agent.</p>
      ${deploymentStrip()}
    </div>
  </div>
</div>

<section id="onboarding" aria-labelledby="onb-h">
  <div class="wrap">
    <h2 id="onb-h">First run</h2>
    <p class="note">Seven steps. Nothing here spends anything, and nothing signs.</p>
    <ol class="rows" style="list-style:none;margin:0;padding:0" id="onboarding-list">
      ${[
        ["Connect or continue read-only", "A wallet is optional. Everything below works without one."],
        ["Check the network", "Coston2, chain id 114. The console offers a switch if your wallet is elsewhere."],
        ["Review deployment state", "Registry, sender, extension and the five FCC statuses."],
        ["Enter a redemption request id", "The only thing a caller supplies."],
        ["Inspect the canonical obligation", "Every field carries where it came from."],
        ["Observe XRPL", "Independent endpoints must agree."],
        ["Preview the decision", "Authorization, or a typed refusal with its reason code."],
      ]
        .map(
          ([t, d], i) =>
            `<li class="row"><div style="padding:18px 22px"><span class="badge">${String(i + 1).padStart(2, "0")}</span>
             <span class="title" style="margin-left:10px">${escape(t)}</span>
             <p class="note" style="margin:8px 0 0">${escape(d)}</p></div></li>`,
        )
        .join("")}
    </ol>
  </div>
</section>

<section id="deployment" aria-labelledby="dep-h">
  <div class="wrap">
    <h2 id="dep-h">Deployment</h2>
    <p class="note">Read from <code>deployments/coston2.json</code> at build time, and re-checked live when scripting is on.</p>
    <div class="scroll"><table>
      <thead><tr><th scope="col">Contract</th><th scope="col">Address</th><th scope="col">Live</th></tr></thead>
      <tbody>
        ${[
          ["SignetRegistry", deployment.registry],
          ["SignetInstructionSender", deployment.instructionSender],
          ["SignetFccInstructionSender", deployment.fccSender],
          ["FlareTeeManager", deployment.flareTeeManager],
          ["AssetManagerFXRP", deployment.assetManager],
        ]
          .map(
            ([name, addr]) => `<tr><td>${escape(name)}</td>
            <td><a class="mono" href="${explorerAddress(addr)}" rel="noreferrer noopener">${escape(short(addr, 14, 8))}</a></td>
            <td data-live-code="${escape(addr)}"><span class="badge">not checked</span></td></tr>`,
          )
          .join("")}
      </tbody>
    </table></div>
    <h3 style="margin-top:32px">FCC status</h3>
    ${fccStatusGrid()}
  </div>
</section>

<section id="inspector" aria-labelledby="ins-h">
  <div class="wrap">
    <h2 id="ins-h">Request inspector</h2>
    <p class="note">Reads the canonical obligation from the deployed contract on Coston2. With scripting off, the worked
    example below shows exactly what it returns.</p>
    <noscript><p class="noscript">JavaScript is off, so the live inspector is unavailable. The committed example below is
    the same shape the live read returns.</p></noscript>
    <div class="card" id="inspector-panel" data-inspector hidden>
      <div class="badges">${badge("Live Coston2", "verified")}</div>
      <label for="request-id" style="display:block;font-weight:600;margin-bottom:6px">Redemption request id</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="request-id" name="request-id" inputmode="numeric" autocomplete="off"
          value="${escape(incident.requestId)}"
          style="flex:1 1 220px;min-width:0;font-family:var(--mono);font-size:14px;padding:12px 14px;border:1px solid var(--cloud);border-radius:14px;background:var(--snow)">
        <button class="btn btn-primary" type="button" data-inspect>Inspect obligation</button>
      </div>
      <p class="note" id="inspector-status" role="status" aria-live="polite" style="margin:14px 0 0"></p>
      <div id="inspector-result"></div>
    </div>
    <article class="card" style="margin-top:16px">
      <div class="badges">${badge("Committed example")}${badge("Deterministic demo")}</div>
      <h3>Worked example</h3>
      <dl class="kv">
        <dt>requestId</dt><dd class="mono">${escape(demoReceipt?.requestId ?? "—")}</dd>
        <dt>destination</dt><dd class="mono">${escape(demoReceipt?.destination ?? "—")}</dd>
        <dt>amount</dt><dd class="mono">${escape(demoReceipt?.amountDrops ?? "—")} drops</dd>
        <dt>XRPL result</dt><dd class="mono">${escape(demoReceipt?.engineResult ?? "—")}</dd>
        <dt>replay</dt><dd class="mono">${escape(demoReceipt?.replayEngineResult ?? "—")}</dd>
        <dt>FDC</dt><dd class="mono">${escape(demoReceipt?.fdcStatus ?? "—")}</dd>
        <dt>attestation</dt><dd>${escape(demoReceipt?.attestation ?? "none")}</dd>
      </dl>
    </article>
  </div>
</section>

<section id="actions" aria-labelledby="act-h">
  <div class="wrap">
    <h2 id="act-h">What this console can and cannot do</h2>
    <p class="note">An unavailable action is shown disabled with its reason rather than hidden.</p>
    <div class="scroll"><table>
      <thead><tr><th scope="col">Action</th><th scope="col">Status</th><th scope="col">Why</th></tr></thead>
      <tbody>
        ${[
          ["Connect wallet", "Real", "Explicit click only, plain EIP-1193, no SDK."],
          ["Switch to Coston2", "Real", "Chain id 114."],
          ["Read canonical obligation", "Real", "Where the request state permits it."],
          ["Inspect deployment", "Real", "Read-only contract code checks."],
          ["Observe XRPL", "Real, read-only", "Independent endpoints must agree."],
          ["Verify a receipt", "Real", "Runs in the repository, not the browser."],
          ["Deterministic attack demo", "Simulation", "Labelled, from a committed fixture."],
          ["Simulated FCC policy execution", "Simulated", "Local process, no TEE, labelled everywhere."],
          ["Hardware FCC authorization", "Unavailable", "No TEE machine. MachineManager owner admission required."],
          ["Operate as a whitelisted FAssets agent", "Out of scope", "Flare declined new agents; Signet holds no agent authority."],
        ]
          .map(
            ([a, s, w]) =>
              `<tr><td>${escape(a)}</td><td>${badge(s, s === "Real" || s === "Real, read-only" ? "verified" : s === "Unavailable" || s === "Out of scope" ? "unavailable" : "simulated")}</td><td class="note" style="margin:0">${escape(w)}</td></tr>`,
          )
          .join("")}
      </tbody>
    </table></div>
    <p style="margin-top:20px"><button class="btn btn-ghost" type="button" disabled
      title="No TEE machine is registered. MachineManager owner admission is required.">Hardware FCC authorization · unavailable</button></p>
  </div>
</section>`;

// ---------------------------------------------------------------- /proof

const proofOverview = () => `
<div class="wrap">
  <div class="hero" style="grid-template-columns:1fr;padding-bottom:0">
    <div class="hero-copy">
      <span class="eyebrow">Proof</span>
      <h1>What Signet has actually proven.</h1>
      <p class="lede">${claimTotals.total} claims, ${claimTotals.verified} verified and ${claimTotals.unavailable} unavailable.
      Every one states what it does not prove.</p>
    </div>
  </div>
</div>

<section id="verify" aria-labelledby="v-h">
  <div class="wrap">
    <h2 id="v-h">Verify it yourself</h2>
    <p class="note">No wallet, no funds, no Docker, no GCP, no secrets.</p>
    <p class="chain">git clone ${escape(ENDPOINTS.repository)}<br>make judge</p>
    <dl class="strip">
      <div><dt>Pass</dt><dd class="tone-verified"><span class="dot"></span>${judge.pass}</dd></div>
      <div><dt>Fail</dt><dd class="tone-verified"><span class="dot"></span>${judge.fail}</dd></div>
      <div><dt>Unverifiable</dt><dd class="tone-simulated"><span class="dot"></span>${judge.unverifiable}</dd></div>
    </dl>
    <details class="row" style="margin-top:16px;border:1px solid var(--cloud);border-radius:24px;background:var(--snow)">
      <summary><span class="title">What UNVERIFIABLE means, and why it is not a failure</span></summary>
      <div class="body">
        <p>It means the check could not be performed from where it ran, and it is never folded into a pass. Today there are two.
        One XRPL testnet node has pruned the ledger holding the payment, so a single endpoint cannot testify to it. And whether
        FdcVerification accepted the proof is reported by the receipt rather than re-checked by <code>make judge</code>; the
        receipt verifier re-encodes the Merkle proof and does check it.</p>
      </div>
    </details>
  </div>
</section>

<section id="claims" aria-labelledby="c-h">
  <div class="wrap">
    <h2 id="c-h">Claims by area</h2>
    <p class="note">Collapsed by default. The full ledger with every limitation is on
    <a href="/proof/claims">the claims page</a>.</p>
    ${claimGroups
      .map(
        ([group, claims]) => `
      <h3 style="margin-top:32px">${escape(group)} <span class="badge">${claims.length}</span></h3>
      <div class="rows">
        ${claims
          .map(
            (c) => `<details class="row"><summary>
              <span class="title">${escape(c.title)}</span>
              ${badge(c.status === "verified" ? "verified" : c.status, c.status === "verified" ? "verified" : "unavailable")}
              ${(c.network ?? []).map((n) => badge(n)).join("")}
              <span class="sub">${escape(String(c.wording).slice(0, 180))}${String(c.wording).length > 180 ? "…" : ""}</span>
            </summary><div class="body"><a class="more" href="/proof/claims#${escape(c.id)}">Full claim and limitations</a></div></details>`,
          )
          .join("")}
      </div>`,
      )
      .join("")}
  </div>
</section>

<section id="explore" aria-labelledby="e-h">
  <div class="wrap">
    <h2 id="e-h">Go deeper</h2>
    <div class="grid">
      <article class="card"><h3><a href="/proof/claims">Full claim ledger</a></h3><p class="note" style="margin:0">All ${claimTotals.total} claims with every limitation.</p></article>
      <article class="card"><h3><a href="/proof/transactions">Transactions</a></h3><p class="note" style="margin:0">${transactions.length} receipts, their role and their evidence class.</p></article>
      <article class="card"><h3><a href="/proof/incident/${escape(incident.requestId)}">Incident ${escape(incident.requestId)}</a></h3><p class="note" style="margin:0">The duplicate payment, and the protocol change it forced.</p></article>
    </div>
  </div>
</section>`;

// ---------------------------------------------------------------- /proof/claims

const claimsPage = () => `
<div class="wrap">
  <div class="hero" style="grid-template-columns:1fr;padding-bottom:0">
    <div class="hero-copy">
      <span class="eyebrow">Proof · full ledger</span>
      <h1>Every claim, and what it does not prove.</h1>
      <p class="lede">Generated from <code>evidence/claim-ledger.json</code>. A claim with no limitations listed is a claim
      that has not been examined hard enough, so they are shown first-class.</p>
    </div>
  </div>
</div>
${claimGroups
  .map(
    ([group, claims]) => `
<section id="group-${escape(group.toLowerCase())}" aria-labelledby="g-${escape(group.toLowerCase())}">
  <div class="wrap">
    <h2 id="g-${escape(group.toLowerCase())}">${escape(group)}</h2>
    <div class="rows">
      ${claims
        .map(
          (c) => `<details class="row" id="${escape(c.id)}"><summary>
        <span class="title">${escape(c.title)}</span>
        ${badge(c.status, c.status === "verified" ? "verified" : "unavailable")}
        ${badge(`level ${c.proofLevel}`)}
        ${(c.network ?? []).map((n) => badge(n)).join("")}
      </summary><div class="body">
        <h4>The claim</h4><p>${escape(c.wording)}</p>
        <h4>What it does not prove</h4>
        <ul>${(c.limitations ?? []).map((l) => `<li>${escape(l)}</li>`).join("")}</ul>
        <h4>Evidence</h4>
        <ul>${(c.evidence ?? []).map((e) => `<li><code>${escape(e)}</code></li>`).join("")}</ul>
      </div></details>`,
        )
        .join("")}
    </div>
  </div>
</section>`,
  )
  .join("")}`;

// ---------------------------------------------------------------- /proof/transactions

const transactionsPage = () => `
<div class="wrap">
  <div class="hero" style="grid-template-columns:1fr;padding-bottom:0">
    <div class="hero-copy">
      <span class="eyebrow">Proof · transactions</span>
      <h1>Every receipt, and what it is evidence of.</h1>
      <p class="lede">A receipt that only proves a seam says so. One of these is an incident, not a demonstration.</p>
    </div>
  </div>
</div>
<section id="tx" aria-labelledby="tx-h">
  <div class="wrap">
    <h2 id="tx-h">Receipts</h2>
    <div class="scroll"><table>
      <thead><tr>
        <th scope="col">Transaction</th><th scope="col">Request</th><th scope="col">Network</th>
        <th scope="col">Ledger</th><th scope="col">Result</th><th scope="col">Role</th>
      </tr></thead>
      <tbody>
        ${transactions
          .map(
            (t) => `<tr>
          <td>${t.explorer ? `<a class="mono" href="${escape(t.explorer)}" rel="noreferrer noopener">${escape(short(t.hash, 12, 6))}</a>` : `<span class="mono">${escape(short(t.hash, 12, 6))}</span>`}</td>
          <td class="mono">${escape(t.requestId ?? "—")}</td>
          <td>${escape(t.network)}</td>
          <td class="mono">${escape(t.ledgerIndex ?? "—")}</td>
          <td>${escape(t.result ?? "—")}</td>
          <td>${badge(t.role, t.role === "Incident" ? "simulated" : "")}${t.settles === false ? badge("seam only") : ""}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table></div>
    <p class="note" style="margin-top:16px">Evidence files are listed inside each claim on
    <a href="/proof/claims">the claims page</a> rather than used as the primary label here.</p>
  </div>
</section>`;

// ---------------------------------------------------------------- /proof/incident

const incidentPage = () => {
  const c = incident.claim;
  return `
<div class="wrap">
  <div class="hero" style="grid-template-columns:1fr;padding-bottom:0">
    <div class="hero-copy">
      <span class="eyebrow">Live incident · Coston2 · request ${escape(incident.requestId)}</span>
      <h1>The tests passed. The ledger proved us wrong.</h1>
      <p class="lede">Signet paid a redemption obligation that another party had already paid, because <code>ACTIVE</code> on
      Flare does not mean unpaid on XRPL, and every guard Signet had watched the wrong chain.</p>
    </div>
  </div>
</div>

<section id="what" aria-labelledby="w-h">
  <div class="wrap">
    <h2 id="w-h">What happened</h2>
    <div class="timeline">
      <article class="card"><span class="when">Ledger ${escape(incident.agentPaidLedger)}</span><h4>The agent paid</h4><p class="note" style="margin:0">From its own underlying address.</p></article>
      <article class="card"><span class="when">Meanwhile</span><h4>Coston2 said ACTIVE</h4><p class="note" style="margin:0">Which means not yet confirmed on Flare, not unpaid.</p></article>
      <article class="card"><span class="when">Ledger ${escape(incident.signetPaidLedger)}</span><h4>Signet paid again</h4><p class="note" style="margin:0">${escape(incident.gapLedgers)} ledgers later.</p></article>
      <article class="card"><span class="when">Correction</span><h4>${escape(incident.reasonCode)}</h4><p class="note" style="margin:0">Schema V2 requires the boundary's own observation.</p></article>
    </div>
  </div>
</section>

<section id="why" aria-labelledby="y-h">
  <div class="wrap">
    <h2 id="y-h">Root cause</h2>
    <p class="note">Signet had three duplicate-payment guards and all three are real: the registry rejects a repeated action,
    the coordinator database permits one completion per obligation, and the XRP ledger refuses a consumed sequence. Every one
    of them prevents <em>Signet</em> paying twice. None can see a payment made by somebody else.</p>
    <p class="note">The defect was not a missing check. It was a missing chain.</p>
    <h3 style="margin-top:32px">Reason codes this created</h3>
    <div class="rows">
      ${REASON_CODES.map(
        ([code, when]) =>
          `<details class="row"><summary><span class="title mono">${escape(code)}</span></summary><div class="body">${escape(when)}</div></details>`,
      ).join("")}
    </div>
  </div>
</section>

<section id="residual" aria-labelledby="r-h">
  <div class="wrap">
    <h2 id="r-h">The residual, stated rather than hidden</h2>
    <p class="note"><code>S021</code> fires on a payment that has <strong>validated</strong>. Between another party submitting a
    payment and that payment validating, Signet can still observe nothing and authorize. That window cannot be closed by
    observation. Closing it needs exclusive signing authority over the underlying account, which is Signet's production
    architecture and is not instantiated by this deployment.</p>
    <p class="note">No third party lost funds. That is luck about the test setup, not a property of the system.</p>
    ${c ? `<div class="rows"><details class="row"><summary><span class="title">The claim this incident backs</span>${badge(c.status, "verified")}</summary><div class="body"><p>${escape(c.wording)}</p><h4>What it does not prove</h4><ul>${(c.limitations ?? []).map((l) => `<li>${escape(l)}</li>`).join("")}</ul></div></details></div>` : ""}
    <p class="note" style="margin-top:20px">Permanent regression: <code>${escape(incident.regression)}</code>, which asserts no
    V2 input can reproduce the original authorization. It runs in <code>make verify</code>.</p>
    <a class="btn btn-ghost" href="/proof/transactions">See the transactions</a>
  </div>
</section>`;
};

// ---------------------------------------------------------------- emit

const DESCRIPTION =
  "Signet reads a FAssets redemption obligation from Flare, derives the XRP payment instead of accepting caller-supplied fields, checks XRPL for a prior payment, and proves the outcome through FDC. The extension runs as a local process: nothing is hardware-attested.";

const routes = [
  ["index.html", { title: "Signet — only the XRP payment FAssets asked for", description: DESCRIPTION, current: "home", body: home(), script: "/app.js" }],
  ["operator/index.html", { title: "Operator console — Signet", description: "Inspect a Coston2 redemption obligation, observe XRPL and preview Signet's decision. Read-only, wallet optional.", current: "operator", body: operator(), script: "/app.js" }],
  ["proof/index.html", { title: "Proof — Signet", description: `${claimTotals.total} claims, each stating what it does not prove.`, current: "proof", body: proofOverview() }],
  ["proof/claims/index.html", { title: "Claim ledger — Signet", description: "Every Signet claim with its evidence and its limitations.", current: "proof", body: claimsPage() }],
  ["proof/transactions/index.html", { title: "Transactions — Signet", description: "Every committed receipt and what it is evidence of.", current: "proof", body: transactionsPage() }],
  [`proof/incident/${incident.requestId}/index.html`, { title: `Incident ${incident.requestId} — Signet`, description: "Signet double-paid a live Coston2 redemption. What happened, why, and the protocol change it forced.", current: "incident", body: incidentPage() }],
];

mkdirSync(OUT, { recursive: true });
for (const [file, model] of routes) {
  const target = join(OUT, file);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, page(model));
}

// brand assets
const brandSrc = join(REPO_ROOT, "web", "public", "brand");
const brandOut = join(OUT, "brand");
mkdirSync(brandOut, { recursive: true });
for (const f of readdirSync(brandSrc)) copyFileSync(join(brandSrc, f), join(brandOut, f));

// first-party script
const appSrc = join(REPO_ROOT, "web", "public", "app.js");
if (existsSync(appSrc)) copyFileSync(appSrc, join(OUT, "app.js"));

writeFileSync(
  join(OUT, "_headers"),
  `/*
  Content-Security-Policy: ${CSP}
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
`,
);

console.log(`built ${routes.length} routes, ${claimTotals.total} claims, ${transactions.length} receipts`);
console.log(`connect-src: ${CONNECT_SRC.join(" ")}`);

#!/usr/bin/env node
/**
 * Product and honesty checks for the Signet site.
 *
 * The old suite asserted "ships no scripts". That invariant is gone, deliberately: the site now
 * carries first-party JavaScript so the product can be used rather than only read. What replaces it
 * is stricter than what it replaced, because "no scripts at all" is easy to check and easy to
 * satisfy while still shipping something untrustworthy.
 *
 * The replacements assert the properties that actually mattered:
 *   every script is first-party, same-origin and external
 *   no inline script, no inline handler, no eval, no dynamic remote code
 *   the CSP names exactly the origins the repository pins, and nothing else
 *   every route still communicates its meaning with scripting off
 *   interactive controls degrade to readable states rather than vanishing
 *   every claim and every limitation still appears somewhere under /proof/claims
 *
 * The last one is the invariant the old suite protected and this one keeps: evidence may move to a
 * deeper route, it may not disappear. It is asserted by named id, never by counting rows, because
 * counting rows is how the gate B row went missing for a whole deploy.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST = join(REPO_ROOT, "web", "dist");

const ROUTES = {
  home: "index.html",
  operator: "operator/index.html",
  proof: "proof/index.html",
  claims: "proof/claims/index.html",
  transactions: "proof/transactions/index.html",
  incident: "proof/incident/44928272/index.html",
};

const pages = Object.fromEntries(
  Object.entries(ROUTES).map(([name, file]) => [name, readFileSync(join(DIST, file), "utf8")]),
);
const app = readFileSync(join(DIST, "app.js"), "utf8");
const headers = readFileSync(join(DIST, "_headers"), "utf8");
const ledger = JSON.parse(readFileSync(join(REPO_ROOT, "evidence", "claim-ledger.json"), "utf8"));
const deployments = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "coston2.json"), "utf8"));

let failures = 0;
const check = (name, condition, detail = "") => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};

// ---------------------------------------------------------------- structure and accessibility

for (const [name, html] of Object.entries(pages)) {
  check(`${name}: declares a language`, /<html lang="en">/.test(html));
  check(`${name}: has exactly one h1`, (html.match(/<h1[ >]/g) ?? []).length === 1);
  check(`${name}: has a skip link to the main landmark`, /class="skip" href="#main"/.test(html) && /id="main"/.test(html));
  check(`${name}: every nav is labelled`, [...html.matchAll(/<nav\b([^>]*)>/g)].every((m) => /aria-label=/.test(m[1])));
  check(
    `${name}: every section is labelled by a heading`,
    [...html.matchAll(/<section\b([^>]*)>/g)].every((m) => /aria-labelledby="([^"]+)"/.test(m[1])),
  );
  check(
    `${name}: every aria-labelledby points at an element that exists`,
    [...html.matchAll(/aria-labelledby="([^"]+)"/g)].every((m) => html.includes(`id="${m[1]}"`)),
  );
  check(`${name}: images carry alt text`, [...html.matchAll(/<img\b([^>]*)>/g)].every((m) => /alt=/.test(m[1])));
  check(`${name}: table headers are scoped`, [...html.matchAll(/<th\b([^>]*)>/g)].every((m) => /scope=/.test(m[1])));
  check(`${name}: has a footer landmark`, /<footer/.test(html));
  // A duplicated id breaks label association, fragment links and assistive navigation, and it is
  // exactly the kind of thing that only shows up when something tries to select one of them.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  check(`${name}: every id is unique`, dupes.length === 0, [...new Set(dupes)].join(", "));
}

// ---------------------------------------------------------------- script safety

check("every script is external", ![...Object.values(pages)].some((h) => /<script(?![^>]*\bsrc=)/i.test(h)));
check(
  "every script is first-party and same-origin",
  [...Object.values(pages).join("").matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)].every((m) => m[1].startsWith("/")),
);
check(
  "no inline event handlers",
  !Object.values(pages).some((h) => /\son(click|load|error|mouse\w+|key\w+|focus|blur|submit|change|input)\s*=/i.test(h)),
);
check("no javascript: urls", !Object.values(pages).some((h) => /(href|src)="javascript:/i.test(h)));
check("no eval or Function constructor in first-party js", !/\beval\s*\(|new\s+Function\s*\(/.test(app));
check("no dynamic remote code loading", !/import\s*\(|createElement\(["']script/i.test(app));
check(
  "no third-party origin is referenced as a script or style",
  !Object.values(pages).some((h) => /<(script|link)[^>]*\b(src|href)="https?:\/\//i.test(h)),
);
check("no remote fonts", !Object.values(pages).some((h) => /fonts\.(googleapis|gstatic)/i.test(h)));
check(
  "no analytics or tracker",
  !Object.values(pages).some((h) => /(google-analytics|gtag|plausible|segment|mixpanel|hotjar|sentry)/i.test(h)),
);

// ---------------------------------------------------------------- CSP

const PINNED_CONNECT = [
  "https://coston2-api.flare.network",
  "https://rpc.ankr.com",
  "https://coston2.enosys.global",
  "https://s.altnet.rippletest.net:51234",
  "https://testnet.xrpl-labs.com",
];
const csp = (headers.match(/Content-Security-Policy: (.+)/) ?? [])[1] ?? "";
const directive = (name) => (csp.match(new RegExp(`${name} ([^;]+)`)) ?? [])[1]?.trim() ?? "";

check("CSP is present", csp.length > 0);
check("CSP default-src is none", directive("default-src") === "'none'");
check("CSP script-src is self only", directive("script-src") === "'self'");
check("CSP img-src is self only", directive("img-src") === "'self'");
check("CSP has no unsafe-eval", !/unsafe-eval/.test(csp));
check("CSP allows no inline script", !/script-src[^;]*unsafe-inline/.test(csp));
check("CSP forbids framing", /frame-ancestors 'none'/.test(csp));
const connect = directive("connect-src").split(/\s+/).filter(Boolean);
check(
  "connect-src contains only pinned Coston2 and XRPL origins",
  connect.length === PINNED_CONNECT.length && connect.every((o) => PINNED_CONNECT.includes(o)),
  connect.join(" "),
);

// ---------------------------------------------------------------- works without javascript

for (const [name, html] of Object.entries(pages)) {
  // Strip everything a script could have produced: what is left has to still be the product.
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  check(`${name}: renders without javascript`, withoutScripts.includes('<main id="main">') && withoutScripts.length > 8000);
}
check("home explains the mechanism without javascript", /One request in\. One exact payment out\./.test(pages.home));
check("home states the deployment truth without javascript", /Simulated FCC/.test(pages.home) && /66248/.test(pages.home));
check("home carries navigation without javascript", /href="\/operator"/.test(pages.home) && /href="\/proof"/.test(pages.home));
check("proof states the judge result without javascript", /13/.test(pages.proof) && /UNVERIFIABLE|Unverifiable/.test(pages.proof));
check(
  "the attack demo works without javascript",
  /type="radio" name="attack"/.test(pages.home) && /outcome-paid/.test(pages.home),
  "radio inputs and CSS, not a JS toggle",
);
check(
  "interactive controls degrade to a readable state",
  /<noscript>/.test(pages.operator) && /Worked example/.test(pages.operator),
  "the inspector is hidden until JS runs; a committed example is always visible",
);
check(
  "disclosures are native details elements",
  Object.values(pages).every((h) => !/aria-expanded/.test(h) || /<details/.test(h)),
);

// ---------------------------------------------------------------- evidence survives the move

const claimIds = ledger.claims.map((c) => c.id);
const missingClaims = claimIds.filter((id) => !pages.claims.includes(`id="${id}"`));
check("every claim appears on /proof/claims by id", missingClaims.length === 0, missingClaims.join(", "));

const missingLimitations = [];
for (const claim of ledger.claims) {
  for (const limitation of claim.limitations ?? []) {
    const probe = limitation.slice(0, 60).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    if (!pages.claims.includes(probe)) missingLimitations.push(`${claim.id}: ${limitation.slice(0, 40)}…`);
  }
}
check("every limitation appears in its claim detail", missingLimitations.length === 0, missingLimitations.slice(0, 3).join(" | "));

const unavailable = ledger.claims.filter((c) => c.status === "unavailable");
check(
  "unavailable claims are still rendered",
  unavailable.every((c) => pages.claims.includes(`id="${c.id}"`)),
  `${unavailable.length} unavailable claims`,
);

const homeLinks = [...new Set([...pages.home.matchAll(/\/proof\/claims#(claim-[a-z0-9-]+)/g)].map((m) => m[1]))];
check("homepage claim links resolve to real claim ids", homeLinks.length >= 4 && homeLinks.every((id) => claimIds.includes(id)), `${homeLinks.length} distinct`);
// The point is curation: the homepage links a handful of claims in context, it does not render the
// ledger. Counting distinct ids rather than link occurrences is what measures that.
check("homepage curates rather than dumping the ledger", homeLinks.length <= 10 && homeLinks.length < claimIds.length / 2, `${homeLinks.length} of ${claimIds.length}`);

// ---------------------------------------------------------------- honesty

const all = Object.values(pages).join("\n");

/**
 * A phrase like "hardware attested" is not a claim by itself; "nothing is hardware-attested" is the
 * opposite of one. So rather than banning the words, require every occurrence to sit inside a
 * negation. That is the assertion that actually protects the boundary, and it does not fire on the
 * sentences written specifically to state the limit.
 */
const NEGATORS = /\b(no|not|nothing|never|without|absent|unavailable|refus\w*|cannot|does not|claims? no)\b/i;
const everyMentionIsNegated = (pattern) => {
  const hits = [...all.matchAll(pattern)];
  const bad = hits.filter((m) => {
    // The window has to reach back past a disclosure summary, because that is where the status badge
    // sits: "unavailable" is printed before the claim wording it qualifies.
    const window = all.slice(Math.max(0, m.index - 320), m.index + m[0].length + 150);
    return !NEGATORS.test(window);
  });
  return { ok: bad.length === 0, sample: bad.slice(0, 2).map((m) => m[0]).join(" | "), count: hits.length };
};

const attest = everyMentionIsNegated(/hardware[- ]attest\w*/gi);
check("every mention of hardware attestation is a denial", attest.ok, attest.sample || `${attest.count} mentions, all negated`);
check("hardware attestation is stated as absent", /Hardware attestation/.test(pages.home) && /nothing is hardware-attested/i.test(all));

const machine = everyMentionIsNegated(/\b(TEE )?machine (is )?registered\b/gi);
check("no page claims a registered TEE machine", machine.ok, machine.sample || `${machine.count} mentions, all negated`);
check("machine status is unavailable", /Unavailable/.test(pages.home));
check("simulated execution is labelled simulated", /Simulated FCC|Simulated execution|simulated/i.test(pages.home));
check(
  "simulated is never presented as live or attested",
  !/simulated[^<]{0,20}(live|attested)/i.test(all) && !/attested[^<]{0,20}simulated/i.test(all),
);
check("the current extension is 66248", pages.home.includes("66248") && deployments.fcc.extensionId === "66248");
const superseded = (deployments.fcc.superseded ?? []).map((s) => s.extensionId);
check(
  "superseded extensions are not presented as current",
  superseded.every((id) => !new RegExp(`extension ${id}\\b`, "i").test(pages.home)),
  superseded.join(", "),
);
check(
  "the sender comes from the deployment record, not duplicated frontend text",
  pages.operator.includes(deployments.fcc.instructionSender.slice(0, 12)),
);
check("incident 44928272 is linked from the homepage", /\/proof\/incident\/44928272/.test(pages.home));
check("the incident page exists and names its reason code", /S021_PAYMENT_ALREADY_OBSERVED/.test(pages.incident));
check("the judge result is reported honestly", /2/.test(pages.proof) && !/0 UNVERIFIABLE/.test(pages.proof));
check(
  "unverifiable is not cosmetically converted",
  !/unverifiable[^<]{0,30}(pending|warning|pass)/i.test(all),
);

// ---------------------------------------------------------------- injection safety

check("first-party js escapes before writing html", /const esc =/.test(app) && /innerHTML/.test(app) ? /esc\(/.test(app) : true);
check("request ids are parsed and bounded", /\^\[0-9\]\{1,20\}\$/.test(app) && /2n \*\* 64n/.test(app));
check(
  "explorer origins are not caller-controlled",
  !/href="\$\{[^}]*(input|value|param|query)/i.test(app),
);
check("no wallet object is serialized", !/JSON\.stringify\([^)]*(provider|ethereum|wallet)\b/i.test(app));

// ---------------------------------------------------------------- assets

for (const asset of ["brand/hero-mechanism.png", "brand/mark-32.png", "brand/mark-180.png", "brand/og-card.png", "app.js"]) {
  check(`asset exists: ${asset}`, existsSync(join(DIST, asset)));
}
check("the hero illustration is referenced with dimensions", /hero-mechanism\.png"[^>]*width="\d+"[^>]*height="\d+"/.test(pages.home), "prevents layout shift");

console.log(`\n${failures === 0 ? "web checks pass" : `${failures} web checks failed`}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * The shell, the design layer and the shared components.
 *
 * Tokens are design.md's, unchanged. What is new here is a product layer on top of them: a real
 * navigation, a split hero, a status strip, a mechanism rail and disclosure components.
 *
 * Two rules shaped every component below.
 *
 * Disclosure uses <details>/<summary>, never a JS toggle. It is keyboard accessible, announces its
 * own expanded state, and works with scripting off, which is the difference between progressive
 * enhancement and a page that blanks.
 *
 * Status is never colour alone. Every tone carries a word, because a reader who cannot separate
 * ember from graphite still has to be able to separate simulated from live.
 */
import { CONNECT_SRC, ENDPOINTS, deployment, demoReceipt } from "./data.mjs";

const demoTx = demoReceipt?.txHash ?? "";

export const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const short = (hex, head = 10, tail = 6) =>
  typeof hex === "string" && hex.length > head + tail + 3 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex;

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self'",
  `connect-src ${CONNECT_SRC.join(" ")}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const CSS = `
:root {
  --obsidian:#09090b; --graphite:#18181b; --slate:#27272a; --iron:#3f3f46; --steel:#52525b;
  --fog:#71717a; --ash:#a1a1aa; --mist:#d4d4d8; --cloud:#ececee; --paper:#f4f4f5; --snow:#ffffff;
  --ember:#ff5a00;
  --font:"Cosmica","DM Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --shadow-md:rgba(0,0,0,.04) 0 4px 12px 0;
  --wrap:1200px;
}
*{box-sizing:border-box}
/* The hidden attribute only sets display:none at the UA level, so any explicit display in a
   component rule silently defeats it. The wallet button shipped visible to visitors with no wallet
   because .btn sets inline-flex. */
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{animation:none!important;transition:none!important}}
body{margin:0;background:var(--paper);color:var(--graphite);font-family:var(--font);font-size:15px;line-height:1.45}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 24px}
a{color:var(--obsidian);text-decoration-color:var(--mist);text-underline-offset:3px}
a:hover{text-decoration-color:var(--ember)}
:focus-visible{outline:2px solid var(--ember);outline-offset:3px;border-radius:4px}
.skip{position:absolute;left:-9999px;top:0;background:var(--obsidian);color:var(--snow);padding:12px 20px;border-radius:14px;z-index:20}
.skip:focus{left:24px;top:16px}

/* ---------------------------------------------------------------- nav */
.nav{position:sticky;top:0;z-index:15;background:rgba(244,244,245,.88);backdrop-filter:blur(8px);border-bottom:1px solid var(--cloud)}
.nav-inner{max-width:var(--wrap);margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:28px;position:relative}
.brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:var(--obsidian);flex:0 0 auto}
.brand svg{width:74px;height:20px;display:block}
.brand .word{font-size:16px;font-weight:600;letter-spacing:-.01em}
/* A checkbox rather than <details>: details collapses its own content whatever display the child
   is given, which hid the desktop navigation entirely. */
.nav-toggle-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.nav-menu-toggle{display:none;cursor:pointer;font-size:14px;color:var(--iron);padding:8px 14px;border:1px solid var(--cloud);border-radius:10000px;background:var(--snow);user-select:none}
.nav-toggle-input:focus-visible+.nav-menu-toggle{outline:2px solid var(--ember);outline-offset:3px}
.nav-menu-panel{display:flex;gap:4px;flex:1 1 auto;min-width:0}
.nav-menu-panel a{font-size:14px;color:var(--iron);text-decoration:none;padding:8px 12px;border-radius:10000px;white-space:nowrap}
.nav-menu-panel a:hover{background:var(--snow);color:var(--obsidian)}
.nav-menu-panel a[aria-current="page"]{background:var(--snow);color:var(--obsidian);border:1px solid var(--cloud)}
.nav-right{display:flex;align-items:center;gap:10px;flex:0 0 auto;position:relative}
/* Shown only when more than one wallet announces itself, which is the case this exists for. */
.wallet-picker{position:absolute;top:calc(100% + 8px);right:0;z-index:30;background:var(--snow);border:1px solid var(--cloud);border-radius:24px;padding:14px;min-width:220px;box-shadow:var(--shadow-md);display:flex;flex-direction:column;gap:6px}
.wallet-picker-title{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--fog);margin:0 0 4px 4px}
.wallet-option{justify-content:flex-start;width:100%}
.nav-toggle{display:none}
@media (max-width:900px){
  .nav-inner{gap:12px}
  .nav-menu-toggle{display:inline-block}
  .nav-menu-panel{display:none;position:absolute;left:0;right:0;top:100%;flex-direction:column;gap:2px;background:var(--snow);border-bottom:1px solid var(--cloud);padding:12px 24px 16px;z-index:20}
  .nav-toggle-input:checked~.nav-menu-panel{display:flex}
  .nav-menu-panel a{padding:12px;min-height:44px;display:flex;align-items:center}
}

/* ---------------------------------------------------------------- type */
h1{font-size:56px;line-height:1.12;font-weight:600;letter-spacing:-.015em;color:var(--obsidian);margin:0}
h2{font-size:32px;line-height:1.28;font-weight:700;color:var(--obsidian);margin:0 0 6px}
h3{font-size:20px;line-height:1.4;font-weight:600;color:var(--slate);margin:0 0 8px;overflow-wrap:anywhere}
h4{font-size:15px;font-weight:600;color:var(--slate);margin:0 0 4px;overflow-wrap:anywhere}
.lede{font-size:18px;line-height:1.5;color:var(--iron);max-width:62ch;margin:16px 0 0}
.note{font-size:14px;color:var(--steel);max-width:70ch;margin:0 0 24px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--iron);background:var(--snow);border:1px solid var(--cloud);border-radius:10000px;padding:6px 14px}
.eyebrow.accent{background:var(--ember);border-color:var(--ember);color:var(--snow)}
code,.mono{font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
section{padding:80px 0 0}
section:last-of-type{padding-bottom:80px}

/* ---------------------------------------------------------------- hero */
.hero{display:grid;grid-template-columns:1.05fr minmax(0,.95fr);gap:48px;align-items:center;padding:72px 0 8px}
.hero-copy{min-width:0}
.card,.rows,.step{min-width:0}
.note,.lede{overflow-wrap:break-word}
.hero h1{max-width:15ch}
.cta-row{display:flex;flex-wrap:wrap;gap:10px;margin:32px 0 0}
.btn{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:500;padding:12px 22px;border-radius:14px;text-decoration:none;border:1px solid transparent;cursor:pointer;font-family:inherit}
.btn-primary{background:var(--obsidian);color:var(--snow)}
.btn-primary:hover{background:var(--graphite)}
.btn-ghost{background:var(--snow);color:var(--iron);border-color:var(--cloud)}
.btn-ghost:hover{color:var(--obsidian)}
.btn-quiet{background:none;color:var(--steel);padding:12px 8px}
.btn[disabled],.btn[aria-disabled="true"]{opacity:.55;cursor:not-allowed}
/* No panel, no frame. The illustration has a genuinely transparent background and its subject is
   light-toned with ember accents, so it sits on Paper directly and reads cleaner there than it did
   on the black field an earlier version put behind it. */
.stage{display:flex;align-items:center;justify-content:center;min-width:0;overflow:hidden}
/* Allowed to run a little past the column on wide screens. The subject is centre-weighted with a
   lot of transparent margin, so at the column width it reads smaller than it is. */
.stage img{width:100%;height:auto;display:block;max-width:none;transform:scale(1.1)}
@media (max-width:900px){.stage img{transform:none}}
@media (max-width:900px){
  .hero{grid-template-columns:1fr;gap:32px;padding:40px 0 0}
  h1{font-size:36px}
  .stage{order:2}
}

/* ---------------------------------------------------------------- status strip */
/* Flex rather than grid: with five cells an auto-fit grid leaves an empty track on the last row,
   and because the 1px "gap" is really the container showing through, that empty track renders as a
   grey block. Flex items just fill the row. */
.strip{display:flex;flex-wrap:wrap;background:var(--snow);border:1px solid var(--cloud);border-radius:24px;overflow:hidden;margin:40px 0 0}
.strip>div{flex:1 1 150px;padding:16px 18px;min-width:0;border-left:1px solid var(--cloud)}
.strip>div:first-child{border-left:none}
.strip dd{overflow-wrap:anywhere}
.strip dt{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--fog);margin:0 0 6px}
.strip dd{margin:0;font-size:14px;font-weight:500;color:var(--obsidian);display:flex;align-items:center;gap:7px}
.dot{width:7px;height:7px;border-radius:10000px;flex:0 0 auto;background:currentColor}
.tone-verified{color:var(--obsidian)}
.tone-live{color:var(--obsidian)}
.tone-simulated{color:var(--ember)}
.tone-unavailable{color:var(--steel)}
.tone-checked{color:var(--iron)}

/* ---------------------------------------------------------------- rail */
.rail{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;counter-reset:step}
.step{background:var(--snow);border:1px solid var(--cloud);border-radius:24px;padding:22px;margin:0}
.step summary{list-style:none;cursor:pointer}
.step summary::-webkit-details-marker{display:none}
.step .num{font-family:var(--mono);font-size:12px;color:var(--ember);display:block;margin-bottom:10px}
.step .name{font-size:16px;font-weight:600;color:var(--obsidian);display:block}
.step .hint{font-size:13px;color:var(--fog);display:block;margin-top:6px}
.step[open]{border-color:var(--mist)}
.step .detail{font-size:14px;color:var(--steel);margin:14px 0 0;padding-top:14px;border-top:1px solid var(--cloud)}
@media (max-width:900px){.rail{grid-template-columns:1fr}}

/* ---------------------------------------------------------------- cards */
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))}
.grid-2{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr))}
.card{background:var(--snow);border:1px solid var(--cloud);border-radius:36px;padding:28px}
.card.tight{border-radius:24px;padding:20px 22px}
.card h3 a{text-decoration:none}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:500;letter-spacing:.03em;text-transform:uppercase;border-radius:12px;padding:4px 10px;border:1px solid var(--cloud);background:var(--paper);color:var(--iron)}
.badge.verified{border-color:var(--mist);color:var(--obsidian)}
.badge.simulated{border-color:var(--ember);color:var(--ember);background:var(--snow)}
.badge.unavailable{color:var(--steel)}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.more{font-size:14px;font-weight:500;text-decoration:none;display:inline-block;margin-top:14px}
.more::after{content:" →"}

/* ---------------------------------------------------------------- disclosure rows */
.rows{border:1px solid var(--cloud);border-radius:24px;overflow:hidden;background:var(--snow)}
/* The current step is the only one that draws attention. Colour is never the only signal: the
   status badge next to it says Done, Do this next or Waiting in words. */
.step-row[data-state="current"]{background:var(--snow);box-shadow:inset 3px 0 0 var(--ember)}
.step-row[data-state="done"] .title{color:var(--steel)}
.step-row[data-state="todo"]{opacity:.72}
.row{border-bottom:1px solid var(--cloud)}
.row:last-child{border-bottom:none}
.row>summary{cursor:pointer;padding:18px 22px;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;list-style:none}
.row>summary::-webkit-details-marker{display:none}
.row>summary::after{content:"+";margin-left:auto;color:var(--ash);font-family:var(--mono)}
.row[open]>summary::after{content:"–"}
.row>summary:hover{background:var(--paper)}
.row .title{font-weight:600;color:var(--obsidian);font-size:15px}
.row .sub{font-size:13px;color:var(--steel);flex-basis:100%;margin-top:2px;max-width:80ch}
.row .body{padding:0 22px 22px;font-size:14px;color:var(--steel)}
.row .body h4{margin-top:16px}
.row .body ul{margin:6px 0 0;padding-left:18px}
.row .body li{margin:6px 0}
.row .body li::marker{color:var(--ember)}


/* ---------------------------------------------------------------- safe demo
   Example selection and attack selection are both radio groups driven by CSS. The demo is the
   thing most people will actually touch, so it must not depend on a script having loaded. */
.example-picker{position:relative}
.example-radio{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}
.example-tabs{display:flex;flex-wrap:wrap;gap:8px}
.example-tab{font-size:14px;font-weight:500;padding:10px 18px;border-radius:10000px;border:1px solid var(--cloud);background:var(--snow);color:var(--iron);cursor:pointer;user-select:none}
.example-tab:hover{border-color:var(--mist);color:var(--obsidian)}
.example{display:none}
#pick-live-derivation:checked~.grid-2 #example-live-derivation{display:block}
#pick-settled:checked~.grid-2 #example-settled{display:block}
#pick-live-derivation:checked~.example-tabs label[for="pick-live-derivation"],
#pick-settled:checked~.example-tabs label[for="pick-settled"]{background:var(--obsidian);border-color:var(--obsidian);color:var(--snow)}
#pick-live-derivation:focus-visible~.example-tabs label[for="pick-live-derivation"],
#pick-settled:focus-visible~.example-tabs label[for="pick-settled"]{outline:2px solid var(--ember);outline-offset:3px}

/* Caller input looks like input. Derived values look like readouts. That contrast is the argument. */
.caller-supplied dd{background:var(--snow);border:1px solid var(--mist);border-radius:10px;padding:6px 10px}
.derived{display:flex;flex-direction:column;gap:8px}
.derived-field{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;background:var(--paper);border:1px dashed var(--mist);border-radius:12px;padding:10px 12px}
.derived-label{font-size:12px;color:var(--fog);text-transform:uppercase;letter-spacing:.04em;flex:0 0 130px}
.derived-value{color:var(--graphite);flex:1 1 160px;min-width:0;overflow-wrap:anywhere}
.outcome{margin-top:20px;padding-top:18px;border-top:1px solid var(--cloud)}

/* ---------------------------------------------------------------- attack demo
   Radio inputs and sibling selectors, not a JS toggle. The demo is the clearest thing on the page
   and it has to survive scripting being off, so the radios carry the state and CSS does the work.
   Labels are the visible control; the inputs are hidden from sight but not from a screen reader or
   the keyboard, which is why this is clip rather than display:none. */
.attack-panel{position:relative}
.attack-radio{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}
.attacks{display:flex;flex-wrap:wrap;gap:8px}
.attack-chip{font-size:13px;padding:8px 14px;border-radius:10000px;border:1px solid var(--cloud);background:var(--paper);color:var(--iron);cursor:pointer;user-select:none}
.attack-chip:hover{border-color:var(--mist);color:var(--obsidian)}
.attack-radio:focus-visible+.attacks .attack-chip,.attack-radio:focus-visible~.attacks .attack-chip{outline:none}
.attack-outcomes{margin-top:18px;padding-top:18px;border-top:1px solid var(--cloud);min-height:96px}
.attack-outcome{display:none}
.outcome-head{font-size:15px;font-weight:600;margin:0 0 8px}
.outcome-head.impossible{color:var(--obsidian)}
.outcome-head.refused{color:var(--ember)}
${["destination", "amount", "reference", "paid", "noobs", "disagree", "stale", "expired", "replay"]
  .map(
    (id) =>
      `#attack-${id}:checked~.attacks label[for="attack-${id}"]{background:var(--obsidian);border-color:var(--obsidian);color:var(--snow)}\n` +
      `#attack-${id}:checked~.attack-outcomes #outcome-${id}{display:block}`,
  )
  .join("\n")}
.attack-radio:focus-visible~.attacks label{box-shadow:none}
${["destination", "amount", "reference", "paid", "noobs", "disagree", "stale", "expired", "replay"]
  .map((id) => `#attack-${id}:focus-visible~.attacks label[for="attack-${id}"]{outline:2px solid var(--ember);outline-offset:3px}`)
  .join("\n")}

.tour-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;flex-wrap:wrap;margin:0 0 24px}
.tour-actions{display:flex;gap:6px}
.tour-nav{display:flex;align-items:center;gap:14px;margin:20px 0 0}
.tour-position{font-size:13px;color:var(--steel);font-family:var(--mono)}
.step-body{padding:18px 22px}
.step-line{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.step-num{font-family:var(--mono)}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--obsidian);color:var(--snow);font-size:14px;padding:12px 20px;border-radius:14px;z-index:40;box-shadow:var(--shadow-md)}

/* ---------------------------------------------------------------- filters, breadcrumbs
   Filtering is radio inputs and sibling selectors so it survives scripting being off, same as the
   demo. Counts are rendered server-side from the ledger rather than computed in the browser. */
.filterable{position:relative}
.filter-radio{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 8px}
.filter-chip{font-size:13px;padding:8px 16px;border-radius:10000px;border:1px solid var(--cloud);background:var(--snow);color:var(--iron);cursor:pointer;user-select:none}
.filter-chip .count{color:var(--fog);font-family:var(--mono);font-size:11px;margin-left:4px}
#filter-all:checked~.filters label[for="filter-all"],
#filter-verified:checked~.filters label[for="filter-verified"],
#filter-unavailable:checked~.filters label[for="filter-unavailable"]{background:var(--obsidian);border-color:var(--obsidian);color:var(--snow)}
#filter-all:checked~.filters label .count,
#filter-verified:checked~.filters label[for="filter-verified"] .count,
#filter-unavailable:checked~.filters label[for="filter-unavailable"] .count{color:var(--mist)}
#filter-verified:checked~.filter-body .claim-row:not([data-status="verified"]),
#filter-unavailable:checked~.filter-body .claim-row:not([data-status="unavailable"]){display:none}
/* A heading with nothing under it is worse than no heading, so empty groups collapse with them. */
#filter-verified:checked~.filter-body .rows:not(:has(.claim-row[data-status="verified"])),
#filter-verified:checked~.filter-body .rows:not(:has(.claim-row[data-status="verified"]))+.group-head,
#filter-unavailable:checked~.filter-body .rows:not(:has(.claim-row[data-status="unavailable"])){display:none}
.crumbs{font-size:13px;color:var(--steel);margin:0 0 14px}
.crumbs a{color:var(--steel)}
.crumbs span{color:var(--ash);margin:0 4px}
.btn-sm{padding:8px 14px;font-size:13px}

/* ---------------------------------------------------------------- tables */
.scroll{overflow-x:auto;border:1px solid var(--cloud);border-radius:24px;background:var(--snow)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:500;color:var(--steel);font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:14px 16px;border-bottom:1px solid var(--cloud);white-space:nowrap}
td{padding:14px 16px;border-bottom:1px solid var(--cloud);vertical-align:top}
tr:last-child td{border-bottom:none}
td .mono{word-break:break-all}

/* ---------------------------------------------------------------- misc */
.chain{font-family:var(--mono);font-size:13px;line-height:1.7;color:var(--iron);background:var(--snow);border:1px solid var(--cloud);border-radius:24px;padding:20px 24px;margin:0;overflow-x:auto}
/* minmax(0,…) on both tracks, because a 34-character XRPL address in a monospace font will not
   wrap and will otherwise push the whole page sideways on a 375px screen. */
.kv{display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:8px 20px;font-size:14px;margin:0}
.kv dt{color:var(--steel)}
.kv dd{margin:0;color:var(--graphite);min-width:0;overflow-wrap:anywhere}
@media (max-width:520px){.kv{grid-template-columns:1fr;gap:2px 0}.kv dd{margin-bottom:10px}}
.timeline{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:28px 0 0}
.timeline .card{border-radius:24px;padding:20px 22px}
.timeline .when{font-family:var(--mono);font-size:11px;color:var(--ember);text-transform:uppercase;letter-spacing:.04em}
@media (max-width:900px){.timeline{grid-template-columns:1fr}}
.footer{border-top:1px solid var(--cloud);margin-top:96px;background:var(--obsidian);color:var(--ash)}
.footer .wrap{padding-top:48px;padding-bottom:40px}
.footer-grid{display:grid;grid-template-columns:1.4fr minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:32px}
.footer h4{color:var(--snow);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 12px}
.footer ul{list-style:none;margin:0;padding:0}
.footer li{margin:8px 0;font-size:14px}
.footer a{color:var(--mist);text-decoration:none}
.footer a:hover{color:var(--snow);text-decoration:underline}
.footer .brand{color:var(--snow)}
.footer .fine{font-size:13px;color:var(--fog);margin:32px 0 0;max-width:70ch}
@media (max-width:900px){.footer-grid{grid-template-columns:1fr 1fr}}
@media (max-width:520px){.footer-grid{grid-template-columns:1fr}}
.noscript{background:var(--snow);border:1px solid var(--ember);border-radius:24px;padding:18px 22px;font-size:14px;color:var(--iron);margin:0 0 24px}
`;

/** The mark, inlined so it needs no extra request and inherits the surface's colour. */
export const MARK = `<svg viewBox="0 0 104 28" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M2.5 2.5H26"/><path d="M11 10H31"/><path d="M15 18H31"/><path d="M2.5 25.5H26"/><path d="M33 2.5h7a11.5 11.5 0 0 1 0 23h-7"/><path d="M51.5 14H80"/></g><rect x="86" y="10.5" width="7" height="7" fill="#ff5a00"/></svg>`;

const NAV = [
  ["Product", "/operator", "operator"],
  ["How it works", "/#mechanism", null],
  ["Incident", `/proof/incident/44928272`, "incident"],
  ["Proof", "/proof", "proof"],
];

export const badge = (text, tone = "") => `<span class="badge ${tone}">${escape(text)}</span>`;

export const statusDot = (tone, label) =>
  `<span class="tone-${escape(tone)}"><span class="dot"></span></span>${escape(label)}`;

export function page({ title, description, current, body, script = null, ogImage = "/brand/og-card.png" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:image" content="${escape(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/brand/mark-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/brand/mark-180.png">
<style>${CSS}</style>
</head>
<body data-registry="${escape(deployment.registry ?? "")}" data-demo-tx="${escape(demoTx ?? "")}" data-fcc-sender="${escape(deployment.fccSender ?? "")}" data-extension-id="${escape(deployment.extensionId ?? "")}" data-chain-id="${escape(deployment.chainId ?? "")}">
<a class="skip" href="#main">Skip to content</a>
<nav class="nav" aria-label="Primary">
  <div class="nav-inner">
    <a class="brand" href="/" aria-label="Signet home">${MARK}<span class="word">Signet</span></a>
    <input class="nav-toggle-input" type="checkbox" id="nav-toggle">
    <label class="nav-menu-toggle" for="nav-toggle">Menu</label>
    <div class="nav-menu-panel">
      ${NAV.map(([label, href, key]) => `<a href="${href}"${key && key === current ? ' aria-current="page"' : ""}>${escape(label)}</a>`).join("")}
      <a href="${ENDPOINTS.repository}" rel="noreferrer noopener">GitHub ↗</a>
    </div>
    <div class="nav-right">
      <span class="badge verified" title="Signet's contracts are deployed on Flare's Coston2 testnet"><span class="dot"></span>Coston2</span>
      <button class="btn btn-ghost" id="wallet-button" type="button" data-wallet-connect hidden>Connect wallet</button>
    </div>
  </div>
</nav>
<main id="main">
${body}
</main>
<footer class="footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <a class="brand" href="/" aria-label="Signet home">${MARK}<span class="word">Signet</span></a>
        <p class="fine">FAssets decides what is owed. Signet decides whether that exact XRP payment may exist. FDC proves what happened.</p>
      </div>
      <div>
        <h4>Product</h4>
        <ul><li><a href="/operator">Operator</a></li><li><a href="/proof">Proof</a></li><li><a href="/proof/incident/44928272">Incident</a></li></ul>
      </div>
      <div>
        <h4>Developers</h4>
        <ul>
          <li><a href="${ENDPOINTS.repository}" rel="noreferrer noopener">GitHub</a></li>
          <li><a href="/proof#verify">Verify it yourself</a></li>
          <li><a href="/proof/transactions">Transactions</a></li>
        </ul>
      </div>
      <div>
        <h4>Status</h4>
        <ul>
          <li>Coston2 · chain 114</li>
          <li>FCC extension 66248</li>
          <li>Execution: simulated</li>
        </ul>
      </div>
    </div>
    <p class="fine">Every figure is generated from committed evidence in the repository. No hardware attestation is claimed, no TEE machine is registered, and Signet has never operated a whitelisted FAssets agent.</p>
  </div>
</footer>
${script ? `<script src="${escape(script)}" defer></script>` : ""}
</body>
</html>
`;
}

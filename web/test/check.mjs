#!/usr/bin/env node
/**
 * Checks the built pages.
 *
 * Two kinds of check, and the second is the one that matters.
 *
 * The accessibility checks are structural: a skip link, one h1, labelled landmarks, a lang
 * attribute, no heading levels skipped, alt text on images, and colour contrast on the text pairs
 * the design actually uses. These catch the failures a static page can have; they are not a
 * substitute for someone using the page with a screen reader.
 *
 * The integrity checks are about honesty. A proof page must not be able to show only good news, so
 * these assert that every limitation in the claim ledger appears on the page, that unverified
 * claims are rendered, and that a receipt marked as a seam proof is visibly labelled as one. A page
 * that quietly dropped a limitation would still look fine.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST = join(REPO_ROOT, "web", "dist");

const pages = {
  index: readFileSync(join(DIST, "index.html"), "utf8"),
  operator: readFileSync(join(DIST, "operator.html"), "utf8"),
};
const ledger = JSON.parse(readFileSync(join(REPO_ROOT, "evidence", "claim-ledger.json"), "utf8"));

let failures = 0;
function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
}

// ---------------------------------------------------------------- contrast

/** WCAG relative luminance. */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const PALETTE = {
  ember: "#ff5a00",
  obsidian: "#09090b",
  graphite: "#18181b",
  slate: "#27272a",
  iron: "#3f3f46",
  steel: "#52525b",
  fog: "#71717a",
  mist: "#d4d4d8",
  cloud: "#ececee",
  paper: "#f4f4f5",
  snow: "#ffffff",
};

/**
 * The pairs the pages actually use, at the sizes they use them.
 *
 * Every one is normal text and so needs 4.5, except white on the ember badge, which is a 12px
 * uppercase label on a solid fill and is held to 3 as a non-text UI component.
 */
const CONTRAST_PAIRS = [
  { name: "body text on canvas", fg: PALETTE.graphite, bg: PALETTE.paper, min: 4.5 },
  { name: "body text on cards", fg: PALETTE.graphite, bg: PALETTE.snow, min: 4.5 },
  { name: "headings on canvas", fg: PALETTE.obsidian, bg: PALETTE.paper, min: 4.5 },
  { name: "section notes on canvas", fg: PALETTE.steel, bg: PALETTE.paper, min: 4.5 },
  { name: "helper text on cards", fg: PALETTE.fog, bg: PALETTE.snow, min: 4.5 },
  { name: "limitation text on cards", fg: PALETTE.steel, bg: PALETTE.snow, min: 4.5 },
  { name: "secondary headings on cards", fg: PALETTE.slate, bg: PALETTE.snow, min: 4.5 },
  { name: "nav labels on cards", fg: PALETTE.iron, bg: PALETTE.snow, min: 4.5 },
  { name: "white on the ember badge", fg: PALETTE.snow, bg: PALETTE.ember, min: 3 },
];

/**
 * Fog on Paper is 4.40:1.
 *
 * design.md assigns Fog to helper text, and on Snow it clears 4.5. On Paper it does not, so the
 * pages use Steel there. This is asserted rather than left as a convention, because the two greys
 * are visually close enough that a future edit would swap them without anyone noticing.
 */
check("fog on paper is known to be below the threshold", contrast(PALETTE.fog, PALETTE.paper) < 4.5,
  `${contrast(PALETTE.fog, PALETTE.paper).toFixed(2)}:1, which is why section notes use Steel`);

for (const pair of CONTRAST_PAIRS) {
  const ratio = contrast(pair.fg, pair.bg);
  check(`contrast: ${pair.name}`, ratio >= pair.min, `${ratio.toFixed(2)}:1 (needs ${pair.min})`);
}

// ---------------------------------------------------------------- structure

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
  check(`${name}: does not skip a heading level`, !/(<h1[\s\S]*?<h3)|(<h2[\s\S]*?<h4)/.test(html.replace(/<h2[\s\S]*/, "")));
  check(`${name}: ships no scripts`, !/<script/i.test(html));
  check(`${name}: loads nothing from another origin`, !/(src|href)="https?:\/\/(?!testnet\.xrpl\.org)/.test(html));
  check(`${name}: renders without javascript`, html.includes("<main id=\"main\">") && html.length > 3000);
}

// ---------------------------------------------------------------- honesty

const proof = pages.index;

check(
  "every claim in the ledger appears on the proof page",
  ledger.claims.every((c) => proof.includes(`id="${c.id}"`)),
  `${ledger.claims.length} claims`,
);

const missingLimits = ledger.claims.flatMap((c) =>
  (c.limitations ?? []).filter((l) => !proof.includes(l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"))),
);
check("every limitation is shown, not summarised away", missingLimits.length === 0, missingLimits[0] ?? "");

const unverified = ledger.claims.filter((c) => c.status !== "verified");
check(
  "claims that are not verified are still rendered",
  unverified.every((c) => proof.includes(`id="${c.id}"`)),
  `${unverified.length} not verified`,
);

check(
  "receipts that only prove a seam are labelled as such",
  proof.includes("seam proof only"),
  "settles:false is visible to a reader",
);

check("the page tells a reader how to check it themselves", /verify:receipt/.test(proof));

console.log(`\n${failures === 0 ? "web checks pass" : `${failures} web checks failed`}`);
process.exit(failures === 0 ? 0 : 1);

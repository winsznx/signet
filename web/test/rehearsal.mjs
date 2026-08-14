#!/usr/bin/env node
/**
 * Timed demo rehearsal, driven entirely through the product.
 *
 * The demo brief is 2:30 to 2:55 with no terminal until the last beat. This walks the exact path
 * against a running site and times each one, so "it can be recorded in under three minutes" is a
 * measurement rather than a hope. Every beat asserts what has to be on screen for that beat to be
 * worth recording: if the assertion fails, the demo has a hole in it.
 *
 * The dwell times are what a presenter actually needs to speak the line, not machine speed. The
 * measured total is therefore a floor for the recording, not a prediction of it.
 *
 *   PLAYWRIGHT=/path/to/node_modules node web/test/rehearsal.mjs [url]
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";

let chromium;
try {
  const spec = process.env.PLAYWRIGHT ? pathToFileURL(join(process.env.PLAYWRIGHT, "playwright", "index.mjs")).href : "playwright";
  ({ chromium } = await import(spec));
} catch {
  console.log("SKIPPED rehearsal: playwright is not installed");
  process.exit(0);
}

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
let BASE = process.argv[2];
let server = null;
if (!BASE) {
  server = createServer((req, res) => {
    let p = join(DIST, new URL(req.url, "http://l").pathname);
    if (!extname(p)) p = join(p, "index.html");
    if (!existsSync(p)) {
      res.writeHead(404);
      return res.end();
    }
    const type = extname(p) === ".js" ? "text/javascript" : extname(p) === ".png" ? "image/png" : "text/html";
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(p));
  });
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failures = 0;
const beats = [];
const started = Date.now();

/** One beat: do it, assert the thing the presenter will point at, hold for the spoken line. */
async function beat(name, speakSeconds, action, assertion) {
  const from = Date.now();
  await action();
  const ok = await assertion();
  if (!ok) failures += 1;
  // The dwell is the line being spoken. Kept short here and scaled in the report.
  await page.waitForTimeout(120);
  const elapsed = (Date.now() - from) / 1000;
  beats.push({ name, ok, navigation: elapsed, speak: speakSeconds });
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(46)} nav ${elapsed.toFixed(2)}s · speak ${speakSeconds}s`);
}

await beat(
  "0:00 hero — what Signet is",
  15,
  () => page.goto(`${BASE}/`, { waitUntil: "networkidle" }),
  async () => (await page.locator("h1").innerText()).includes("Only the XRP payment FAssets asked for"),
);

await beat(
  "0:15 the caller supplies only a request id",
  20,
  async () => {
    await page.locator("#try").scrollIntoViewIfNeeded();
  },
  async () => (await page.locator("#try").innerText()).includes("What the caller supplies"),
);

await beat(
  "0:35 everything else comes from FAssets",
  15,
  async () => {},
  async () => (await page.locator("#try .derived-field .badge").count()) >= 5,
);

await beat(
  "0:55 try to change the destination, then the amount",
  20,
  async () => {
    await page.locator('label[for="attack-destination"]').click();
    await page.waitForTimeout(80);
    await page.locator('label[for="attack-amount"]').click();
  },
  async () => (await page.locator("#outcome-amount").innerText()).includes("Impossible"),
);

await beat(
  "1:15 observe XRPL before authorizing",
  15,
  async () => {
    await page.locator('label[for="attack-paid"]').click();
  },
  async () => (await page.locator("#outcome-paid").innerText()).includes("S021_PAYMENT_ALREADY_OBSERVED"),
);

await beat(
  "1:35 the incident — this was not theoretical",
  20,
  async () => {
    await page.goto(`${BASE}/proof/incident/44928272`, { waitUntil: "networkidle" });
  },
  async () => {
    const text = await page.locator("body").innerText();
    return text.includes("19825006") && text.includes("19825042") && text.includes("S021_PAYMENT_ALREADY_OBSERVED");
  },
);

await beat(
  "1:55 the execution evidence, and FDC",
  20,
  async () => {
    await page.goto(`${BASE}/proof/transactions`, { waitUntil: "networkidle" });
    await page.locator("#tx .row summary").first().click();
  },
  async () => (await page.locator("#tx .row").first().innerText()).includes("Transaction"),
);

await beat(
  "2:15 proof — and what we report as unverifiable",
  20,
  async () => {
    await page.goto(`${BASE}/proof`, { waitUntil: "networkidle" });
  },
  async () => {
    const text = await page.locator("body").innerText();
    return /13/.test(text) && /unverifiable/i.test(text) && /could not be performed/i.test(text);
  },
);

await beat(
  "2:35 close on the boundary",
  15,
  async () => {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.locator("#boundary").scrollIntoViewIfNeeded();
  },
  async () => {
    const text = await page.locator("#boundary").innerText();
    return /hardware attestation/i.test(text) && /no/i.test(text);
  },
);

const navigationTotal = beats.reduce((sum, b) => sum + b.navigation, 0);
const speakTotal = beats.reduce((sum, b) => sum + b.speak, 0);

console.log(`\nnavigation time   ${navigationTotal.toFixed(1)}s`);
console.log(`narration budget  ${speakTotal}s (${Math.floor(speakTotal / 60)}:${String(speakTotal % 60).padStart(2, "0")})`);
const total = speakTotal + navigationTotal;
console.log(`projected runtime ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, "0")}`);

if (errors.length) {
  failures += 1;
  console.log(`\nconsole errors during the rehearsal: ${errors.slice(0, 3).join(" | ")}`);
}
// The brief is 2:30 to 2:55, so the ceiling here is 2:55 rather than a round three minutes.
if (total > 175) {
  failures += 1;
  console.log(`\nover the 2:55 ceiling by ${Math.round(total - 175)}s`);
}

await browser.close();
server?.close();
console.log(`\n${failures === 0 ? "rehearsal passes" : `${failures} rehearsal problems`}`);
process.exit(failures === 0 ? 0 : 1);

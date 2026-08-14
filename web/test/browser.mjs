#!/usr/bin/env node
/**
 * Browser tests for the Signet product surface.
 *
 * These test the product rather than the markup: that the attack demo answers, that the inspector
 * degrades honestly when the chain is unreachable, that a wallet can be declined without breaking
 * anything, that nothing overflows sideways on a 375px phone, and that the whole site still means
 * something with JavaScript switched off.
 *
 * Playwright is not a repository dependency: it is heavy, and `make verify` has to run from a fresh
 * clone on a machine that has nothing. So this skips cleanly when Playwright is absent and is run
 * deliberately with `make test-browser`. The static checks in check.mjs are the ones that gate.
 *
 *   PLAYWRIGHT=/path/to/node_modules node web/test/browser.mjs
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST = join(REPO_ROOT, "web", "dist");
const SHOTS = join(REPO_ROOT, "web", "screenshots");

let chromium;
try {
  // NODE_PATH does not apply to ESM resolution, so an explicit path is how this finds a Playwright
  // that lives outside the repository.
  const spec = process.env.PLAYWRIGHT ? pathToFileURL(join(process.env.PLAYWRIGHT, "playwright", "index.mjs")).href : "playwright";
  ({ chromium } = await import(spec));
} catch {
  console.log("SKIPPED browser tests: playwright is not installed (this is not a repository dependency)");
  process.exit(0);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

/** Serves dist the way Pages does: /proof resolves to /proof/index.html. */
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = join(DIST, decodeURIComponent(url.pathname));
  if (!extname(path)) path = join(path, "index.html");
  if (!existsSync(path)) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
  res.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(0, resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (name, condition, detail = "") => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};

const ROUTES = ["/", "/operator", "/proof", "/proof/claims", "/proof/transactions", "/proof/incident/44928272"];
const VIEWPORTS = [
  ["desktop", 1440, 900],
  ["laptop", 1024, 768],
  ["tablet", 768, 1024],
  ["mobile-430", 430, 932],
  ["mobile-390", 390, 844],
  ["mobile-375", 375, 667],
];

const browser = await chromium.launch();

// ---------------------------------------------------------------- every route, every viewport

for (const [label, width, height] of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  for (const route of ROUTES) {
    const response = await page.goto(BASE + route, { waitUntil: "networkidle" });
    check(`${label} ${route}: responds 200`, response?.status() === 200);

    // Horizontal overflow is the single most common responsive defect and the easiest to miss.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${label} ${route}: no horizontal overflow`, overflow <= 1, `${overflow}px`);

    const h1 = await page.locator("h1").count();
    check(`${label} ${route}: exactly one h1`, h1 === 1);
  }
  check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await context.close();
}

// ---------------------------------------------------------------- the product works

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
check(
  "wallet button stays hidden when no provider exists",
  !(await page.locator("#wallet-button").isVisible()),
  "a visitor with no wallet is not offered a dead control",
);
check("hero illustration loads", await page.evaluate(() => {
  const img = document.querySelector(".stage img");
  return Boolean(img && img.complete && img.naturalWidth > 0);
}));
check("primary CTA points at the operator", (await page.locator('a.btn-primary[href="/operator"]').count()) > 0);
check("nav reaches proof", (await page.locator('.nav-links a[href="/proof"]').count()) > 0);

// The attack demo: pick a move, get the right answer.
await page.locator('label[for="attack-paid"]').click();
check(
  "attack demo: already-paid returns S021",
  (await page.locator("#outcome-paid").isVisible()) &&
    (await page.locator("#outcome-paid").innerText()).includes("S021_PAYMENT_ALREADY_OBSERVED"),
);
check("attack demo: only one outcome is visible", (await page.locator(".attack-outcome:visible").count()) === 1);
await page.locator('label[for="attack-destination"]').click();
check(
  "attack demo: changing destination is impossible rather than refused",
  (await page.locator("#outcome-destination").innerText()).includes("Impossible"),
);
check("attack demo: previous outcome is hidden", !(await page.locator("#outcome-paid").isVisible()));

// Disclosures are native and keyboard operable. Reload first: the clicks above left focus on a
// label, and tabbing from there says nothing about where a fresh visitor lands.
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.keyboard.press("Tab");
const focused = await page.evaluate(() => document.activeElement?.className ?? "");
check("keyboard: first tab reaches the skip link", focused.includes("skip"));
const firstStep = page.locator("details.step").first();
await firstStep.locator("summary").click();
check("mechanism steps expand", await firstStep.evaluate((el) => el.open));

// ---------------------------------------------------------------- operator, wallet, inspector

await page.goto(`${BASE}/operator`, { waitUntil: "networkidle" });
check("inspector is revealed when scripting is on", await page.locator("#inspector-panel").isVisible());
check("committed worked example is always present", (await page.locator("text=Worked example").count()) > 0);
check(
  "unavailable hardware action is shown disabled, not hidden",
  await page.locator('button:has-text("Hardware FCC authorization")').isDisabled(),
);

// A wallet that declines must not break the page. 4001 is the standard "user rejected" code, and
// it reads differently from a wallet that simply never answers: conflating them would tell someone
// they declined when the extension actually failed.
await page.addInitScript(() => {
  window.ethereum = {
    request: async ({ method }) => {
      if (method === "eth_requestAccounts") {
        const e = new Error("User rejected the request");
        e.code = 4001;
        throw e;
      }
      if (method === "eth_chainId") return "0x72";
      return null;
    },
    on: () => {},
  };
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(300);
const walletButton = page.locator("#wallet-button");
check("wallet button appears only when a provider exists", await walletButton.isVisible());
await walletButton.click();
await page.waitForTimeout(400);
check("a declined connection says declined", (await walletButton.innerText()).toLowerCase().includes("declined"));

// A provider that fails for any other reason must say so rather than sit silent.
await page.addInitScript(() => {
  window.ethereum = {
    request: async ({ method }) => {
      if (method === "eth_requestAccounts") throw new Error("extension exploded");
      if (method === "eth_chainId") return "0x72";
      return null;
    },
    on: () => {},
  };
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.locator("#wallet-button").click();
await page.waitForTimeout(400);
check(
  "a failing wallet is reported rather than leaving a dead button",
  (await page.locator("#wallet-button").innerText()).toLowerCase().includes("did not respond"),
);

// A wallet on the wrong chain offers the switch.
await page.addInitScript(() => {
  window.ethereum = {
    request: async ({ method }) => {
      if (method === "eth_requestAccounts") return ["0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d"];
      if (method === "eth_chainId") return "0x1";
      return null;
    },
    on: () => {},
  };
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.locator("#wallet-button").click();
await page.waitForTimeout(500);
check("wrong network offers a switch", (await page.locator("#wallet-button").innerText()).includes("Coston2"));

// The inspector must refuse an invalid id rather than call anything.
await page.goto(`${BASE}/operator`, { waitUntil: "networkidle" });
await page.locator("#request-id").fill("not-a-number");
await page.locator("[data-inspect]").click();
await page.waitForTimeout(200);
check("inspector rejects a non-numeric request id", (await page.locator("#inspector-status").innerText()).includes("numeric"));

// And when the chain is unreachable it says so instead of inventing a result.
await page.route("**/ext/C/rpc", (r) => r.abort());
await page.route("**/flare_coston2", (r) => r.abort());
await page.locator("#request-id").fill("44928272");
await page.locator("[data-inspect]").click();
await page.waitForTimeout(1500);
const unreachable = await page.locator("#inspector-result").innerText();
check("inspector reports an unreachable chain rather than substituting a fixture", /unavailable/i.test(unreachable));
check("inspector never claims live data it did not get", !/Live Coston2/.test(unreachable) || /unavailable/i.test(unreachable));

await context.close();

// ---------------------------------------------------------------- with javascript disabled

const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
const noJsPage = await noJs.newPage();
for (const route of ROUTES) {
  await noJsPage.goto(BASE + route, { waitUntil: "domcontentloaded" });
  const text = await noJsPage.locator("main").innerText();
  // A table route is legitimately terse, so the bar is "not blank" rather than a word count. What
  // each route actually has to say is asserted individually below.
  check(`no-js ${route}: is not blank`, text.length > 700, `${text.length} chars`);
}
await noJsPage.goto(`${BASE}/proof/transactions`, { waitUntil: "domcontentloaded" });
check(
  "no-js: the transaction table renders every receipt row",
  (await noJsPage.locator("tbody tr").count()) >= 8,
  `${await noJsPage.locator("tbody tr").count()} rows`,
);
await noJsPage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
check("no-js: the mechanism is readable", (await noJsPage.locator("text=One request in").count()) > 0);
check("no-js: deployment truth is visible", (await noJsPage.locator("text=Simulated FCC").count()) > 0);
await noJsPage.locator('label[for="attack-paid"]').click();
check(
  "no-js: the attack demo still answers",
  (await noJsPage.locator("#outcome-paid").isVisible()) &&
    (await noJsPage.locator("#outcome-paid").innerText()).includes("S021"),
  "radio + CSS, no script needed",
);
await noJsPage.goto(`${BASE}/operator`, { waitUntil: "domcontentloaded" });
check("no-js: the live inspector is hidden rather than broken", !(await noJsPage.locator("#inspector-panel").isVisible()));
check("no-js: a committed example is shown instead", (await noJsPage.locator("text=Worked example").count()) > 0);
await noJs.close();

// ---------------------------------------------------------------- screenshots

mkdirSync(SHOTS, { recursive: true });
for (const [label, width, height] of [["1440", 1440, 900], ["390", 390, 844]]) {
  const shotContext = await browser.newContext({ viewport: { width, height } });
  const shotPage = await shotContext.newPage();
  for (const [name, route] of [["home", "/"], ["operator", "/operator"], ["proof", "/proof"], ["incident", "/proof/incident/44928272"]]) {
    await shotPage.goto(BASE + route, { waitUntil: "networkidle" });
    await shotPage.screenshot({ path: join(SHOTS, `${name}-${label}.png`), fullPage: name === "home" });
  }
  await shotContext.close();
}
console.log(`screenshots written to web/screenshots/`);

await browser.close();
server.close();
console.log(`\n${failures === 0 ? "browser tests pass" : `${failures} browser tests failed`}`);
process.exit(failures === 0 ? 0 : 1);

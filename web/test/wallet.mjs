#!/usr/bin/env node
/**
 * Wallet connection, and specifically the case that broke in a real browser.
 *
 * With several wallet extensions installed they all compete for window.ethereum, and the one that
 * wins is not necessarily the one that will show UI. The symptom is a Connect button that appears
 * to do nothing: the request goes somewhere that never answers. An earlier version of this site
 * read window.ethereum directly and had exactly that bug.
 *
 * So the first scenario below is deliberately hostile: a squatter occupies window.ethereum and
 * never resolves, while two real wallets announce themselves per EIP-6963. The product has to find
 * them, offer a choice, and use the one chosen.
 *
 *   PLAYWRIGHT=/path/to/node_modules node web/test/wallet.mjs
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
  console.log("SKIPPED wallet tests: playwright is not installed");
  process.exit(0);
}
const DIST = fileURLToPath(new URL("../dist", import.meta.url));

const server = createServer((req, res) => {
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
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures += 1;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};

// ---- the scenario that broke: several wallets, and window.ethereum is the wrong one ----
const multi = await browser.newContext();
const page = await multi.newPage();
await page.addInitScript(() => {
  window.__used = null;
  const make = (name) => ({
    name,
    request: async ({ method }) => {
      window.__used = name;
      if (method === "eth_requestAccounts") return ["0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d"];
      if (method === "eth_chainId") return "0x72";
      return null;
    },
    on: () => {},
  });
  const rabby = make("Rabby");
  const phantom = make("Phantom");
  // A hostile-ish squatter that never resolves, standing in for the extension that wins the
  // window.ethereum race and then shows no UI. This is what made the button look dead.
  window.ethereum = { request: () => new Promise(() => {}), on: () => {} };
  for (const [uuid, info, provider] of [
    ["uuid-rabby", { uuid: "uuid-rabby", name: "Rabby" }, rabby],
    ["uuid-phantom", { uuid: "uuid-phantom", name: "Phantom" }, phantom],
  ]) {
    window.addEventListener("eip6963:requestProvider", () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }));
    });
  }
});
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const btn = page.locator("#wallet-button");
check("button visible with multiple wallets", await btn.isVisible());
await btn.click();
await page.waitForTimeout(250);
check("a picker appears when more than one wallet announces", await page.locator("#wallet-picker").isVisible());
const options = await page.locator(".wallet-option").allInnerTexts();
check("the picker lists every announced wallet", options.length >= 2, options.join(", "));

await page.locator('.wallet-option:has-text("Phantom")').click();
await page.waitForTimeout(600);
check("the chosen wallet is the one asked", (await page.evaluate(() => window.__used)) === "Phantom");
check("connection completes", (await btn.innerText()).includes("0x88f6"), await btn.innerText());
await multi.close();

// ---- single wallet: no picker, straight through ----
const single = await browser.newContext();
const p2 = await single.newPage();
await p2.addInitScript(() => {
  const only = {
    request: async ({ method }) => {
      if (method === "eth_requestAccounts") return ["0xAbC0000000000000000000000000000000000001"];
      if (method === "eth_chainId") return "0x1";
      return null;
    },
    on: () => {},
  };
  window.addEventListener("eip6963:requestProvider", () => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u1", name: "Solo" }, provider: only } }),
    );
  });
});
await p2.goto(`${BASE}/`, { waitUntil: "networkidle" });
await p2.waitForTimeout(300);
await p2.locator("#wallet-button").click();
await p2.waitForTimeout(600);
check("a single wallet connects without a picker", !(await p2.locator("#wallet-picker").isVisible().catch(() => false)));
check("wrong chain offers the switch", (await p2.locator("#wallet-button").innerText()).includes("Coston2"));
await single.close();

// ---- the session survives a refresh ----
// eth_accounts returns what the wallet has already authorised and prompts nothing, so a reload
// should restore the connection rather than asking again. It did not, and every navigation looked
// like a disconnect.
const persist = await browser.newContext();
const p4 = await persist.newPage();
await p4.addInitScript(() => {
  // The wallet's own permission survives a reload, so the mock has to as well. An earlier version
  // reset on every load and therefore could not tell a restored session from a fresh one.
  const acct = ["0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d"];
  window.__prompts = Number(sessionStorage.getItem("mock.prompts") ?? "0");
  let authorised = sessionStorage.getItem("mock.authorised") === "1";
  const wallet = {
    request: async ({ method }) => {
      if (method === "eth_requestAccounts") {
        window.__prompts += 1;
        sessionStorage.setItem("mock.prompts", String(window.__prompts));
        authorised = true;
        sessionStorage.setItem("mock.authorised", "1");
        return acct;
      }
      if (method === "eth_accounts") return authorised ? acct : [];
      if (method === "eth_chainId") return "0x72";
      return null;
    },
    on: () => {},
  };
  window.addEventListener("eip6963:requestProvider", () => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u-persist", name: "Solo" }, provider: wallet } }),
    );
  });
});
await p4.goto(`${BASE}/operator`, { waitUntil: "networkidle" });
await p4.waitForTimeout(350);
await p4.locator("#wallet-button").click();
await p4.waitForTimeout(500);
check("connects on the operator page", (await p4.locator("#wallet-button").innerText()).includes("0x88f6"));
check(
  "connecting advances the console rather than doing nothing visible",
  (await p4.locator('[data-step="connect"]').getAttribute("data-state")) === "done",
);
// innerText returns text after CSS transforms, and the badge is uppercased, so compare case-insensitively.
check(
  "the summary reflects the connection",
  /connected/i.test(await p4.locator("#console-summary").innerText()),
  await p4.locator("#console-summary").innerText(),
);

await p4.reload({ waitUntil: "networkidle" });
await p4.waitForTimeout(600);
check(
  "the session survives a refresh",
  (await p4.locator("#wallet-button").innerText()).includes("0x88f6"),
  await p4.locator("#wallet-button").innerText(),
);
check("restoring never re-prompts", (await p4.evaluate(() => window.__prompts)) === 1, `${await p4.evaluate(() => window.__prompts)} prompts`);
await persist.close();

// ---- read-only is a real path ----
const ro = await browser.newContext();
const p5 = await ro.newPage();
await p5.goto(`${BASE}/operator`, { waitUntil: "networkidle" });
await p5.locator("[data-read-only]").click();
await p5.waitForTimeout(200);
check("read-only advances the console without a wallet", (await p5.locator('[data-step="connect"]').getAttribute("data-state")) === "done");
await ro.close();

// ---- no wallet at all ----
const none = await browser.newContext();
const p3 = await none.newPage();
await p3.goto(`${BASE}/`, { waitUntil: "networkidle" });
await p3.waitForTimeout(400);
check("no wallet installed leaves the button hidden", !(await p3.locator("#wallet-button").isVisible()));
await none.close();

await browser.close();
server.close();
console.log(`\n${failures === 0 ? "multi-wallet tests pass" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);

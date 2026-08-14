#!/usr/bin/env node
/**
 * Parses every mermaid block in the repository's markdown.
 *
 * A diagram with a syntax error does not fail loudly on GitHub. It renders as a grey box that says
 * "Syntax error in text", which looks worse than having no diagram at all and is easy to ship
 * without noticing, because nothing in a normal build ever reads them.
 *
 * Mermaid needs a DOM to parse, so this runs its real parser inside the Chromium that the browser
 * tests already use. It is not part of `make verify` for that reason: it is run with the rest of
 * the browser suite, where a headless browser is already a dependency.
 *
 *   PLAYWRIGHT=/path/to/node_modules MERMAID=/path/to/node_modules node scripts/check-mermaid.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

let chromium;
try {
  const spec = process.env.PLAYWRIGHT ? pathToFileURL(join(process.env.PLAYWRIGHT, "playwright", "index.mjs")).href : "playwright";
  ({ chromium } = await import(spec));
} catch {
  console.log("SKIPPED mermaid check: playwright is not installed");
  process.exit(0);
}

// The UMD bundle, not the ESM one: the ESM build fetches sibling chunks, which a page loaded from
// about:blank cannot resolve. The UMD build is self-contained and exposes window.mermaid directly.
const mermaidPath = join(process.env.MERMAID ?? join(REPO_ROOT, "node_modules"), "mermaid", "dist", "mermaid.min.js");
if (!existsSync(mermaidPath)) {
  console.log("SKIPPED mermaid check: the mermaid library is not installed");
  process.exit(0);
}

/** Markdown we author. Vendored upstream docs are not ours to police. */
const SKIP = new Set(["node_modules", "upstream", ".git", "dist", ".runtime", "cache"]);
function markdownFiles(dir = REPO_ROOT, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) markdownFiles(full, found);
    else if (entry.endsWith(".md")) found.push(full);
  }
  return found;
}

const blocks = [];
for (const file of markdownFiles()) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  let open = null;
  lines.forEach((line, i) => {
    if (open === null && /^\s*```mermaid\s*$/.test(line)) open = { start: i + 1, body: [] };
    else if (open !== null && /^\s*```\s*$/.test(line)) {
      blocks.push({ file: relative(REPO_ROOT, file), line: open.start, source: open.body.join("\n") });
      open = null;
    } else if (open !== null) open.body.push(line);
  });
}

if (blocks.length === 0) {
  console.log("no mermaid diagrams found");
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");
await page.addScriptTag({ path: mermaidPath });
await page.waitForFunction(() => Boolean(window.mermaid), null, { timeout: 30000 });
await page.evaluate(() => {
  window.__mermaid = window.mermaid;
  window.__mermaid.initialize({ startOnLoad: false });
});

let failures = 0;
for (const [index, block] of blocks.entries()) {
  const result = await page.evaluate(
    async ([source, id]) => {
      try {
        await window.__mermaid.parse(source);
        // Rendering catches things parsing alone does not, such as an edge to a node that shape
        // rules reject.
        await window.__mermaid.render(`d${id}`, source);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error).split("\n")[0].slice(0, 180) };
      }
    },
    [block.source, index],
  );
  if (!result.ok) failures += 1;
  const label = `${block.file}:${block.line}`;
  console.log(`${result.ok ? "ok  " : "FAIL"} ${label}${result.ok ? "" : `  ${result.message}`}`);
}

await browser.close();
console.log(`\n${failures === 0 ? `mermaid OK: ${blocks.length} diagrams parse and render` : `${failures} of ${blocks.length} diagrams failed`}`);
process.exit(failures === 0 ? 0 : 1);

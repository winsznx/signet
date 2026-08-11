#!/usr/bin/env node
/**
 * Fetches every pinned upstream source into upstream/<id>/ at its locked commit.
 *
 * Default mode verifies the extracted tree against contentSha256 in docs/source-lock.json.
 * --update records the observed hash instead, and is only for adding or repinning an entry.
 */
import { mkdirSync, rmSync, existsSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  UPSTREAM_DIR,
  hashUpstream,
  readSourceLock,
  sh,
  tarballUrl,
  writeSourceLock,
} from "./lib/source-lock.mjs";

const update = process.argv.includes("--update");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

const lock = readSourceLock();
mkdirSync(UPSTREAM_DIR, { recursive: true });

let failures = 0;
let mutated = false;

for (const entry of lock.upstream) {
  if (only && entry.id !== only) continue;
  const target = join(UPSTREAM_DIR, entry.id);
  const stamp = join(target, ".signet-pin");

  const alreadyAtCommit = existsSync(stamp) && sh("cat", [stamp]).trim() === entry.commit;
  if (!alreadyAtCommit) {
    const scratch = join(tmpdir(), `signet-upstream-${entry.id}-${entry.commit.slice(0, 12)}`);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const archive = join(scratch, "src.tar.gz");
    process.stdout.write(`fetch ${entry.id}@${entry.commit.slice(0, 12)} ... `);
    sh("curl", ["-sSL", "--fail", "--max-time", "300", "-o", archive, tarballUrl(entry)]);
    sh("tar", ["xzf", archive, "-C", scratch]);
    const roots = readdirSync(scratch).filter((n) => n !== "src.tar.gz");
    if (roots.length !== 1) throw new Error(`${entry.id}: unexpected archive layout ${roots.join(",")}`);
    rmSync(target, { recursive: true, force: true });
    renameSync(join(scratch, roots[0]), target);
    rmSync(scratch, { recursive: true, force: true });
    writeFileSync(stamp, `${entry.commit}\n`);
    process.stdout.write("ok\n");
  }

  const { contentSha256, fileCount } = hashUpstream(entry.id);

  if (update || entry.contentSha256 === null) {
    mutated = mutated || entry.contentSha256 !== contentSha256 || entry.fileCount !== fileCount;
    entry.contentSha256 = contentSha256;
    entry.fileCount = fileCount;
    console.log(`record ${entry.id} contentSha256=${contentSha256} files=${fileCount}`);
  } else if (entry.contentSha256 !== contentSha256) {
    console.error(`MISMATCH ${entry.id}\n  expected ${entry.contentSha256}\n  observed ${contentSha256}`);
    failures += 1;
  } else {
    console.log(`verify ${entry.id} contentSha256=${contentSha256} files=${fileCount} OK`);
  }
}

// Verification runs must not rewrite the lock; only recording a new or repinned entry may.
if (mutated) writeSourceLock(lock);

if (failures > 0) {
  console.error(`\n${failures} upstream checkout(s) did not match the pinned content hash.`);
  process.exit(1);
}

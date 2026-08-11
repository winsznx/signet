#!/usr/bin/env node
/**
 * Creates and funds an XRPL Testnet account, keeping every secret out of stdout and out of git.
 *
 * The key is generated here rather than by the faucet on purpose. A faucet that mints the key
 * returns the seed in its HTTP response, which would put it in a log, a terminal buffer and this
 * agent's context at once. Generating locally and asking the faucet only to fund a public address
 * keeps the secret in one place: a mode-600 file under .runtime/secrets/, which is gitignored.
 *
 * Usage: node scripts/xrpl/provision-account.mjs <role> [--fund]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { REPO_ROOT } from "../lib/source-lock.mjs";
import { XRPL_FAUCET, accountInfo, validatedLedger } from "./client.mjs";

const role = process.argv[2];
const shouldFund = process.argv.includes("--fund");
if (!role || !/^[a-z0-9-]+$/.test(role)) {
  console.error("usage: provision-account.mjs <role> [--fund]   (role: lowercase, digits, hyphens)");
  process.exit(1);
}

const secretDir = join(REPO_ROOT, ".runtime", "secrets");
const publicDir = join(REPO_ROOT, ".runtime", "xrpl");
mkdirSync(secretDir, { recursive: true, mode: 0o700 });
mkdirSync(publicDir, { recursive: true });

const secretPath = join(secretDir, `xrpl-${role}.json`);
const publicPath = join(publicDir, `${role}.public.json`);

let classicAddress;
let publicKey;

if (existsSync(secretPath)) {
  // Never regenerate over an existing key: an account that has already been configured on chain
  // would become unrecoverable.
  const existing = JSON.parse(readFileSync(secretPath, "utf8"));
  classicAddress = existing.classicAddress;
  publicKey = existing.publicKey;
  console.log(`reusing existing ${role} account`);
} else {
  const wallet = Wallet.generate("ed25519");
  classicAddress = wallet.classicAddress;
  publicKey = wallet.publicKey;
  writeFileSync(
    secretPath,
    `${JSON.stringify(
      {
        role,
        network: "xrpl-testnet",
        classicAddress: wallet.classicAddress,
        publicKey: wallet.publicKey,
        seed: wallet.seed,
        algorithm: "ed25519",
        createdAt: new Date().toISOString(),
        warning: "TESTNET ONLY. Never commit, never print, never move out of .runtime/secrets/.",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(secretPath, 0o600);
  console.log(`generated ${role} account`);
}

writeFileSync(
  publicPath,
  `${JSON.stringify({ role, network: "xrpl-testnet", classicAddress, publicKey }, null, 2)}\n`,
);

console.log(`  address    ${classicAddress}`);
console.log(`  publicKey  ${publicKey}`);
console.log(`  secret     ${secretPath.replace(REPO_ROOT, ".")} (mode 600, gitignored, never printed)`);

async function funded() {
  try {
    const info = await accountInfo(classicAddress);
    return BigInt(info.account_data.Balance);
  } catch (error) {
    if (/actNotFound/i.test(error.message)) return null;
    throw error;
  }
}

let balance = await funded();

if (balance === null && shouldFund) {
  console.log("  funding via the public testnet faucet ...");
  const response = await fetch(XRPL_FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destination: classicAddress }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    console.error(`  faucet returned HTTP ${response.status}`);
    process.exit(1);
  }
  // The faucet response can contain a seed when it mints its own account. We asked it to fund an
  // address we already own, so there should be none; it is discarded unread either way.
  await response.text();

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && balance === null) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    balance = await funded();
  }
}

const ledger = await validatedLedger();
if (balance === null) {
  console.log(`  balance    unfunded (validated ledger ${ledger.index})`);
  process.exit(shouldFund ? 1 : 0);
}
console.log(`  balance    ${balance} drops (${Number(balance) / 1e6} XRP) at validated ledger ${ledger.index}`);

#!/usr/bin/env bash
set -euo pipefail

# Regression fixtures for scripts/secret-scan.mjs.
#
# The scanner only sees files git tracks, so each fixture is staged with `git add -N`
# (intent-to-add), scanned, then unstaged and deleted. The working tree is left clean.
#
# Every case here is a false negative that a previous version of the scanner shipped with.
# A "fix" that silently narrows coverage again fails this test.

cd "$(dirname "$0")/.."

FIXTURE_DIR=".signet-secret-scan-fixture"
FAILED=0

cleanup() {
  git rm --cached -r --quiet --ignore-unmatch "$FIXTURE_DIR" 2>/dev/null || true
  rm -rf "$FIXTURE_DIR"
}
trap cleanup EXIT

expect_detected() {
  local name="$1" filename="$2" content="$3"
  cleanup
  mkdir -p "$FIXTURE_DIR"
  printf '%s\n' "$content" > "$FIXTURE_DIR/$filename"
  git add -N "$FIXTURE_DIR/$filename"
  if node scripts/secret-scan.mjs >/dev/null 2>&1; then
    echo "FAIL  $name — scanner did not detect the secret"
    FAILED=1
  else
    echo "ok    $name"
  fi
}

expect_clean() {
  local name="$1" filename="$2" content="$3"
  cleanup
  mkdir -p "$FIXTURE_DIR"
  printf '%s\n' "$content" > "$FIXTURE_DIR/$filename"
  git add -N "$FIXTURE_DIR/$filename"
  if node scripts/secret-scan.mjs >/dev/null 2>&1; then
    echo "ok    $name"
  else
    echo "FAIL  $name — scanner produced a false positive"
    node scripts/secret-scan.mjs 2>&1 | sed 's/^/        /' || true
    FAILED=1
  fi
}

echo "secret-scan regression fixtures"

# The literal values below are throwaway test vectors, not usable credentials:
# the hex strings are 'deadbeef' repeated and the XRPL seed is the documented
# xrpl.org example seed for the well-known test account.

expect_detected "camelCase privateKey assignment" "go_style.txt" \
  'var privateKey = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbee1"'

expect_detected "bare 64-hex under an unrelated field name" "config.json" \
  '{"deployerKey": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbee2"}'

# Built at test time from a fixed dummy entropy value rather than committed as a literal, so a
# real-looking seed never enters this repository while the checksum path is still exercised.
SYNTHETIC_XRPL_SEED=$(node -e '
const { createHash } = require("node:crypto");
const ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const body = Buffer.concat([Buffer.from([33]), Buffer.alloc(16, 0xab)]);
const checksum = createHash("sha256").update(createHash("sha256").update(body).digest()).digest().subarray(0, 4);
let value = BigInt("0x" + Buffer.concat([body, checksum]).toString("hex"));
let out = "";
while (value > 0n) { out = ALPHABET[Number(value % 58n)] + out; value /= 58n; }
process.stdout.write(out);
')

expect_detected "XRPL family seed on a line containing the token signet-" "notes.md" \
  "$SYNTHETIC_XRPL_SEED signet-test-account"

expect_detected "PEM private key block in a non-pem file" "notes.txt" \
  '-----BEGIN OPENSSH PRIVATE KEY-----'

expect_detected "aws access key id" "aws.txt" \
  'AKIAIOSFODNN7EXAMPLE'

# Digests that legitimately appear in the repository must not trip the scanner.
expect_clean "allowlisted upstream content digest" "hashes.md" \
  '| fce-extension-scaffold | 47f0b162e3c3aa212459a465fb9ce72104788c8f88019b86ad8bd3f44c1bd538 |'

expect_clean "placeholder assignment" "env.example" \
  'DEPLOYMENT_PRIVATE_KEY=<your-testnet-key>'

cleanup

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "secret-scan regression FAILED"
  exit 1
fi

echo "secret-scan regression OK"

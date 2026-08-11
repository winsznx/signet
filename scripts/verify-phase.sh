#!/usr/bin/env bash
set -euo pipefail

# Phase gate runner. `make verify-phase PHASE=NN` runs exactly the checks that phase owns
# and refuses to pass when the phase's evidence file is missing.
#
# A phase is never complete because code compiles. It is complete when its checks pass and
# docs/evidence/phase-NN.md records the result.

cd "$(dirname "$0")/.."

PHASE="${1:?usage: verify-phase.sh NN}"
EVIDENCE="docs/evidence/phase-${PHASE}.md"

run() {
  echo "--- $* ---"
  "$@"
}

case "$PHASE" in
  00)
    run make verify-bootstrap
    run node scripts/verify-sandbox-config.mjs
    run bash scripts/secret-scan.test.sh
    run bash scripts/secret-scan.sh
    run node scripts/verify-source-lock.mjs
    run node scripts/verify-claim-ledger.mjs
    ;;
  01)
    run make verify-bootstrap
    run make typecheck
    run make test-unit
    run make test-property
    run bash scripts/secret-scan.test.sh
    run bash scripts/secret-scan.sh
    run node scripts/verify-claim-ledger.mjs
    ;;
  02|03|04|05|06|07|08|09|10|11|12|13)
    echo "phase ${PHASE} gate is defined when the phase is implemented" >&2
    exit 1
    ;;
  *)
    echo "unknown phase ${PHASE}" >&2
    exit 1
    ;;
esac

if [ ! -f "$EVIDENCE" ]; then
  echo "MISSING EVIDENCE: $EVIDENCE" >&2
  exit 1
fi

echo "phase ${PHASE} gate PASS (evidence: $EVIDENCE)"

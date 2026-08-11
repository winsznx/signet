#!/usr/bin/env bash
set -euo pipefail

# Thin wrapper so the phase gate and CI keep a stable entry point.
# The scanner itself is scripts/secret-scan.mjs.

cd "$(dirname "$0")/.."
exec node scripts/secret-scan.mjs "$@"

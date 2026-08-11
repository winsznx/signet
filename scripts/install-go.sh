#!/usr/bin/env bash
set -euo pipefail

# Installs the Go version pinned in toolchain.lock into .runtime/toolchain/go.
#
# The repo-local install keeps a fresh clone independent of whatever Go the host happens to
# have, and .runtime/ is gitignored so the toolchain never enters the repository history.

cd "$(dirname "$0")/.."

URL=$(python3 -c 'import json;print(json.load(open("toolchain.lock"))["tools"]["go"]["archive"]["url"])')
EXPECTED=$(python3 -c 'import json;print(json.load(open("toolchain.lock"))["tools"]["go"]["archive"]["sha256"])')
DEST=.runtime/toolchain

if [ -x "$DEST/go/bin/go" ]; then
  echo "go already installed: $("$DEST/go/bin/go" version)"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "downloading $URL"
curl -sSL --fail --max-time 900 -o "$TMP/go.tar.gz" "$URL"

OBSERVED=$(shasum -a 256 "$TMP/go.tar.gz" | awk '{print $1}')
if [ "$OBSERVED" != "$EXPECTED" ]; then
  echo "checksum mismatch: expected $EXPECTED observed $OBSERVED" >&2
  exit 1
fi

mkdir -p "$DEST"
tar xzf "$TMP/go.tar.gz" -C "$DEST"
echo "installed $("$DEST/go/bin/go" version) into $DEST/go"

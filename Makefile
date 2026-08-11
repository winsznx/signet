SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Node honours standard proxy environment variables only when asked to.
# Harmless when no proxy is configured, required in sandboxed CI.
export NODE_USE_ENV_PROXY := 1

# Go is pinned per toolchain.lock. A repo-local toolchain is used when the host has none,
# so a fresh clone never depends on whatever Go version happens to be installed.
LOCAL_GO := $(CURDIR)/.runtime/toolchain/go/bin
export PATH := $(LOCAL_GO):$(PATH)

PHASE ?=

.PHONY: help
help:
	@echo "Signet make targets"
	@echo "  bootstrap         install toolchain deps and fetch pinned upstream sources"
	@echo "  scan              secret scan, its regression fixtures, and sandbox config lint"
	@echo "  verify-bootstrap  prove the bootstrap is reproducible and the source lock holds"
	@echo "  resolve-coston2   re-resolve and RPC-verify every Coston2 address Signet uses"
	@echo "  fmt lint typecheck"
	@echo "  test-unit test-property test-contract test-race test-integration test-e2e"
	@echo "  scan              secret and dependency scanning"
	@echo "  verify            every gate that is implemented today"
	@echo "  verify-phase PHASE=NN"

# ---------------------------------------------------------------------------- bootstrap

.PHONY: bootstrap
bootstrap:
	pnpm install --frozen-lockfile
	node scripts/fetch-upstream.mjs
	forge build
	@echo "bootstrap complete"

.PHONY: verify-bootstrap
verify-bootstrap:
	node scripts/verify-toolchain.mjs
	node scripts/verify-sandbox-config.mjs
	node scripts/fetch-upstream.mjs
	node scripts/verify-source-lock.mjs
	node scripts/verify-claim-ledger.mjs
	forge build --sizes >/dev/null
	@echo "verify-bootstrap OK"

.PHONY: resolve-coston2
resolve-coston2:
	node scripts/resolve-coston2.mjs

# ---------------------------------------------------------------------------- quality

.PHONY: fmt
fmt:
	forge fmt
	@if [ -d extension ]; then gofmt -w extension; fi

.PHONY: lint
lint:
	forge fmt --check
	@if [ -d extension ]; then test -z "$$(gofmt -l extension)" || { gofmt -l extension; exit 1; }; fi
	@if [ -d extension ]; then go vet ./...; fi

.PHONY: typecheck
typecheck:
	@if [ -f reference/package.json ]; then pnpm -r exec tsc --noEmit; else echo "PENDING typecheck: owned by phase 01"; fi

# ---------------------------------------------------------------------------- tests

.PHONY: test-unit
test-unit:
	@if [ -f reference/package.json ]; then pnpm vitest run; else echo "PENDING test-unit: owned by phase 01"; fi

.PHONY: test-property
test-property:
	@if [ -d reference/test/property ]; then pnpm vitest run reference/test/property; else echo "PENDING test-property: owned by phase 01"; fi

.PHONY: test-contract
test-contract:
	@if [ -n "$$(find contracts/test -name '*.t.sol' 2>/dev/null)" ]; then forge test -vv; else echo "PENDING test-contract: owned by phase 02"; fi

.PHONY: test-race
test-race:
	@if [ -d extension ]; then go test -race ./...; else echo "PENDING test-race: owned by phase 03"; fi

.PHONY: test-integration
test-integration:
	@echo "PENDING test-integration: owned by phase 08"

.PHONY: test-e2e
test-e2e:
	@echo "PENDING test-e2e: owned by phase 09"

# ---------------------------------------------------------------------------- security

.PHONY: scan
scan:
	node scripts/verify-sandbox-config.mjs
	bash scripts/secret-scan.test.sh
	bash scripts/secret-scan.sh
	pnpm audit --prod || true

# ---------------------------------------------------------------------------- gates

.PHONY: verify
verify: verify-bootstrap lint typecheck test-unit test-property test-contract test-race scan
	@echo "verify OK"

.PHONY: verify-phase
verify-phase:
	@test -n "$(PHASE)" || { echo "usage: make verify-phase PHASE=NN"; exit 1; }
	bash scripts/verify-phase.sh "$(PHASE)"

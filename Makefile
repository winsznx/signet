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
	@echo "  doctor            read-only diagnosis of the deployed FCC surface"
	@echo "  judge             independent verification: no wallet, funds, Docker, GCP or TEE"
	@echo "  test-browser      product tests, six viewports, plus a timed demo rehearsal"
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
	node scripts/build-evidence-graph.mjs
	node scripts/doctor.test.mjs
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
	@if [ -d extension ]; then cd extension && GOWORK=off go vet ./...; fi

.PHONY: typecheck
typecheck:
	@if [ -f reference/package.json ]; then pnpm --filter @signet/reference exec tsc --noEmit; else echo "PENDING typecheck: owned by phase 01"; fi

# ---------------------------------------------------------------------------- tests

.PHONY: test-unit
test-unit:
	@if [ -f reference/package.json ]; then pnpm vitest run reference; else echo "PENDING test-unit: owned by phase 01"; fi

.PHONY: test-property
test-property:
	@if [ -d reference/test/property ]; then pnpm vitest run reference/test/property; else echo "PENDING test-property: owned by phase 01"; fi

.PHONY: fixtures-check
fixtures-check:
	pnpm vitest run reference/test/fixtures.test.ts

# Fork tests read live Coston2 state at pinned blocks. The endpoint comes from the source lock
# unless overridden, so a fresh clone needs no configuration.
COSTON2_RPC_URL ?= $(shell node -e "process.stdout.write(require('./docs/source-lock.json').networks.coston2.rpc[0])" 2>/dev/null)
export COSTON2_RPC_URL

.PHONY: test-contract
test-contract:
	@if [ -n "$$(find contracts/test -name '*.t.sol' 2>/dev/null)" ]; then forge test -vv; else echo "PENDING test-contract: owned by phase 02"; fi

.PHONY: test-xrpl-reconcile
test-xrpl-reconcile:
	node scripts/xrpl/reconcile.test.mjs

.PHONY: test-fork
test-fork:
	@test -n "$(COSTON2_RPC_URL)" || { echo "COSTON2_RPC_URL is required for fork tests"; exit 1; }
	forge test --match-path "contracts/test/fork/*.t.sol" -vv

.PHONY: test-race
test-race:
	@if [ -d extension ]; then cd extension && GOWORK=off go test -race ./...; else echo "PENDING test-race: owned by phase 07"; fi

.PHONY: test-conformance
test-conformance:
	cd extension && GOWORK=off go test ./internal/conformance/ -v -run TestGoAgrees 2>&1 | tail -5

.PHONY: test-integration
test-integration:
	@if docker exec signet-postgres pg_isready -U signet >/dev/null 2>&1; then \
		node coordinator/test/durability.test.mjs; \
	else \
		echo "SKIPPED test-integration: start postgres with 'make db-up' first"; \
	fi

.PHONY: db-up
db-up:
	docker run -d --name signet-postgres -e POSTGRES_PASSWORD=signet -e POSTGRES_USER=signet \
		-e POSTGRES_DB=signet -p 5433:5432 postgres:17-alpine
	sleep 10
	docker exec -i signet-postgres psql -U signet -d signet < coordinator/migrations/0001_initial.sql

.PHONY: db-down
db-down:
	docker rm -f signet-postgres

.PHONY: test-e2e
test-e2e: lifecycle

# The composed lifecycle. Starts its own Coston2 fork, so it needs no C2FLR, but it does submit a
# real XRPL Testnet payment and does call the FDC verifier, so it needs network and a funded
# testnet source account.
# Verifies one receipt against public sources, with no credentials.
# Regenerates the static proof and operator pages, then checks them.
.PHONY: web
web:
	node web/src/build.mjs
	node web/test/check.mjs

.PHONY: verify-receipt
verify-receipt:
	@node --experimental-strip-types verifier/src/cli.ts $(RECEIPT)

.PHONY: lifecycle
lifecycle:
	node scripts/lifecycle/run.mjs

# ---------------------------------------------------------------------------- security

.PHONY: scan
scan:
	node scripts/verify-sandbox-config.mjs
	bash scripts/secret-scan.test.sh
	bash scripts/secret-scan.sh
	pnpm audit --prod || true

# ---------------------------------------------------------------------------- operator and judge

# Read-only diagnosis of the deployed FCC surface. Never mutates: recovery actions are in
# docs/runbooks/recovery.md and are run deliberately, by hand.
.PHONY: doctor
doctor:
	@node scripts/doctor.mjs

# Independent verification for someone who is not us. No wallet, no funds, no Docker, no GCP, no
# TEE, no secrets. Exits 0 on all-pass, 1 on any failure, 2 if something could not be checked.
.PHONY: judge
judge:
	@node scripts/judge.mjs

# Browser tests for the product surface: six viewports, no-JS rendering, wallet and inspector
# states, screenshots. Playwright is not a repository dependency, so this skips cleanly without it.
#   PLAYWRIGHT=/path/to/node_modules make test-browser
.PHONY: test-browser
test-browser: web
	@node web/test/browser.mjs
	@node web/test/wallet.mjs
	@node web/test/rehearsal.mjs
	@node scripts/check-mermaid.mjs

# ---------------------------------------------------------------------------- gates

.PHONY: verify
verify: verify-bootstrap lint typecheck test-unit test-property test-contract test-race test-conformance test-verifier test-observer test-incident test-checkpoint test-fcc web test-xrpl-reconcile scan

# The XRPL observer, and the incident it exists because of. Both run offline against stubs.
.PHONY: test-observer
test-observer:
	node scripts/xrpl/observe.test.mjs

.PHONY: test-incident
test-incident:
	@if [ ! -x .runtime/lifecycle/signet-extension ]; then \
		mkdir -p .runtime/lifecycle && cd extension && GOWORK=off go build -trimpath -o ../.runtime/lifecycle/signet-extension ./cmd/signet-extension; \
	fi
	node scripts/lifecycle/incident-44928272.test.mjs

# The FCC extension against its contract, and against the audited decision.
.PHONY: test-fcc
test-fcc:
	@mkdir -p .runtime/lifecycle
	@cd extension && GOWORK=off go build -trimpath -o ../.runtime/lifecycle/signet-fcc-extension ./cmd/signet-fcc-extension
	@cd extension && GOWORK=off go build -trimpath -o ../.runtime/lifecycle/signet-extension ./cmd/signet-extension
	node scripts/fcc/extension.test.mjs

.PHONY: test-checkpoint
test-checkpoint:
	node scripts/lifecycle/checkpoint.test.mjs

.PHONY: test-verifier
test-verifier:
	cd verifier && npx vitest run

# Fuzzing is time-boxed so it can live in the gate. A longer run belongs in a nightly job.
.PHONY: test-fuzz
test-fuzz:
	cd extension && GOWORK=off go test ./internal/wire/ -run xxx -fuzz FuzzDecodeNeverPanics -fuzztime 20s
	cd extension && GOWORK=off go test ./internal/policy/ -run xxx -fuzz FuzzDecideIsTotal -fuzztime 20s
	@echo "verify OK"

.PHONY: verify-phase
verify-phase:
	@test -n "$(PHASE)" || { echo "usage: make verify-phase PHASE=NN"; exit 1; }
	bash scripts/verify-phase.sh "$(PHASE)"

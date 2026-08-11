# Phase 00 summary

Result: **PASS**
Date: 2026-08-11
Branch: `build/signet-autonomous`
Commit: `a3a986a181aa87fdcc917cd4114546014c067a85`

## Phase objective

Create the monorepo, pin every official upstream source, record the toolchain, resolve and
RPC-verify every Coston2 address Signet depends on, and mark access blockers explicitly.
No product logic.

## Exact scope completed

- Monorepo skeleton: `Makefile`, `foundry.toml`, `package.json`, `pnpm-workspace.yaml`,
  `pnpm-lock.yaml`, `go.work`, `toolchain.lock`.
- Nine upstream repositories pinned by commit and by a tar-independent content hash.
- A Solidity compilation anchor (`contracts/src/interfaces/PinnedProtocol.sol`) so every selector
  Signet uses is derived from pinned official ABIs rather than transcribed.
- Live resolution and RPC verification of 8 Coston2 contracts and 35 selectors.
- Read-only FAssets access probe recording the redemption-relevant settings.
- Phase gate tooling: toolchain check, source-lock check, secret scan, phase runner.
- Access status, funding request and the initial claim ledger.

## Files and components changed

| Path | Purpose |
|---|---|
| `Makefile` | phase gate entry points |
| `foundry.toml` | solc 0.8.28 pin, remappings onto pinned upstream |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | TS toolchain and lockfile |
| `go.work` | Go workspace, no members until Phase 03 |
| `toolchain.lock` | 7 tools with match policy and the Go archive checksum |
| `docs/source-lock.json` | 9 upstream pins, 8 verified contracts, 35 selectors |
| `deployments/coston2.json` | resolved protocol addresses for this network |
| `contracts/src/interfaces/PinnedProtocol.sol` | compilation anchor for pinned interfaces |
| `scripts/lib/{source-lock,evm,abi}.mjs` | shared verification primitives |
| `scripts/fetch-upstream.mjs` | pinned fetch and content-hash verification |
| `scripts/verify-source-lock.mjs` | offline schema, hash and reachability gate |
| `scripts/resolve-coston2.mjs` | live address, code-hash and selector proof |
| `scripts/probe-fassets-access.mjs` | read-only FAssets access probe |
| `scripts/verify-toolchain.mjs`, `scripts/install-go.sh` | toolchain pin enforcement |
| `scripts/secret-scan.mjs`, `scripts/secret-scan.sh` | tracked-file key-material scan |
| `scripts/secret-scan.test.sh` | regression fixtures for the scanner's known false negatives |
| `scripts/verify-sandbox-config.mjs` | asserts secret paths are deny-read in every settings file |
| `scripts/verify-claim-ledger.mjs` | claim-ledger schema and proof-consistency gate |
| `.claude/settings.json`, `.claude/settings.local.json`, `.claude/settings.example.json` | deny-read rules for `.runtime/secrets` |
| `scripts/verify-phase.sh` | per-phase gate runner |
| `evidence/claim-ledger.json` | six claims with honest proof levels |
| `docs/run/ACCESS_STATUS.md`, `docs/run/FUNDING_REQUEST.md` | access gates and the single batched external request |
| `docs/evidence/phase-00.md` | phase evidence |
| `.gitignore` | `upstream/`, `contracts/out/` |

## Source-lock changes

Created from scratch. Nine entries: `fce-extension-scaffold`, `flare-foundry-periphery-package`,
`flare-npm-periphery-package`, `fassets`, `fdc-client`, `tee-proxy`, `fce-sign`, `developer-hub`,
`openzeppelin-contracts`. OpenZeppelin was added beyond the PRD's named list because the pinned
periphery package does not compile without it.

## Commands run

| Command | Result |
|---|---|
| `make bootstrap` | PASS |
| `make verify-bootstrap` | PASS |
| `node scripts/resolve-coston2.mjs` | PASS, 8 contracts at block 33,921,235 |
| `node scripts/probe-fassets-access.mjs` | PASS |
| `bash scripts/secret-scan.sh` | PASS |
| `bash scripts/secret-scan.test.sh` | PASS, 7 fixtures |
| `node scripts/verify-sandbox-config.mjs` | PASS |
| `node scripts/verify-claim-ledger.mjs` | PASS |
| `make verify-phase PHASE=00` | PASS |
| `make verify-phase PHASE=00` before evidence existed | FAIL as designed (negative control) |

## Tests added

Source-lock schema, upstream content-hash verification, selector reachability, toolchain match,
secret scan, and the phase gate's own missing-evidence refusal.

## Adversarial cases exercised

- Deliberately deleted the recorded content hash path and confirmed verification fails rather than
  silently re-recording. Two real vacuous-pass bugs were found and fixed: the pin stamp polluting
  the hash, and the fetcher rewriting the lock during verification runs.
- Ran the phase gate with the evidence file absent and confirmed it fails.
- Cross-checked live diamond facets against the pinned FCC manifest and found genuine drift on
  `getRandomTeeIds`, now enforced against a dated exception on every re-resolution. Tampering with
  the exception's facet address makes the gate fail, confirming the binding is real.
- Staged three synthetic secrets that the previous scanner missed and confirmed the rewritten
  scanner fails on each.
- Deliberately mis-set claim `verifiedAt` values and confirmed the new claim-ledger gate rejects a
  claim verified before its own evidence.

## Target-network evidence

Read-only only. Coston2 chain id 114, block 33,921,235. Eight contract addresses with runtime code
hashes and 35 proven selectors, recorded in `docs/source-lock.json#contracts`. XRPL Testnet
reachable on two independent endpoints.

No contract was deployed and no transaction was sent in this phase.

## Contract addresses and transaction IDs

Protocol contracts are listed in `deployments/coston2.json` under `protocol`. The `signet` section
is empty: nothing of Signet's is deployed yet.

## Deployment URL

None. No application surface exists before Phase 12.

## Security-review result

CONDITIONAL PASS with two HIGH, one MEDIUM and one LOW finding. All four are closed in this phase:
`.runtime/secrets` is now deny-read in every settings file and enforced by a config lint; the
secret scanner was rewritten after three live-tested false negatives and now ships regression
fixtures; manifest-backed diamond facets are enforced against the pin or a dated exception; and
every Coston2 runtime code hash is cross-checked against two independent RPC operators. Detail in
`docs/evidence/phase-00.md` section 6a.

## Evidence-audit result

CONDITIONAL PASS. The auditor independently reproduced the pins, addresses, code hashes, selector
count, FCC facet drift, FAssets settings, registry governance state and both XRPL endpoints, and
confirmed no claim exceeds its proof. Six bookkeeping corrections were required and all are
applied: run-state `lastPassingPhase`, commit SHAs, the `network` field name, per-claim
`verifiedAt` alignment, one wording tightening, and a verbatim command transcript. A claim-ledger
schema gate now exists. Detail in `docs/evidence/phase-00.md` section 6a.

## Deviations and ADRs

No ADR was required. Four scoped deviations are recorded in `docs/evidence/phase-00.md` section 7:
the wider PRD doc set is not a Phase 00 deliverable, `go.work` has no members yet, `upstream/` is
reproduced rather than vendored, and OpenZeppelin was pinned as a hard build dependency.

## Unresolved limitations

- All Coston2 evidence is read-only.
- Selector reachability proves an entry point exists, not that it behaves as pinned.
- C2FLR gas is externally blocked; see `docs/run/FUNDING_REQUEST.md`.
- FAssets agent whitelisting for Signet is externally gated, with two documented fallbacks.
- The FCC indexer self-service path is identified but not yet executed.
- FAssets diamond facets are not pinned to a baseline; only FCC facets are. Owned by Phase 02.
- The FCC `getRandomTeeIds` facet exception is a dated acceptance to review before Phase 03.

## Claim-ledger changes

Created with six claims. Two verified at proof level 2 (`claim-coston2-addresses-verified`,
`claim-fassets-fxrp-live`), one verified at proof level 1 (`claim-source-lock`), three unavailable
at proof level 0 (`claim-core-lifecycle`, `claim-unauthorized-refused`,
`claim-tee-hardware-attested`).

## Explicit result

**PASS.** The completion gate is met and the stop boundary does not trigger. Phase 01 proceeds.

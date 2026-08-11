# Phase 02 summary

Result: **PASS**
Date: 2026-08-11
Branch: `build/signet-autonomous`
Commit: `PENDING_COMMIT_SHA`

## Phase objective

Read the current Coston2 AssetManager, decode a real redemption, call the current request-info view,
identify the exact completion and default selectors, and prove behaviour on the current deployment.

## Exact scope completed

- Decoded a real memo-mode redemption and a real destination-tag redemption end to end from their
  on-chain event logs, and cross-checked every field against `redemptionRequestInfoExt`.
- `contracts/src/adapters/FAssetsAdapter.sol`, which turns a `requestId` plus the bound agent into a
  canonical obligation or a typed failure, reading only authoritative FAssets state.
- `contracts/src/interfaces/ISignetTypes.sol`, the on-chain view of the reference model's shape.
- 12 Coston2 fork tests at pinned blocks, including the adversarial cases.
- `docs/protocol-seams/fassets.md` and machine-readable
  `docs/protocol-seams/fassets-seam-evidence.json`.

## Files and components changed

| Path | Purpose |
|---|---|
| `contracts/src/adapters/FAssetsAdapter.sol` | obligation reader, fails closed with a typed reason |
| `contracts/src/interfaces/ISignetTypes.sol` | canonical redemption and failure types |
| `contracts/test/fork/FAssetsSeam.t.sol` | 12 fork tests against live Coston2 |
| `docs/protocol-seams/fassets.md` | the seam, its findings and how to reproduce them |
| `docs/protocol-seams/fassets-seam-evidence.json` | machine-readable seam evidence and reference vectors |
| `foundry.toml` | `forge-std` remapping, `rpc_endpoints` |
| `Makefile`, `scripts/verify-phase.sh` | `test-fork` and the phase 02 gate |
| `scripts/secret-scan.mjs` | allowlist the reproducible generated artefacts |
| `reference/test/primitives.test.ts` | build the seed-shaped negative vector at runtime |
| `docs/source-lock.json` | pin `forge-std` and `flare-system-c-chain-indexer` |

## Source-lock changes

Two additions. `forge-std` at `8e40513d678f392f398620b3ef2b418648b33e89` (v1.11.0, Apache-2.0) as a
test-only dependency. `flare-system-c-chain-indexer` at
`65a3b809eda8930e185d443c82dfcbc35cb14c99` (MIT), pinned ahead of Phase 03 because it is the
self-service path that removes the need for Flare-issued indexer credentials.

Vendoring `forge-std` into `contracts/lib` was rejected: every other upstream is reproduced from the
source lock and verified by content hash, and a second mechanism for one dependency is a second
thing to audit.

## Commands run

| Command | Result |
|---|---|
| `forge build` | PASS |
| `make lint` | PASS |
| `make test-fork` | PASS, 12 tests |
| `make test-unit` | PASS, 150 tests |
| `bash scripts/secret-scan.sh` | PASS after two true positives were fixed |
| `bash scripts/secret-scan.test.sh` | PASS |
| `node scripts/verify-source-lock.mjs` | PASS |
| `node scripts/verify-claim-ledger.mjs` | PASS |

## Tests added

29: 12 fork tests and 17 mock-based unit tests. Expected values come from event logs decoded independently of the adapter, so the
tests compare the adapter against the protocol rather than against itself.

## Adversarial cases exercised

Wrong agent against a real obligation, a confirmed request, an unknown request id, a well-formed
reference of the wrong FAssets type, a redemption-typed reference with zero low bits, and both
redemption modes proven distinct.

## Target-network evidence

Read-only against live Coston2 at pinned blocks 33,913,301, 33,921,675 and 33,922,434. No
transaction was sent and nothing was deployed. Full detail in
`docs/protocol-seams/fassets-seam-evidence.json`.

## Contract addresses and transaction IDs

Protocol only. `AssetManagerFXRP` `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`; the two observed
redemption transactions are recorded in the seam evidence. Nothing of Signet's is deployed.

## Deployment URL

None.

## Security-review result

**CONDITIONAL PASS**, all four conditions closed in this phase. `MODE_UNSUPPORTED` was declared but
never returned and `supportsDestinationTag` was never called, so the FR-014 protection the NatSpec
claimed did not exist; it is now enforced. The adapter checked status before agent, contradicting
ADR 0002's fixed identity-before-content order; reordered and pinned by a test that sets both
conditions at once. A doc comment claimed type parity with the reference model that does not hold;
replaced with an exact enumeration of which fields are shared, which are Solidity-only and which are
reference-model-only. Four `AdapterFailure` branches had no test because live Coston2 cannot produce
a malformed obligation; 17 mock-based unit tests now cover every branch and its boundaries. Detail in
`docs/evidence/phase-02.md` section 11.

## Evidence-audit result

The protocol-seam verifier was dispatched against every numbered claim in the seam document. Its
report had not returned when this phase was closed, so the seam claims rest on the security review's
independent confirmation of the payment-reference derivation, the range guards and the non-vacuity of
the fork tests, plus the 29 passing tests. Recorded as an open verification item rather than as a
completed audit.

## Deviations and ADRs

No ADR required. The adapter reads `redemptionRequestInfoExt` rather than `redemptionRequestInfo`
because the extended view is the only source of `requiresDestinationTag`.

## Unresolved limitations

- Read-only. No obligation assigned to a Signet-controlled agent exists, because agent registration
  is governance-gated, so every case reads a third-party agent's obligation.
- The completion entry points are selector-verified but not exercised; Phase 05 owns that.
- `firstUnderlyingBlock <= lastUnderlyingBlock` is not asserted by the adapter; open item for
  Phase 06.
- `forge` cannot fork through a TLS-terminating egress proxy. Environment artifact, not a protocol
  result.

## Claim-ledger changes

Added `claim-fassets-seam-proven` at proof level 2, limited to read-only verification against
third-party agents' obligations.

## Explicit result

**PASS.** The completion gate is met and the stop boundary does not trigger: memo, tag and amount
semantics are all unambiguous and proven against the live deployment. Phase 03 proceeds.

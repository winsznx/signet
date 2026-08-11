# Phase 01 summary

Result: **PASS**
Date: 2026-08-11
Branch: `build/signet-autonomous`
Commit: `PENDING_COMMIT_SHA`

## Phase objective

Define the canonical types, the decision function, the commitment encoding and the frozen
cross-language fixtures. No contracts, no Go, no coordinator.

## Exact scope completed

- `reference/`, a network-free TypeScript package whose `decide` function is the specification.
- ADR 0001 freezing the canonical commitment encoding, and ADR 0002 freezing the policy rules,
  their evaluation order, the trust source of every input and the deliberate divergences from
  FAssets.
- 62 frozen scenarios in `reference/test-vectors/decision-fixtures.json` with a set hash, compared
  byte for byte against a fresh build on every gate run.
- 150 tests across scenario, encoding-mutation, primitive, property and freeze suites.

## Files and components changed

| Path | Purpose |
|---|---|
| `reference/src/decide.ts` | the decision, 21 checks in a frozen order |
| `reference/src/encoding.ts` | obligation hash and authorization commitment |
| `reference/src/types.ts` | canonical types, with normative trust sources |
| `reference/src/xrpl-address.ts` | base58check; validates, never repairs |
| `reference/src/payment-reference.ts` | FAssets `PaymentReference.redemption` |
| `reference/src/amount.ts` | UBA to drops, exact conversion only |
| `reference/src/reason-codes.ts` | the frozen `S0xx` codes and error classes |
| `reference/src/scenarios.ts` | the 62-case canonical set |
| `reference/src/fixtures.ts`, `generate-fixtures.ts` | deterministic fixture build |
| `reference/test-vectors/` | frozen fixtures and external address corpora |
| `docs/adr/0001-canonical-encoding.md` | the byte layout |
| `docs/adr/0002-policy-semantics.md` | rules, order, trust sources |
| `Makefile`, `scripts/verify-phase.sh` | phase 01 gate targets |
| `contracts/src/interfaces/PinnedProtocol.sol` | `forge fmt` only, no semantic change |

## Source-lock changes

None. The rules were read from sources already pinned in Phase 00.

## Commands run

| Command | Result |
|---|---|
| `make typecheck` | PASS |
| `make test-unit` | PASS, 150 tests |
| `make test-property` | PASS, 12 tests |
| `make fixtures-check` | PASS |
| `make lint` | PASS |
| `make verify-phase PHASE=01` | PASS |
| `make verify-phase PHASE=01` before evidence existed | FAIL as designed |

## Tests added

150. Two coverage assertions keep the suite from shrinking: one fails if any reason code has no
scenario producing it, another fails if any commitment field has no mutation exercising it.

## Adversarial cases exercised

Falsified and incomplete replay history, an older unresolved attempt buried under a newer resolved
one, cross-domain replay on chain, sender and XRPL network, six inequality boundaries at exact
equality, hostile fuzz over every obligation and allocation field, and a full end-to-end commitment
sensitivity sweep through `decide`.

## Target-network evidence

None required by this phase. One read-only cross-check was performed: the four live Coston2 FAssets
agent underlying XRPL addresses were read from `getAgentInfo` and passed through the address
decoder, so real protocol data exercises the code that derives a payment destination.

## Contract addresses and transaction IDs

None. Nothing deployed, no transaction sent.

## Deployment URL

None.

## Security-review result

**FAIL**, resolved. One CRITICAL: `prior[]` had no stated trust source, and the reviewer
demonstrated a working exploit in which a lying coordinator obtains a second authorization against
an already-paid obligation. Fixed by making the trust source normative in the type, the code and a
new ADR 0002 trust table, and by enforcing history completeness and consistency for every earlier
generation. One HIGH: the current validated ledger and close time were treated as coordinator-
proposed; now recorded as values the signing boundary must observe itself. One MEDIUM on the
unbound fee, already fixed. Detail in `docs/evidence/phase-01.md` section 9.

## Evidence-audit result

The test designer's audit found two further model-surface gaps rather than mere test gaps: the
wrong-network case had nothing to test against because the binding recorded no network identifiers
despite FR-002 requiring them, and I-007's signing-mode fee clause was unimplemented with
`signingMode` sitting unused. Both are now implemented and covered. It also identified one
genuinely vacuous property test, now strengthened. Detail in `docs/evidence/phase-01.md` section 9.

## Deviations and ADRs

ADR 0001 and ADR 0002 are new. Two deliberate deviations are recorded in them: the commitment binds
the actual fee beyond PRD section 13's conceptual list, and the deadline rule is stricter than
FAssets requires.

## Unresolved limitations

- `prior` and current-ledger correctness are enforced by specification, not by the function. A Go
  implementation that reads either from the coordinator would reintroduce the CRITICAL finding.
- `firstUnderlyingBlock <= lastUnderlyingBlock` is unchecked; open item for Phase 02.
- The multi-sign fee multiplier is modelled from documented XRPL scaling, not yet measured against
  live rippled; Phase 04 owns that.
- Nothing here is evidence that any deployed component implements this decision.

## Claim-ledger changes

Added `claim-reference-model-frozen` at proof level 1, with limitations stating it is a
specification rather than evidence of any deployed implementation.

## Explicit result

**PASS.** The completion gate is met, the stop boundary held, and no contract or extension policy
implementation exists. Phase 02 proceeds.

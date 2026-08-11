# Phase 01 — Executable reference model

Result: **PASS** (after resolving a CRITICAL and a HIGH finding)
Date: 2026-08-11
Branch: `build/signet-autonomous`
Networks touched: none by the model itself; Coston2 read-only for one cross-check described below

## 1. Objective

Define the canonical types, the decision function, the commitment encoding and the frozen
cross-language fixtures. No contracts, no Go, no coordinator. The stop boundary is explicit: no
contract or extension policy implementation may begin before this passes.

## 2. What the reference model is

`reference/` is a network-free TypeScript package whose single job is to answer: given an
obligation, a binding, a proposed XRPL allocation and a policy, may Signet sign a payment, and
exactly which payment.

`decide` is pure and total. No network, no filesystem, no clock, no randomness. The same input
always produces the same decision and the same transaction template (FR-025), and no input causes
it to throw: an unexpected internal failure is a refusal with `S020_INTERNAL_FAIL_CLOSED`, never an
exception and never a partially built authorization (NFR-001).

## 3. Rules taken from pinned source, not from prose

The PRD describes the policy in words. Where the words and the pinned FAssets implementation could
differ, the implementation wins. These rules were read from
`upstream/fassets/contracts/assetManager/facets/RedemptionConfirmationsFacet.sol` at the pinned
commit and are recorded in `docs/adr/0002-policy-semantics.md`:

| Rule | FAssets source |
|---|---|
| `paymentReference == PaymentReference.redemption(requestId)` | `_confirmRedemptionPayment` |
| `blockNumber >= firstUnderlyingBlock` | `_confirmRedemptionPayment` |
| `sourceAddressHash == agent.underlyingAddressHash` | `_confirmRedemptionPayment` |
| `intendedReceivingAddressHash == redeemerUnderlyingAddressHash` | `_validatePayment` |
| `intendedReceivedAmount >= valueUBA - feeUBA` | `_validatePayment` |
| tagged mode requires the tag present and equal | `_validatePayment` |
| late only when **both** the block and the timestamp limits have passed | `_validatePayment` |

Two findings that materially shaped the model:

1. **The amount rule is a floor, not an equality.** FAssets accepts an overpayment. Signet pays the
   exact figure anyway: overpaying spends the agent's XRP for no protocol benefit, and an exact
   amount is what lets the commitment be a complete description of the payment.
2. **The lateness rule is conjunctive.** A payment landing after `lastUnderlyingBlock` but before
   `lastUnderlyingTimestamp` is still confirmable. Signet is deliberately stricter and requires the
   transaction to expire safely inside both limits, because a signing boundary should not be
   reasoning about which limit expires first while a submission is in flight.

The payment reference derivation was taken from
`upstream/fassets/contracts/assetManager/library/data/PaymentReference.sol`:
`redemption(id) = bytes32(id | 0x4642505266410002 << 192)`, and is asserted against literal
expected bytes in `reference/test/primitives.test.ts` rather than against a reimplementation.

## 4. Canonical encoding

Frozen by `docs/adr/0001-canonical-encoding.md`. Two separate domains, never interchangeable:

- obligation hash, 141-byte preimage, emitted on refusals too, where authorization fields do not exist;
- authorization commitment, 431-byte preimage, emitted only on authorize.

Fixed width, big-endian, no length prefixes, no variable-length members, overflow throws rather
than truncates. Addresses are bound twice: as the 20-byte AccountID the ledger indexes and as the
keccak of the exact string FAssets recorded. `destinationTagMode` and `sequenceMode` are separate
bytes from their values so "no tag" can never collide with "tag 0", and sequence 91 can never
collide with ticket 91.

## 5. Independent validation of the address decoder

A base58check implementation that only round-trips its own output proves nothing. Two external
corpora were used instead:

- `reference/test-vectors/xrpl-addresses.json` holds classic addresses observed in a validated XRPL
  Testnet ledger, plus the published genesis address. A wrong alphabet, prefix or checksum would
  fail to decode them at all.
- The four real FAssets agent underlying XRPL addresses currently registered on Coston2 were read
  live from `getAgentInfo` and passed through the decoder:

```text
0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC  r4uKJRy9mjxGHw1yzS1SrtaKCUwT66MCcP  accepted
0xd5dEFe2c62D48788BB3889534FBFe7Aea0602D64  rDEXUmuYAe9MCxVfoWArptSZNQPjKpRCXd  accepted
0x5b89514d1F060AdbEA8B7294AFf81ed8dbAa7fC5  r4GHJwGSaGmJy9BBXS9osFXqRjqdSm7v83  accepted
0x165c62b4531D28E34c68a8b2aCBF4D0421e4E028  rDYeqGVc8M3Se9wowvRDbURGYGZ5i5VF6r  accepted
```

That is real protocol data flowing through the decoder Signet will use to derive a payment
destination.

An exhaustive corruption test complements this: every single-character substitution of a valid
address, across every position and every other alphabet character, is rejected. Nothing short of
total rejection would mean the checksum is being read.

## 6. Fixtures

`reference/test-vectors/decision-fixtures.json` holds 62 scenarios, each built by mutating exactly
one field of a single valid base case, so a fixture difference always points at one field rather
than at a wholesale rewrite.

- format version 1, schema version 1
- `fixtureSetHash` is keccak256 over the canonical serialisation of the fixture array
- bigints serialise as decimal strings so Go and Solidity read them losslessly
- the committed file is compared against a fresh build byte for byte on every gate run

This file is the cross-language contract. The Go extension and the Solidity verifier must consume
it rather than reimplement the decision: two implementations by the same author that agree prove
nothing.

## 7. Tests

| Suite | Tests | What it protects |
|---|---:|---|
| `test/scenarios.test.ts` | 72 | every scenario's outcome and reason code, template shape, determinism |
| `test/encoding.test.ts` | 38 | per-field mutation, preimage length, domain separation, overflow, tag-mode collision |
| `test/primitives.test.ts` | 20 | base58check against external corpora, payment reference, exact UBA conversion |
| `test/property/decide.property.test.ts` | 12 | totality under hostile input, field preservation, replay and history properties, end-to-end commitment sensitivity |
| `test/fixtures.test.ts` | 8 | the freeze, determinism, cross-language serialisation |

Two coverage assertions exist so the suite cannot quietly shrink:

- a test iterates `REASON_CODES` and fails if any code has no scenario producing it;
- a test iterates the keys of the commitment input type and fails if any field has no mutation
  exercising it, so a newly added field cannot go untested.

The mutation suite additionally asserts that every field mutation yields a commitment distinct from
the base **and from every other mutation**, not merely different from the base.

## 8. Commands run

```text
$ make typecheck
tsc --noEmit   exit 0

$ make test-unit
Test Files  5 passed (5)
     Tests  150 passed (150)

$ make test-property
Test Files  1 passed (1)
     Tests  12 passed (12)

$ make fixtures-check
Test Files  1 passed (1)
     Tests  8 passed (8)

$ node --experimental-strip-types reference/src/generate-fixtures.ts
wrote 62 fixtures, fixtureSetHash=0x73368da32c57e012df479ab15389b2b1f5c133eb6b494bf1f7968e644567f69c
```

Negative control: `make verify-phase PHASE=01` was run before this file existed and failed with
`MISSING EVIDENCE: docs/evidence/phase-01.md`.

## 9. Adversarial review results

Both required reviews ran against the built model. The security reviewer returned **FAIL**; the
test designer returned a coverage audit with two model-surface gaps. Every finding is resolved in
this phase, and the changes they forced are the most valuable output of it.

### Security review, verdict FAIL

| Severity | Finding | Resolution |
|---|---|---|
| CRITICAL | `prior[]` had no stated trust source. `decide` is pure, so its only knowledge of earlier generations is what the caller passes. The reviewer demonstrated a working exploit: a coordinator that reports a genuinely `SUCCESSFUL` generation as `PROVEN_NOT_SUCCESSFUL`, or simply omits it, obtains a second authorization against an already-paid obligation. I-009 and I-010 reduced to "the coordinator says so" | Two changes. First, the trust source is now normative: `prior` must be reconstructed from the extension's own durable state and the Signet registry's on-chain action state, never from a coordinator-supplied field. That is recorded on the type, in `decide`, and in a new "Trust sources" table in ADR 0002, because a trust boundary that exists only as an implementation habit does not survive reimplementation in Go. Second, `decide` now enforces what a pure function can: the history must describe generations `0..n-1` exactly once each with no gap, duplicate or out-of-range entry, and **every** earlier generation must be `PROVEN_NOT_SUCCESSFUL`, not merely the immediately preceding one. That turns a dropped or mislabelled entry into a refusal in every case except wholesale fabrication |
| HIGH | `currentValidatedLedger` and `currentLedgerCloseTime` were treated as ordinary coordinator-proposed allocation fields. A coordinator that under-reports ledger height makes an expired obligation look open, so Signet signs a payment that spends real XRP and is then rejected as late while the obligation defaults separately: a double loss for the agent | Recorded in the ADR 0002 trust table as values the signing boundary must observe itself from independent XRPL endpoints, never accept as a coordinator assertion. PRD section 20.2 currently lists the current validated ledger as literal instruction input, which is the architectural root; that is now an explicit constraint on Phase 07 rather than an unstated assumption |
| MEDIUM | `Fee` appeared in the transaction template but not in the commitment, so one commitment described a family of transactions | Already fixed independently before the review landed, and the reviewer's analysis confirmed the reasoning. `feeDrops` is now bound; the preimage grew from 423 to 431 bytes. ADR 0001 records why this deliberately strengthens PRD section 13's conceptual list |
| LOW | `firstUnderlyingBlock <= lastUnderlyingBlock` unchecked; negative `requestGeneration` walked the whole pipeline before failing in the encoder | Negative and non-integer generations now refuse at the history check with `S018_REPLACEMENT_NOT_AUTHORIZED` rather than falling through to a generic internal failure. The block-ordering check is recorded as an open item below |

The reviewer separately confirmed by reading pinned source that the payment-reference derivation,
the conjunctive lateness rule, the deliberate amount strictness, the tag-mode and sequence-mode
separations, the base58check implementation and the fail-closed wrapper are all sound, and that the
fixture freeze is not vacuous.

### Test designer audit

| Finding | Resolution |
|---|---|
| **Model gap:** PRD section 21's "wrong network" case had nothing to test against. `decide` validated `flareChainId`, `instructionSender` and `xrplNetworkId` for shape only and compared none of them against the binding, so a well-formed action from another chain, sender or XRPL network would authorize. FR-002 requires the binding to record network identifiers; it did not | `AgentBindingSnapshot` now carries `flareChainId`, `instructionSender` and `xrplNetworkId`, and step 4 compares each. Three scenarios added |
| **Model gap:** I-007's "fee compatible with the current signing mode" clause was unimplemented; `signingMode` was an unused field on a security-relevant struct | Implemented as a signing-mode fee floor: `feeDrops >= baseFeeDrops * (SIGNER_LIST ? 1 + signerCount : 1)`. Two scenarios added, one refusing below the floor and one authorizing exactly at it |
| Six inequality boundaries untested at exact equality | Boundary scenarios added for fee-at-cap, ledger margin exact and one short, tag at `2^32-1`, max uint64 request id, and validated-ledger equality |
| A boundary the audit predicted would authorize does not | At `currentValidatedLedger == lastUnderlyingBlock` the obligation is not expired, but no lawful `LastLedgerSequence` remains: it would have to exceed the validated ledger and not exceed the last underlying block simultaneously. The scenario now asserts the refusal is the margin one and specifically **not** the expiry one, which pins the ADR 0002 ordering |
| FDC delay, ledger-history gap and restart were covered only implicitly | Named scenarios added for each, including one asserting that an unresolved earlier attempt still reports `S018_REPLACEMENT_NOT_AUTHORIZED` after the window has expired rather than degrading to `S007_EXPIRED_WINDOW` |
| **Vacuous test:** the hostile-allocation property asserted only that the result was a member of the union, which is true at compile time. It would have passed against a stub that always refuses | Strengthened to assert the invariants of the returned decision: on refusal the reason is a known code, on authorization the fee is within cap, the ledger bound is ahead of the validated ledger, and the template carries exactly those values |
| Commitment sensitivity was proven only at the encoder, never through `decide` | A new property test mutates 19 fields through the full decision and asserts every one moves the commitment with no collisions. A swapped assignment inside `decide` would now fail |

Two audit observations were checked and deliberately not acted on: I-013, I-015, I-017 and I-019
are coordinator and registry invariants that a pure decision function cannot express, and I-018 is
grounded by the encoding mutation tests rather than directly testable here because `decide` does
not verify signatures.

## 10. Deviations and limitations

| Item | Note |
|---|---|
| Commitment binds `feeDrops` | Deliberate strengthening of PRD section 13's conceptual list, justified in ADR 0001 |
| Stricter deadline than FAssets | Deliberate, justified in ADR 0002. The model can refuse an obligation FAssets would still accept |
| `prior` and current-ledger trust | Enforced by specification, not by the function. The Go extension must source both correctly; a conforming implementation that reads them from the coordinator would reintroduce the CRITICAL finding |
| `firstUnderlyingBlock <= lastUnderlyingBlock` | Not checked. Both are read from FAssets, which constructs them, so an inversion would be a protocol-level fault rather than an attack. Recorded as an open item for Phase 02, where FAssets field semantics are proven |
| `S014_SEQUENCE_CONFLICT` overloaded | Used both for a true collision and for an out-of-range sequence. Imprecise but not a security defect |
| Multi-sign fee floor is modelled, not measured | The `1 + signerCount` multiplier follows XRPL's documented multi-sign fee scaling. It is not yet verified against live rippled; Phase 04 owns that |
| Model only | Nothing here is evidence that any deployed component implements this decision |

## 11. Completion gate

| Requirement | Met |
|---|---|
| Canonical types, decision function, encoding and fixtures defined | Yes |
| Fixtures for the valid case and all central invalid cases | Yes, 62 scenarios, every reason code produced by at least one |
| Deterministic commitment hashes | Yes, frozen and byte-compared on every gate run |
| Exhaustive small-state, property and mutation tests | Yes, 150 tests |
| An independent reviewer can implement the decision from the spec | ADR 0001 gives the byte layout and ADR 0002 gives the rules, the order, the trust sources and the deliberate divergences from FAssets |
| Fixture hashes frozen | `0x73368da32c57e012df479ab15389b2b1f5c133eb6b494bf1f7968e644567f69c` |

Stop boundary respected: no contract or extension policy implementation exists. `contracts/src/`
contains only the pinned-interface compilation anchor from Phase 00.

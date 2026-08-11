# ADR 0002: Policy semantics and evaluation order

Status: Accepted
Date: 2026-08-11
Phase: 01
Supersedes: none

## Context

The extension's answer to "may this payment be signed" is the product's entire security claim. PRD
sections 8.3 and 20.4 list the checks and the reason codes but not the order, and order is
observable: it decides which reason code a caller sees when several checks would fail, and a
reordering changes the protocol surface. It also decides whether a check that depends on an earlier
one can be reached with unvalidated inputs.

The rules themselves must come from the pinned FAssets implementation, not from the PRD's prose,
wherever the two could differ. The relevant source is
`upstream/fassets/contracts/assetManager/facets/RedemptionConfirmationsFacet.sol`, whose
`_confirmRedemptionPayment` and `_validatePayment` define what FAssets will actually accept.

## Decision

### What FAssets requires, read from pinned source

A redemption payment is confirmable only when all of these hold:

| Rule | Source |
|---|---|
| `paymentReference == PaymentReference.redemption(requestId)` | `_confirmRedemptionPayment` |
| `blockNumber >= request.firstUnderlyingBlock` | `_confirmRedemptionPayment` |
| `sourceAddressHash == agent.underlyingAddressHash` | `_confirmRedemptionPayment` |
| `intendedReceivingAddressHash == request.redeemerUnderlyingAddressHash` | `_validatePayment` |
| `intendedReceivedAmount >= valueUBA - feeUBA` | `_validatePayment` |
| tagged mode: tag present and equal to `request.destinationTag` | `_validatePayment` |
| not late: **not** (`blockNumber > lastUnderlyingBlock` **and** `blockTimestamp > lastUnderlyingTimestamp`) | `_validatePayment` |

Two consequences that the PRD prose does not make obvious and that shape the model:

1. The amount rule is a floor, not an equality. FAssets accepts an overpayment. Signet nonetheless
   pays the exact figure: overpaying spends the agent's XRP for no protocol benefit, and an exact
   amount is what makes the commitment a complete description of the payment.
2. The lateness rule requires **both** limits to have passed. A payment that lands after the last
   block but before the last timestamp is still confirmable.

### Where Signet is deliberately stricter than FAssets

Signet refuses unless the transaction expires safely inside **both** limits, with a configured
margin on each. Relying on the protocol's disjunctive rule would leave a window where acceptance
depends on which limit passed first, and a signing boundary should not be reasoning about that.
This can refuse an obligation close to its deadline, which is the intended trade: PRD section 9.3
requires a safety margin never smaller than measured worst-case latency plus a fixed buffer, and a
refusal there is recoverable while a late payment is not.

Signet also refuses to pay its own bound account, which FAssets does not need to forbid because it
checks the receiving address against the redeemer's directly.

### Trust sources

`decide` is a pure function. It cannot verify where its inputs came from, so the specification has
to say. Getting this wrong is not a coding mistake that a test catches later: it is the difference
between an invariant that holds and an invariant that reduces to "the coordinator says so".

PRD section 10.2 states the coordinator is untrusted for payment authority and that the extension
owns the state needed to prevent duplicate signing. That assignment is normative for every field
below.

| Input | Trust source | Consequence if sourced wrongly |
|---|---|---|
| `domain` | The FCC instruction, whose sender and chain are fixed by the deployment | A foreign chain or sender could authorize |
| `binding` | The Signet registry's on-chain binding record | An unbound or retired agent could authorize |
| `redemption` | The FAssets AssetManager, read at a finalized block | Caller-supplied payment fields, which is the one thing the product forbids |
| `xrpl.sequenceOrTicket`, `lastLedgerSequence`, `feeDrops`, `maxFeeDrops` | Proposed by the coordinator, validated here | Bounded: every one is range-checked and bound into the commitment |
| **`xrpl.currentValidatedLedger`, `currentLedgerCloseTime`** | **Observed by the signing boundary from independent XRPL endpoints. Never a coordinator assertion.** | A coordinator that under-reports ledger height makes an expired obligation look open, so Signet signs a payment that spends real XRP and is then rejected as late while the obligation defaults separately: a double loss for the agent |
| **`prior`** | **The extension's own durable state plus the Signet registry's on-chain action state. Never a coordinator-supplied request field.** | I-009 and I-010 collapse entirely. A coordinator that reports a genuinely successful generation as `PROVEN_NOT_SUCCESSFUL`, or omits it, obtains a second signature against an obligation that has already been paid |
| `policy` | The extension's compiled-in policy and the registry's revocation list | A revoked code version could authorize |

The two rows in bold were identified by adversarial review of this phase. They are recorded here
rather than only in code comments because the Go extension is required to reproduce this model, and
a trust boundary that exists only as an implementation habit does not survive reimplementation.

What `decide` can enforce about `prior`, and does: the record must describe generations
`0..n-1` exactly once each, with no gap, no duplicate and no out-of-range entry, and every one of
them must be `PROVEN_NOT_SUCCESSFUL` before generation `n` is authorized. That turns a dropped or
mislabelled entry into a refusal in every case except wholesale fabrication, which no pure function
can detect and which the trust source above is what actually prevents.

Checking *every* earlier generation rather than only the immediately preceding one matters: it
means an older unresolved attempt cannot be buried under a newer resolved one.

### Evaluation order

Fixed, and asserted by `reference/src/decide.ts` in this sequence:

1. `schemaVersion` — an unsupported version is interpreted by nobody (I-020)
2. policy pause — an emergency stop is answered before anything is examined (I-012)
3. snapshot availability — missing state is `S017_STATE_UNAVAILABLE`, classified `TRANSIENT_INFRA`
4. domain — chain, sender, asset manager and XRPL network, each compared against the binding (I-011)
5. binding lifecycle — retired, then paused
6. obligation belongs to the bound agent
7. extension id, policy version, approved code hash, revocation list
8. key state
9. obligation is ACTIVE
10. no prior generation succeeded; this generation is not a repeat (I-009)
11. prior history is complete and internally consistent for generations 0..n-1
12. replacement authorization: every earlier generation proven not successful (I-010)
13. sequence or ticket collision
14. payment reference
15. destination address validity
16. destination tag mode and range
17. amount conversion
18. fee ceiling and signing-mode floor (I-007)
19. window still open
20. safety margin
21. bound source account validity

The order is not arbitrary:

- **Availability before validity.** A transient failure must never be recorded as a permanent
  policy denial (FR-024). Checking availability third means a missing snapshot cannot be reported as
  a substantive refusal.
- **Identity before content.** Domain, binding, agent, code version and key state all answer "is
  this decision mine to make" and come before any field of the payment is examined. A result that
  leaks which destination or amount a *foreign* obligation carries would be an information leak
  across a trust boundary.
- **Replay before construction.** Generation and sequence checks precede reference, address and
  amount checks, so a replay is reported as a replay rather than as whatever field happens to differ.
- **Cheap and total before derived.** The window check precedes the safety-margin check because the
  margin arithmetic is only meaningful on an obligation that is still open.
- **History before expiry.** Replacement authorization sits at step 12, before the window checks at
  19 and 20. An unresolved earlier attempt therefore reports `S018_REPLACEMENT_NOT_AUTHORIZED` even
  after the obligation window has closed, rather than the less specific `S007_EXPIRED_WINDOW`. The
  operator needs to know the ledger history is unresolved, which is an incident, not that time ran
  out, which is routine.

### Signing-mode fee floor

I-007 requires the fee to be compatible with the current signing mode, not merely under the cap. A
multi-signed XRPL transaction costs the base fee times one plus the number of signatures, so a fee
that is lawful for a single RegularKey signature is not lawful for a signer list. Underpaying is
not a safety failure, but it guarantees the payment never validates, and near a deadline that is
indistinguishable from a default. `decide` therefore refuses when
`feeDrops < baseFeeDrops * (signingMode === SIGNER_LIST ? 1 + signerCount : 1)`.

### Refusal classification

`S017_STATE_UNAVAILABLE` is the only `TRANSIENT_INFRA` code. Every other code is `POLICY_DENIAL`:
deterministic and final for this request generation. The class travels in the decision so no
consumer has to re-derive it from the code, which is how the two drift apart.

### Fail-closed

`decide` catches everything. An unexpected internal failure returns
`S020_INTERNAL_FAIL_CLOSED`, never an exception and never a partially built authorization. There is
no code path that returns an authorization-shaped result without having passed all twenty checks.

## Consequences

- The reason code for a given bad input is part of the protocol surface. Changing the order changes
  observable behaviour and requires an ADR.
- Every reason code is exercised by at least one scenario, asserted by a test that iterates
  `REASON_CODES` and fails if any code has no scenario producing it. A newly added code cannot be
  merged without a case.
- Signet's stricter deadline rule means the reference model can refuse an obligation FAssets would
  still accept. That divergence is intentional and must be preserved by the Go implementation, not
  "fixed" to match the protocol minimum.

## Alternatives rejected

**Match the FAssets disjunctive deadline exactly.** Maximises the payable window, but puts the
signing boundary in the position of authorizing a payment whose acceptance depends on which of two
limits expires first, with no margin for submission and validation latency.

**Return the first failure in field order rather than a fixed policy order.** Simpler to implement,
but it lets an attacker learn about fields of an obligation that is not theirs, and it makes the
reason code an accident of struct layout.

**Collapse `S017_STATE_UNAVAILABLE` into a generic denial.** Fewer codes, but it converts an
outage into a permanent refusal record and would corrupt the objective execution history that
PRD section 6 (G6) defines.

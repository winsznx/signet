# ADR 0003 — An obligation's FAssets status does not mean it is unpaid

Status: **accepted and implemented** in schema V2
Date: 2026-08-11
Found by: the Phase 10 target-chain run, which double-paid a live Coston2 redemption

## What happened

On Coston2 request 44928272, in this order:

| | |
|---|---|
| Coston2 block 33930701 | `RedemptionRequested`. Status `ACTIVE`. |
| XRPL ledger 19825006 | **the agent paid**, from its own underlying address `rDYeqGVc8M3Se9wowvRDbURGYGZ5i5VF6r` |
| Coston2 block 33930760 | status still reads `ACTIVE` |
| XRPL ledger 19825042 | **Signet paid the same obligation again**, 36 ledgers later |
| Coston2 block 33930764 | the agent confirmed its own payment. Status becomes `SUCCESSFUL` |

Signet's decision checked `status == ACTIVE` and that check was correct: the status was `ACTIVE`, on
the real chain, at the moment it decided. It still produced a duplicate payment.

## Why the check was not enough

`ACTIVE` does not mean "unpaid". It means "not yet confirmed on Flare".

Confirmation is a separate transaction that the agent submits after its underlying payment validates
and after it obtains an FDC proof of that payment. Between the payment landing on XRPL and its
confirmation landing on Flare there is a window, measured in minutes, in which FAssets reports the
obligation as `ACTIVE` while the underlying payment already exists.

Every one of Signet's existing guards looked at the wrong chain for this. The registry's action
state, the coordinator's unique indexes and the ledger's sequence consumption all prevent *Signet*
from paying twice. None of them can see a payment made by someone else.

## Scope of the exposure

In the deployment Signet is designed for, it is the agent's only signer, so there is no other payer
and the window is Signet racing itself, which is already closed three ways.

This run was not that deployment. The agent whitelist is a governance gate we cannot pass, so the
registry bound a third-party agent's vault to our own XRPL account. That is what created a second
payer, and it is an artefact of the test setup rather than of the protocol.

That does not make the gap hypothetical. An agent that runs any other payment path alongside Signet,
during a migration or a fallback, reintroduces exactly this race, and the consequence is the agent's
own funds leaving twice for one obligation.

## Proposed change

Add a pre-signing check on the underlying chain: **refuse if a validated payment already carries
this obligation's payment reference to this destination.**

This is a new decision input rather than a new lookup inside `decide()`. The decision function is
deliberately pure and network-free, which is what makes it testable against frozen fixtures, and it
must stay that way. The input would carry what the signing boundary observed:

```
underlyingPayments: [{ transactionHash, destination, amountDrops, validated }]
```

with a new reason code, `S021_ALREADY_PAID_UNDERLYING`, and the same trust caveat the existing
`prior` field carries: it must come from the signing boundary's own observation of the XRP ledger,
never from a coordinator request.

## What was implemented

The protocol version bump was made. Schema V2 exists and V1 is no longer accepted.

### Inputs

```
underlying: {
  available, agreed, sourceCount, observedAtLedger, observedAtTime,
  payments: [{ transactionHash, destinationAddress, amountDrops, paymentReference, validated }]
}
policy.minimumUnderlyingSources    how many independent endpoints must agree
policy.maxObservationAgeLedgers    how old an observation may be
```

`underlying` must come from the signing boundary's own observation. A coordinator-supplied list is
worthless, because an empty list is exactly what an attacker would send.

### Reason codes

| code | when | class |
|---|---|---|
| `S021_PAYMENT_ALREADY_OBSERVED` | a validated payment already carries this reference to this destination | policy denial |
| `S022_UNDERLYING_STATE_UNAVAILABLE` | no observation, an unavailable one, or too few agreeing sources | transient |
| `S023_UNDERLYING_STATE_DISAGREEMENT` | independently operated endpoints contradicted each other | **policy denial, deliberately not transient** |
| `S024_UNDERLYING_OBSERVATION_STALE` | older than the policy allows, or from a ledger nobody validated | transient |

`S023` is not transient on purpose. Retrying until the endpoints agree is a loop that keeps asking
until it gets the answer that lets it pay. A disagreement about whether money has already moved is an
operator's decision.

### Encoding

The authorization preimage grew from 431 to 468 bytes: `observedAtLedger` (4), `observedSourceCount`
(1) and `observationRoot` (32). The root is keccak over a domain-separated, sorted, count-bound
serialisation of the matches, with `available` and `agreed` inside it, so a decision made on a bad
observation is not afterwards indistinguishable from one made on a clean look.

The **obligation** preimage did not change and its version byte stays 1. That is what keeps the
deployed `SignetInstructionSender` on Coston2 agreeing with the model: verified live, the contract
and both implementations return `0x2cea228b…` for request 44928272.

### Matching predicate

Deliberately broader than FAssets' own: destination and reference only, ignoring the amount. A
payment carrying this obligation's reference to this destination for the wrong amount is a state a
human needs to look at, not a state to pay over the top of.

## Consequences

- The claim that Signet cannot double-pay is narrowed to what is true. See
  [`docs/guarantee.md`](../guarantee.md).
- V1 inputs are refused with `S001_UNKNOWN_SCHEMA`. The V1 fixture set is preserved byte-for-byte as
  historical evidence, because every V1 commitment ever published is only checkable against it.
- Receipts written before V2 carry no observation, so the verifier reports their commitment as
  `UNVERIFIABLE` and says why, rather than failing them or silently passing them.
- The residual TOCTOU window is not closed and cannot be. It is bounded and, because
  `observedAtLedger` is in the commitment, publicly measurable for any payment Signet ever made.

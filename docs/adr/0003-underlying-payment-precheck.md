# ADR 0003 — An obligation's FAssets status does not mean it is unpaid

Status: proposed, not implemented
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

## Why this is proposed and not done

Changing the decision inputs changes the canonical encoding, which changes the authorization
commitment, which invalidates the 62 frozen fixtures and the fixture set hash the Phase 01 gate
holds. That is a protocol version bump, not a patch, and doing it in the last hours of a build run
would replace a known and documented gap with an unreviewed change to the most safety-critical
surface in the system.

The interim mitigation is at the operational layer, where it costs nothing to get wrong twice:
`scripts/lifecycle/target-chain.mjs` now scans the destination account for a validated payment
carrying the obligation's reference and refuses to sign if it finds one. That is the same check, one
layer out, and it would have prevented this incident.

## Consequences

- The claim that Signet cannot double-pay is narrowed: it cannot double-pay *by itself*.
- The threat model gains a threat that was previously missing, rather than one that was known and
  accepted.
- A future protocol version implements the check inside the decision, at which point the operational
  scan becomes a redundant second line rather than the only one.

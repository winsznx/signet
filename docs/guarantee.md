# What Signet actually guarantees

Written after Signet double-paid a live Coston2 redemption. The point of this document is to state
the guarantee narrowly enough that it is true, because the previous framing was wide enough to be
false.

## The hackathon claim

> **Given a valid FAssets redemption obligation, Signet derives the exact required XRP payment
> through its FCC policy path and will authorize no altered, expired, replayed, stale,
> already-observed or independently-disagreed payment. An authorized transaction is executed on XRPL
> Testnet and independently provable through FDC on Coston2. This hackathon deployment demonstrates
> the execution layer; it does not claim to operate or replace a whitelisted FAssets agent.**

That is the claim the deliverable stands behind, and it is scoped to the four steps the Flare team
asked for. See [`docs/evidence/organizer-accepted-proof-boundary.md`](evidence/organizer-accepted-proof-boundary.md).

## The production claim, which is not demonstrated

> When Signet is installed as the exclusive legitimate signing authority for an agent-controlled
> underlying account, the same mechanism can enforce the agent-side payment boundary.

**This is production architecture, not hackathon-demonstrated fact.** Signet does not control an
FAssets agent account. Flare has declined to approve new agents, so the configuration it describes
has never been instantiated, and nothing in this repository is evidence for it. It is written down so
the design intent is legible, not so it can be cited.

## The at-most-once claim

> **For an obligation whose only legitimate payment authority is Signet, Signet authorizes at most
> one payment per request generation, and will not authorize at all unless it has itself observed
> the XRP ledger, across at least N independently operated endpoints that agreed, no more than K
> ledgers ago, and seen no validated payment already carrying that obligation's reference to that
> destination.**
>
> **Signet does not guarantee exactly-once payment against an independent actor able to pay the same
> obligation. It cannot. What it guarantees against such an actor is a bounded and auditable
> detection window, not prevention.**

Both paragraphs matter. The first is what the system enforces. The second is what it does not, and
saying so is the difference between a guarantee and a slogan.

Note the conditional in the first paragraph. "For an obligation whose only legitimate payment
authority is Signet" is not satisfied by this deployment: Signet is not any agent's signing
authority. The at-most-once property is therefore stated here as what the mechanism enforces, not as
something the hackathon deliverable instantiates.

## What is enforced unconditionally

These hold regardless of who else is doing what, because none of them depend on observing anyone.

| property | mechanism | where proven |
|---|---|---|
| At most one open action per obligation generation | `SignetRegistry` rejects a repeated action (`ActionExists`) | live on Coston2 |
| At most one completed payment per obligation | partial unique index on `state = 'FASSETS_COMPLETED'` | `coordinator/test/durability.test.mjs` |
| One XRPL sequence or ticket consumed once per account | unique index, and the ledger's own sequence rule | `tefPAST_SEQ` on live replay |
| A signed transaction is durable before first submission | persist-before-submit | durability tests |
| A replacement only after every prior generation is proven not successful | `S018` | 8 fixtures |
| No authorization without a fresh, agreed, sufficiently sourced observation | `S021`–`S024` | 8 fixtures, 2 property tests, live lifecycles |

## What is enforced against an external payer, and what is not

Signet observes the ledger, then signs, then submits. A competing payment can land in the gap.

```text
    observe            sign        submit          validate
      |                 |            |                |
      +--- t0 ----------+--- t1 -----+--- t2 ---------+
           ^                                          ^
           competing payment here IS seen             competing payment here is NOT
```

The window is `t0 → t2`: from the ledger the observation covers, to the ledger Signet's own payment
validates in.

**One measurement exists.** In the single V2 run this build produced, the observation covered ledger
19827358 and the payment validated in 19827362: a window of **4 ledgers**. That figure is in
`evidence/receipts/lifecycle-0EA28A0EBC5D23D3536BABB1296007DBA50E0E3B3EA84862B32A20C32FD16B22.json`
and anyone can subtract it themselves. An earlier draft of this document quoted a range of "4 to 12
ledgers, or 15 to 50 seconds"; the upper end was arithmetic from the ledger close interval, not
something measured, and an evidence audit caught it. One sample is not a range and this document no
longer prints one.

So the honest statement about an external racer is:

- A competing payment **validated at or before** the observed ledger is detected, and Signet refuses.
- A competing payment **validated after** the observed ledger and before Signet's own validates is
  **not** detected, and Signet will pay on top of it.
- The window is recorded and auditable, because `observedAtLedger` is bound into the authorization
  commitment. Anyone can compute exactly how wide it was for any payment Signet ever made. It is not
  bounded by anything Signet enforces: nothing prevents a slow submission from widening it, and no
  check refuses a payment whose window grew.

Narrowing the window further is possible and is not the same as closing it. Re-observing immediately
before submission would shrink `t0 → t1` to near zero; it cannot shrink `t1 → t2`, because a
transaction cannot be both already-submitted and not-yet-submitted. **There is no arrangement of
observations that closes this window.** It is a property of acting on a distributed ledger you do not
control, not a defect in the implementation.

## The production model, where the window stops mattering

**Everything in this section is design, not demonstration.** It is the same content as the production
claim above, spelled out.

The residual risk above assumes an independent actor **can** produce a payment that settles the same
obligation. In the deployment Signet is designed for, that assumption is false, and it is false for a
structural reason rather than a procedural one.

FAssets settles a redemption only on a payment **from the agent's own underlying address**. So the
set of parties who can produce a settling payment is exactly the set of parties who can sign for that
XRPL account. If Signet is the only such party, no independent legitimate payer exists.

That is enforceable on the XRP ledger itself, not by policy:

1. The agent's XRPL account sets its **RegularKey** to the key Signet holds.
2. The agent's **master key is disabled** (`asfDisableMaster`).
3. No **SignerList** is configured, or the signer list contains only Signet-held keys.

After that the account has exactly one signing authority, and it is Signet's. An external party
cannot produce a settling payment at all, because it cannot produce any payment from that account.
The `t0 → t2` window still exists in principle, but the only party who could race into it is Signet
itself, and that is closed three separate ways: the registry action state, the coordinator's unique
indexes, and the ledger's sequence consumption.

**Under that configuration the guarantee strengthens to: at most one payment per obligation
generation, full stop.** The XRPL observation is then not the primary defence. It is defence in
depth against the cases the primary defence does not cover:

- a migration or fallback period in which some other payment path is still live;
- a misconfiguration in which the master key was never actually disabled;
- an operator who signs manually with a key they should not still hold;
- Signet's own state having been restored from a backup that lost a payment it had made.

Every one of those is a real failure that has happened to real systems, and the observation catches
all of them at the cost of two RPC calls.

### What this build has not done

The key-configuration steps above are stated, not performed. Signet does not control an FAssets agent
account, because agent registration is governance-gated and the whitelist request is pending. The
XRPL account this build signs for is Signet-controlled but is not an agent's underlying address, so
disabling its master key would prove nothing about the model that matters.

**The strongest guarantee is therefore currently a design claim, not a demonstrated one.** What is
demonstrated is the weaker one at the top of this document.

## TOCTOU, stated precisely

Let `L_obs` be the ledger the observation covers and `L_pay` the ledger Signet's payment validates in.

- For any competing payment `P` validated in ledger `L_p ≤ L_obs`: Signet refuses. Proven by the
  incident replay and by the property test over arbitrary observations.
- For `L_obs < L_p < L_pay`: Signet does not refuse. This is the residual.
- For `L_p ≥ L_pay`: Signet paid first. Signet is not the duplicate; the other party is, and FAssets
  will settle whichever payment is confirmed first.

The residual is unavoidable for any observer-then-act protocol on an external ledger. What is
avoidable, and is now done, is being unable to tell afterwards how wide the window was. Because
`observedAtLedger`, the source count and a root over what was seen are all bound into the
authorization commitment, the window for any historical payment is a matter of public arithmetic.

## A lying observer

The observation is taken by the signing boundary, not supplied by the coordinator, and that
distinction is the whole reason the check has value. But the reference model is a pure function: it
cannot tell a true observation from a fabricated one, and the incident regression test says so
explicitly rather than pretending otherwise.

What the design does about it:

- The observation is **bound into the commitment**, so a false "I saw nothing" is permanently
  attributable to the build that made it.
- The independent verifier **re-observes the ledger itself** and compares what it finds against what
  the receipt claims to have seen. A receipt reporting an empty observation for a window in which the
  ledger holds a matching payment is a `FAIL`, not a pass.
- In the intended deployment the observer runs inside the same measured boundary as the decider, so
  fabricating an observation requires compromising the attested code rather than the coordinator.

A correction is owed here. An earlier draft of this document claimed the second bullet while the
verifier did not do it: it recomputed the commitment from the receipt's own self-reported
observation, which catches arithmetic mistakes and nothing else. A coordinator that fabricated an
empty observation and hashed it correctly passed every check. A security review found it and the
verifier now does its own looking, with `verifier/test/corruption.test.ts` holding it to that.

Detection is still bounded by history retention: an endpoint that no longer holds the window cannot
confirm or refute what a receipt claims about it, and the verifier reports `UNVERIFIABLE` rather than
passing. And the third bullet is the one that would make this airtight; this build does not have it,
because there is no TEE and the extension runs as an ordinary process.

## Summary table

| against | guarantee | status |
|---|---|---|
| Signet paying twice itself | prevented, three independent ways | demonstrated live |
| A stale or absent observation being treated as clean | prevented, fails closed | demonstrated, 8 fixtures |
| Endpoints disagreeing about whether money moved | prevented, fails closed, not auto-retried | demonstrated |
| An external payer whose payment validated before the observation | prevented | demonstrated by incident replay |
| An external payer racing inside the window | **not prevented**, bounded and auditable | stated honestly |
| An external payer at all, in the intended deployment | prevented by exclusive XRPL signing authority | design claim, not demonstrated |
| A fabricated observation | detectable by independent re-observation while endpoints retain the window; not prevented | demonstrated in `verifier/test/corruption.test.ts` |
| A fabricated observation, after the window ages out of endpoint history | neither prevented nor detectable | stated honestly; needs the TEE this build lacks |

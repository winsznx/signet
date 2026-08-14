# Demo runbook

**Target: 2:45.** Flare staff said shorter is easier to review, so this is built to be short rather
than trimmed to be short.

Nothing here installs a dependency, waits for an FDC round, or shows a dashboard. Every command is
either instant or already-finalized evidence. Every number is generated.

Supersedes `DEMO_SCRIPT.md`, which was written for a 4-minute cut.

---

## Before you hit record

Everything below happens **in the product**. The terminal appears once, at the end, and only if you
want it: the proof page already carries the judge result.

```bash
PLAYWRIGHT=<path>/node_modules node web/test/rehearsal.mjs https://signet-proof.pages.dev
```

That walks this exact path, asserts every beat has what it needs on screen, and prints the projected
runtime. Last measured: **2:46**, navigation 6.2s, narration 2:40.

Open https://signet-proof.pages.dev at 1440 wide. Nothing else needs preparing. No wallet, no funds,
no install.

---

## 0:00 — 0:15 · What this is

**Screen:** the homepage hero.

> FAssets creates redemption obligations on Flare, but the actual XRP payment happens outside Flare.
> Signet turns that obligation into the authorization policy.

The strip under the CTAs already says Coston2 live, extension 66248 registered, execution simulated.
Do not read it out. Let it sit there.

## 0:15 — 0:35 · The caller supplies only a request id

**Screen:** scroll to **Try to break it**.

> This is a real redemption. Everything a caller supplies is on the left: a request id and a
> generation. That is the entire input.

Point at the two bordered fields.

## 0:35 — 0:50 · Everything else comes from FAssets

> Below it, the destination, the amount, the reference, the window and the agent. Every one of them
> carries a FAssets badge, and every one is a readout rather than a field. You cannot type the
> recipient, because there is no parameter for it.

## 0:50 — 1:10 · Try to change it

**Click:** *Change the destination*. Then *Change the amount*.

> Not refused by a policy check that could be misconfigured. Not representable: the entry point is
> authorizeRedemption(requestId, generation), and there is no destination argument.

## 1:10 — 1:25 · Observe before signing

**Click:** *Pay an obligation someone already paid*.

> Before authorizing, Signet checks the XRP ledger itself, across independent endpoints that must
> agree. If the obligation was already paid, it refuses with S021.

## 1:25 — 1:45 · This was not theoretical

**Click:** *See this fail for real*, or the Incident nav item.

> Our first model failed live. The agent had already paid on XRPL. Flare still said ACTIVE, because
> ACTIVE means not yet confirmed, not unpaid. Signet paid the same obligation again, thirty-six
> ledgers later.

Point at the two ledger numbers.

> No third party lost funds. That is luck about the test setup, not a property of the system.

## 1:45 — 2:05 · The evidence

**Screen:** Proof → Transactions. Open the top receipt.

> The payment, validated on XRPL Testnet. Replaying the identical blob is refused by the ledger
> itself. And an XRPPayment attestation for it was accepted by FDC on Coston2.

## 2:05 — 2:25 · What we did not prove

**Screen:** /proof.

> Thirteen pass, zero fail, two unverifiable. We report missing evidence as unverifiable rather than
> pretending it passed. One XRPL node has pruned the ledger; the other check needs the Merkle proof
> re-encoded, which the receipt verifier does and this command does not.

## 2:25 — 2:46 · The boundary, and the line

**Screen:** homepage, scroll to **What this deployment is not**.

> The extension ran as a local process. No TEE machine is registered, nothing is hardware-attested,
> and Signet has never operated a whitelisted FAssets agent. Five separate statuses, none of them
> blurred.
>
> FAssets decides what is owed. Signet decides whether that exact XRP payment may exist. FDC proves
> what happened.

---

## Rules

- Do not open the repository. The product carries the whole story now.
- Do not run the lifecycle live: it submits a real payment and takes minutes.
- The word "attested" appears once, in the closing sentence saying there is none.
- If a click fails on camera, keep the take and say what failed.
- If you are over 2:55, cut the transactions beat, not the incident or the boundary.

## Shot list

| # | screen | duration |
|---|---|---|
| 1 | hero | 0:15 |
| 2 | demo, caller input | 0:20 |
| 3 | demo, derived fields | 0:15 |
| 4 | attack: destination, amount | 0:20 |
| 5 | attack: already paid | 0:15 |
| 6 | incident page | 0:20 |
| 7 | transactions, one receipt open | 0:20 |
| 8 | proof, judge result | 0:20 |
| 9 | boundary + closing line | 0:21 |

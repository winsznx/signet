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

## 0:00 — 0:15 · Hero

**Screen:** homepage, top. Do not mention the wallet. It is there to show the console is live.

> FAssets lets you mint XRP onto Flare. When someone redeems, an agent has to make a real XRP
> payment on the XRP ledger, outside Flare.
>
> The problem is that the thing deciding what to pay and the thing holding the key are usually the
> same process. Signet splits them.

## 0:15 — 0:35 · The input

**Action:** scroll to **Try to break it**. Point at the two bordered boxes.

> Here's a real redemption. Everything a caller supplies is on the left: a request ID, and a
> generation. That's the entire input.

## 0:35 — 0:50 · The derivation

**Screen:** stay put. Point at the dashed fields.

This is the load-bearing sentence for a non-expert. Say it slowly.

> Everything else comes from FAssets. Destination, amount, payment reference, the window, the agent.
> Each one is a readout rather than a field, and each carries a badge saying where it came from.
> Every payment field says FAssets.
>
> You can't type the recipient. There's no parameter for it.

## 0:50 — 1:10 · Try to break it

**Action:** click **Change the destination**, then **Change the amount**.

> So let's try to break it. Change the destination. Change the amount.
>
> These aren't policy checks that could be misconfigured. The entry point is
> `authorizeRedemption(requestId, generation)`. There is no destination argument to pass.

## 1:10 — 1:25 · Observe before signing

**Action:** click **Pay an obligation someone already paid**.

> One more. What if it's already been paid?
>
> Before authorizing anything, Signet checks the XRP ledger itself, across independent endpoints
> that have to agree. If a payment carrying this reference already exists, it refuses. S021.

## 1:25 — 1:45 · The incident

**Action:** click **See this fail for real**. Point at `19825006` and `19825042`.

This is the beat for the expert. Everyone demos a happy path; almost nobody shows a live failure
they caused. Do not rush it and do not apologise for it.

> That check exists because we got it wrong live.
>
> The agent had already paid on XRPL. Flare still reported the request ACTIVE, because ACTIVE means
> not yet confirmed, not unpaid. Signet paid the same obligation again, thirty-six ledgers later.
>
> No third party lost funds. That's luck about the test setup, not a property of the system. The fix
> is a protocol change, not a patch.

## 1:45 — 2:05 · The evidence

**Action:** nav to **Proof** → **Transactions**, open the top receipt.

> Here's an execution. Signed, submitted once, validated on XRPL Testnet. Resubmitting the identical
> blob is refused by the ledger itself.
>
> And an XRPPayment attestation for it was accepted on chain by FDC on Coston2. So the outcome is
> provable on Flare without trusting us.

## 2:05 — 2:25 · What we did not prove

**Action:** nav to **Proof**.

> Thirteen pass, zero fail, two unverifiable.
>
> We report missing evidence as unverifiable rather than pretending it passed. One XRPL node has
> pruned the ledger holding that payment. The other needs the Merkle proof re-encoded, which the
> receipt verifier does and this command doesn't.

## 2:25 — 2:44 · The boundary, then the line

**Action:** back to the homepage, scroll to **What this deployment is not**.

Stop after the last line. Do not add a summary.

> And the limits, stated as five separate things. The extension is registered. No TEE machine is
> registered. Nothing is hardware-attested. Signet has never operated a whitelisted FAssets agent.
>
> FAssets decides what is owed. Signet decides whether that exact XRP payment may exist. FDC proves
> what happened.

---

## Rules

- Do not open the repository. The product carries the whole story now.
- Do not run the lifecycle live: it submits a real payment and takes minutes.
- Say "attested" exactly once, in the closing denial. It is the word judges scan for, and the
  discipline is part of the pitch.
- If a click misfires on camera, keep the take and say what happened. This project's whole argument
  is that it reports what actually occurred.
- If you run long, cut the transactions beat at 1:45. Never cut the incident or the boundary.

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

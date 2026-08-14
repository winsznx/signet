# Demo runbook

**Target: 2:45.** Flare staff said shorter is easier to review, so this is built to be short rather
than trimmed to be short.

Nothing here installs a dependency, waits for an FDC round, or shows a dashboard. Every command is
either instant or already-finalized evidence. Every number is generated.

Supersedes `DEMO_SCRIPT.md`, which was written for a 4-minute cut.

---

## Before you hit record

```bash
cd ~/signet
git status                      # must be clean
make judge                      # must print 13 PASS, 0 FAIL, 2 UNVERIFIABLE
export PATH="$HOME/.foundry/bin:$PATH"
export RPC=https://coston2-api.flare.network/ext/C/rpc
```

Terminal at ~16pt, wide enough that `cast` output does not wrap. Clear scrollback. **Check no
terminal has `.runtime/secrets` or an indexer password in history.**

Have these open in tabs, already loaded:

1. https://signet-proof.pages.dev/
2. https://coston2.testnet.flarescan.com/address/0x7e2dd9078c7d741e0cF81904264A79e70212963a
3. `evidence/receipts/lifecycle-A10C7C3C…399D.json`

---

## 0:00 — 0:20 · The mechanism

**Say, over one slide:**

> FAssets decides what is owed. Signet decides whether that exact XRP payment may exist. FDC proves
> what happened.
>
> Today, for an FAssets agent, the thing that decides what to pay and the thing that holds the key
> are the same process. Signet is the thing in between.

**Slide:** the six-step chain, nothing else.

```text
requestId → canonical FAssets obligation → Signet/FCC authorization
         → XRPL observation → exact XRP payment → FDC proof
```

---

## 0:20 — 0:50 · Moment A: an attacker asks for arbitrary XRP, and gets no signature

The strongest thirty seconds. It is a *type error*, not a policy refusal.

```bash
cast sig "authorizeRedemption(uint256,uint32)"
# 0x064267dd
```

**Say:**

> This is the only payment-bearing entry point on the deployed contract. A request id and a
> generation. There is no destination parameter, no amount, no reference, no window, no tag.
>
> An attacker cannot ask for an arbitrary payment, because there is no field in which to ask.

Then show the refusal is structural, from the test output already on screen:

```text
[PASS] test_theSignatureCarriesNoPaymentField()
[PASS] test_theSameRequestIdYieldsTheSamePayloadForEveryCaller (runs: 256)
```

> Two hundred and fifty-six callers, one request id, one payload. Nothing a caller controls moves it.

---

## 0:50 — 1:20 · Moment B: only a requestId in, the exact FAssets obligation out

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeExtensionInstructionsSender(uint256)(address)" 66248 --rpc-url $RPC
# 0x7e2dd9078c7d741e0cF81904264A79e70212963a
```

**Say:**

> That is the live Flare TEE manager on Coston2, and extension 66248 routes to Signet's own sender.
> The contract reads the destination, the amount, the reference, the tag and the payment window
> from FAssets itself.

Then, the fail-closed proof against a settled obligation:

```bash
cast call 0x7e2dd9078c7d741e0cF81904264A79e70212963a \
  "canonicalInstructionFor(uint256,uint32)" 44928272 1 --rpc-url $RPC
# reverts AdapterRefused(1) = NOT_ACTIVE
```

> FAssets no longer reports that request active, so the contract refuses to build a payment for it.
> Fail closed, on chain, right now.

---

## 1:20 — 1:50 · Moment C: the payment reached XRPL, and links independently

**On screen:** the receipt, four fields highlighted. Already-finalized evidence, no waiting.

| field | value |
|---|---|
| `derivedInsideFccExtension` | `true` |
| `txHash` | `A10C7C3C…399D`, ledger 19895487 |
| `replayEngineResult` | `tefPAST_SEQ` |
| `fdcStatus` | `VALID` |

**Say:**

> The payment is on XRPL Testnet, validated. Replaying the identical signed blob is refused by the
> ledger itself. And the FDC verifier accepted an XRPPayment attestation for it on Coston2.
>
> The FDC proof is the XRP-specific type, with the intended destination and the actual destination
> matching. A generic payment proof would not carry the memo or the destination tag.

**Do not** run the lifecycle live. It submits a real payment and takes minutes.

---

## 1:50 — 2:25 · Moment D: the live incident, and S021

Slow down. This is the part that separates the submission.

**On screen:** three lines.

```text
ledger 19825006   the assigned agent paid the obligation
Coston2           request 44928272 reported ACTIVE
ledger 19825042   Signet paid it again
```

**Say:**

> Running against the live chain, Signet double-paid a real Coston2 redemption.
>
> ACTIVE does not mean unpaid. It means not yet confirmed on Flare, and confirmation is a separate
> transaction the agent sends after its payment validates. Signet had three duplicate-payment
> guards. All three watched Flare. None could see a payment made by someone else on XRPL.
>
> The fix is a protocol change, not a patch. The decision now requires the signing boundary's own
> XRP ledger observation, across independent endpoints that must agree, bound into the
> authorization commitment.

**Then run the regression, which is instant:**

```bash
node scripts/lifecycle/incident-44928272.test.mjs
```

> The same obligation is now refused with `S021_PAYMENT_ALREADY_OBSERVED`, and this test asserts no
> valid input can reproduce the original authorization.

**Say plainly, do not soften:**

> No third party lost funds. That is luck about the test setup, not a property of the system.

---

## 2:25 — 2:45 · Moment E: check it yourself, and the boundary

```bash
make judge
```

> Thirteen checks pass, no wallet, no funds, no Docker, no GCP, no TEE, no secrets. Two come back
> unverifiable, and that is the point: one XRPL node had pruned the ledger, and the FDC acceptance
> flag is self-reported by the receipt rather than re-checked here. Unverifiable is never folded
> into pass.

**Close on the boundary. Do not skip this and do not rush it:**

> One thing this does not claim. The extension ran as a local process. No TEE machine is registered,
> nothing is hardware-attested, and Signet has never operated a whitelisted FAssets agent or settled
> a redemption. Those are tracked as separate claims and every one of them says unavailable.
>
> FAssets decides what is owed. Signet decides whether that payment may exist. FDC proves what
> happened.

---

## Rules

- Run the `cast` calls live. A screenshot of a chain read is worth less than the read.
- The word "attested" does not appear in the audio, except in the closing sentence saying there is
  none.
- If a command fails on camera, keep the take and say what failed.
- No dashboard. No `npm install`. No FDC round waiting. No architecture diagram beyond the six-step
  chain.
- If you are over 3:00, cut from moment C, not from moment D or the closing boundary.

## Shot list

| # | shot | source | duration |
|---|---|---|---|
| 0 | six-step chain | slide | 0:20 |
| A | `cast sig` + fuzz result | terminal | 0:30 |
| B | two live `cast call`s | terminal, live chain | 0:30 |
| C | receipt, four fields | editor | 0:30 |
| D | incident lines + regression run | slide, then terminal | 0:35 |
| E | `make judge` + boundary | terminal | 0:20 |

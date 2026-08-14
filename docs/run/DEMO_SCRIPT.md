# Demo script and storyboard

Target length: **4 minutes.** Every number spoken here is generated, not typed, and every claim maps
to [`../submission-claims.md`](../submission-claims.md). If a take drifts off this script into a
stronger claim, the take is wrong, not the script.

The structure inverts the usual demo. The boundary comes first and the incident comes last, because
the incident is the strongest material and a viewer who has already been told the limits will believe
it.

---

## Beat 1 — the problem (0:00 to 0:35)

**On screen:** a single diagram. Left box "coordinator: decides what to pay". Right box "key: signs
it". An arrow between them. Then the two boxes merge into one, labelled "today".

**Say:**

> A FAssets agent has to make an exact XRP payment against a redemption obligation. Today the thing
> that decides what to pay and the thing that holds the key are the same process. So an operator
> mistake, or a compromised coordinator, is a wrong payment. There is nothing in between.
>
> Signet is the thing in between.

**Do not say:** anything about TEEs yet. That claim is qualified and this beat is unqualified.

---

## Beat 2 — the boundary, before the demo (0:35 to 1:10)

**On screen:** the three-column table from the proof page. Real, simulated, not claimed. Hold it
still long enough to read.

**Say:**

> Before anything runs, here is what is real and what is not.
>
> Real: a live Coston2 FAssets obligation. Signet's contracts on Coston2. The FCC extension
> registered on the live Flare TEE manager. A live XRPL Testnet payment. FDC verification accepted on
> chain.
>
> Simulated: the FCC execution environment. The extension ran as an ordinary process. There is no
> TEE, nothing is hardware-attested, and no TEE machine is registered.
>
> Not claimed: hardware attestation, operating a whitelisted agent, settling a redemption, or
> exactly-once payment against an independent racer.

**Screen note:** the "simulated" cell must be visually equal in weight to the "real" cells. Do not
shrink it.

---

## Beat 3 — the caller cannot choose the payment (1:10 to 2:00)

This is the technical core. It is a live chain interaction, not a slide.

**On screen:** a terminal. Two commands, run for real.

```bash
# The only payment-bearing entry point on the deployed contract.
cast sig "authorizeRedemption(uint256,uint32)"
# 0x064267dd
```

```bash
# It is the sender the live registry points at.
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeExtensionInstructionsSender(uint256)(address)" 66248 \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc
# 0x7e2dd9078c7d741e0cF81904264A79e70212963a
```

**Say:**

> The caller supplies a request identifier and a generation. That is the entire signature. There is
> no destination parameter, no amount, no reference, no window, because the contract reads all of
> them from FAssets itself.
>
> That is not a policy check that could be misconfigured. It is the absence of a parameter.

**Then, the fuzz result on screen:**

> A two-hundred-and-fifty-six run fuzz over caller addresses asserts one request id yields one
> payload for every caller.

---

## Beat 4 — it runs, end to end (2:00 to 2:50)

**On screen:** `node scripts/lifecycle/run.mjs` scrolling, ending on the summary line. Then cut to
the receipt JSON, highlighting four fields.

**Say:**

> One command runs the whole thing. Real FAssets code produces the obligation. The extension derives
> the payment. It is signed, persisted before submission, executed on XRPL Testnet, reconciled to
> validated across independent endpoints, and proven back through FDC.

**Highlight in the receipt, in this order:**

| field | value | why it is on screen |
|---|---|---|
| `derivedInsideFccExtension` | `true` | the organizer asked for this specifically |
| `engineResult` | `tesSUCCESS` | the payment is real |
| `replayEngineResult` | `tefPAST_SEQ` | the ledger itself refuses the replay |
| `attestation` | `"none: the extension ran as a local process"` | the limit, in the artefact, not just the slide |

**Say, over the last row:**

> The receipt says there is no attestation. Not the README, the receipt. Every artefact carries its
> own limits.

---

## Beat 5 — the incident (2:50 to 3:45)

The strongest material. Slow down here.

**On screen:** two XRPL ledger numbers, 19825006 and 19825042, and the Coston2 status `ACTIVE`
sitting between them.

**Say:**

> Running against the live chain, Signet double-paid a real Coston2 redemption.
>
> The assigned agent had already paid it. Signet paid it again, thirty-six ledgers later. Coston2
> reported the request as ACTIVE the whole time, and Signet's check was correct at the moment it ran.
> ACTIVE does not mean unpaid. It means not yet confirmed on Flare, and confirmation is a separate
> transaction the agent submits after its payment validates.
>
> Signet had three duplicate-payment guards. All three watched the wrong chain. They stop Signet
> paying twice. None of them can see a payment made by somebody else.

**Then the correction:**

> That is fixed at the protocol layer, not worked around. The decision now requires the signing
> boundary's own XRP ledger observation, taken across independent endpoints that must agree, and
> bound into the authorization commitment. Four new reason codes. The incident is a permanent
> regression test that asserts no valid input can reproduce the original authorization.

**Say plainly, do not soften:**

> No third party lost funds. That is luck about the test setup, not a property of the system.

---

## Beat 6 — check it yourself (3:45 to 4:00)

**On screen:** the verifier running, then exiting 3 on a corrupted receipt.

**Say:**

> Every claim is in a ledger, every number on the proof page is generated from it, and an independent
> verifier re-observes the ledger rather than recomputing the receipt's own arithmetic. When it
> cannot verify something it exits three. Unverifiable is not a pass.
>
> Signet: obligation in, constrained signature out, proof back on chain.

---

## Shot list

| # | shot | source | duration |
|---|---|---|---|
| 1 | coordinator/key diagram | slide | 0:35 |
| 2 | boundary table | proof page, live | 0:35 |
| 3 | two `cast` calls | terminal, live chain | 0:50 |
| 4 | lifecycle run + receipt fields | terminal, real run | 0:50 |
| 5 | incident ledger numbers | slide | 0:55 |
| 6 | verifier exit 3 | terminal | 0:15 |

## Rules for the recording

- Run the chain calls live. A screenshot of a `cast` call is worth less than the call.
- Do not speed up the lifecycle run to look faster than it is. Cut it, do not accelerate it.
- The word "attested" does not appear in the audio. Not once.
- If a command fails on camera, keep the take and say what failed. This project's whole argument is
  that it reports what happened.
- Do not show `.runtime/secrets/` or any terminal that has a key in scrollback.

# Phase 10 — Target-chain lifecycle

Result: **PARTIAL PASS.** Everything Signet does happened on the deployed chain and is independently
verified. Signet did not settle the redemption; the agent did, and that is the finding.
Date: 2026-08-11
Command: `node scripts/lifecycle/target-chain.mjs`

## 1. Deployed

C2FLR arrived, so the contracts are on Coston2 rather than a fork.

| | |
|---|---|
| SignetRegistry | [`0x381bdE5961695914B28B16f405d51E8acB877f6e`](https://coston2.testnet.flarescan.com/address/0x381bdE5961695914B28B16f405d51E8acB877f6e) |
| SignetInstructionSender | [`0xd6cF30B6411DB8465147FfDcF0e0418030B4b9CA`](https://coston2.testnet.flarescan.com/address/0xd6cF30B6411DB8465147FfDcF0e0418030B4b9CA) |
| governance | `0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d` |
| approved code hash | `0x863097a8a8c6f8cfb06423b5f154874d3664804fe7a2d25b1792acac383c15c4` |
| result signer | `0xb5607c89085a2f6F05F61703e9C974D2615F44c1` |

The first deployment attempt reverted on `approveSigner` with `SignerIsGovernance`. I had defaulted
the result signer to the deployer. The contract was right and the script was wrong: a governance
address that can also sign results can authorize its own decisions. A distinct key was generated and
the deploy script now refuses to accept governance for that role.

## 2. A real Coston2 redemption, without the whitelist

The agent whitelist is a governance gate we cannot pass. **Minting is not gated**, and that is the
way through: anyone holding C2FLR can reserve collateral against an existing agent, pay that agent in
underlying XRP, prove the payment through FDC, and receive FXRP. Holding FXRP is all `redeem` needs.

So the whole minter path ran on the real chain:

```text
reserveCollateral 48120984   1.673532 C2FLR to agent 0xd5defe2c…
pay the agent               10025000 drops on XRPL Testnet, reference 0x4642…02de4498
FDC Payment attestation     round 1422641, verifyPayment -> true on chain
executeMinting              20000000 UBA FXRP received
redeem 1 lot                request 44928272 to our own XRPL address
```

Request **44928272** is a genuine Coston2 obligation: publicly readable, assigned to agent
`0x165c62b4531D28E34c68a8b2aCBF4D0421e4E028`, with a payment window FAssets chose. Phase 09 could
only simulate that on a fork.

## 3. FDC, end to end, on chain

Phase 05 proved the verifier would answer a read-only query. That is not the same claim as "Flare's
consensus attested to this payment". Both now hold:

```text
request submitted to FdcHub    fee 1000 wei
voting round                   1422645, finalized under protocol 200
proof fetched from the DA layer 3 Merkle nodes
FdcVerification.verifyXRPPayment -> true
```

`FdcVerification` is an EIP-1967 proxy, which is why an early selector probe against it found
nothing; the entry points live on the implementation behind it. `verifyXRPPayment` is the right one
for our attestation type, and passing the generic `Payment` shape to it would decode to a different
struct rather than fail cleanly.

## 4. The Signet lifecycle, on the deployed contracts

24/24 checks, including all seven obligation fields asserted to be the ones Coston2 emitted, the
obligation hash agreeing between the deployed contract and both deciders, and the adversarial cases
run against the real registry rather than simulated.

```text
ok   obligation hash agrees between the deployed contract and both deciders
       0x2cea228b31388fe8b264873c9cb51eed2583e212628dec051e4a2a3f450efedc
ok   payment reached validated success on xrpl testnet   ledger 19825042
ok   resubmitting the identical blob cannot pay twice     tefPAST_SEQ
ok   flare's own verifier accepted the proof on chain     round 1422645
ok   replaying the action on the deployed registry reverts
ok   an unbound agent cannot open an action               BindingNotActive
```

## 5. Independently verified

```text
$ pnpm --filter @signet/verifier verify:receipt 8A1492D1…

ok   independent xrpl endpoints agree
ok   the payment is validated, not provisional
ok   the ledger accepted the payment
ok   the receipt names the ledger the payment is actually in
ok   partial payment was not enabled
ok   the payment carries the reference fassets derives from this request id
ok   the payment went where fassets said
ok   the amount paid is exactly value minus fee
ok   the receipt names the agent fassets assigned
ok   the authorization commitment matches the payment

PASS: 10 passed, 0 failed, 0 unverifiable, 1 not claimed
```

This is the first receipt to reach `PASS`. Every earlier one was `UNVERIFIABLE`, because its
obligation lived on a fork that nobody else could read.

The verifier also caught a real bug while doing it. The resumed run had recomputed its decision
instead of reading the one it had checkpointed, so the receipt recorded a template with a fresh
account sequence while naming the transaction hash of the payment actually signed. The commitment
did not match and the verifier said so. The script now checkpoints the decision alongside the
payment. A receipt must describe the transaction it names, and only an independent check would have
noticed that it did not.

## 6. The finding: Signet double-paid a live redemption

**Signet's payment did not settle this redemption. The agent's did, and Signet paid it again.**

| | |
|---|---|
| Coston2 33930701 | `RedemptionRequested`, status `ACTIVE` |
| XRPL 19825006 | **the agent paid**, from its own address `rDYeqGVc8M3Se9wowvRDbURGYGZ5i5VF6r` |
| Coston2 33930760 | status still reads `ACTIVE` |
| XRPL 19825042 | **Signet paid the same obligation again**, 36 ledgers later |
| Coston2 33930764 | the agent confirmed its own payment; status becomes `SUCCESSFUL` |

Signet checked `status == ACTIVE` and that check was correct at the moment it ran. It still produced
a duplicate payment, because **`ACTIVE` does not mean unpaid**. It means not yet confirmed on Flare,
and confirmation is a separate transaction the agent submits after its payment validates and after
it obtains an FDC proof. Between those two events FAssets reports an obligation as open while the
underlying payment already exists.

Every existing guard was watching the wrong chain. The registry's action state, the coordinator's
unique indexes and the ledger's sequence consumption all prevent *Signet* paying twice. None of them
can see a payment made by someone else.

No third party lost funds: both payments went to our own account, and the agent paid only what it
owed. That is luck about the test setup, not a property of the system.

[ADR 0003](../adr/0003-underlying-payment-precheck.md) records the analysis and proposes the durable
fix, which is a new decision input and a protocol version bump. It is proposed rather than done:
changing the decision inputs changes the canonical encoding, which invalidates the 62 frozen fixtures
and the hash the Phase 01 gate holds, and that is not a thing to do unreviewed at the end of a run.

The interim mitigation is implemented one layer out. `target-chain.mjs` now scans the destination
account for a validated payment carrying the obligation's reference and refuses to sign if it finds
one. Replayed against this incident it finds the agent's payment at ledger 19825006 and refuses.

The script also now reads the FAssets status live at decision time rather than from the event that
created the obligation. Re-running it today correctly refuses with `S004_INACTIVE_REDEMPTION`,
because FAssets reports 44928272 as `SUCCESSFUL`.

## 7. Superseded: the completion gate moved

Flare declined to approve new FAssets agents on 2026-08-11 and directed Signet to test the execution
layer instead. The settlement step below is therefore not a gap awaiting access; it is out of scope
by organizer guidance, and the acceptance boundary is now the four steps in
[`organizer-accepted-proof-boundary.md`](organizer-accepted-proof-boundary.md).

What this phase established stands and is used: the live Coston2 obligation, the minting cycle, the
deployed contracts, and the on-chain FDC proof. What it found, the duplicate payment, is corrected in
schema V2 and preserved as the permanent regression.

## 8. Why the original completion gate was only partly met

The gate asks for a minimum complete live transaction that is independently inspectable.

A complete FAssets redemption lifecycle did occur on Coston2 and anyone can inspect it. Signet
performed every step of its own leg on the deployed chain and a third party can verify all of it.
But the settling payment came from the agent, not from Signet, so **Signet has still never settled a
FAssets obligation**.

That is the whitelist boundary, and it is not something a better test could get around. FAssets
completes a redemption only for a payment from the agent's own underlying address. Signet has to be
the agent's signer to make that payment, and becoming an agent is governance-gated.

## 8. Limitations

- Signet has never settled a FAssets redemption. The one in this phase was settled by the agent.
- Because the whitelist forced binding a third-party agent's vault to our own XRPL account, the test
  setup created a second payer for one obligation. That is an artefact of the workaround, and it is
  what surfaced the ADR 0003 gap.
- The extension ran as an ordinary process. No TEE, no attestation.
- `confirmRedemptionPayment` has never been called by us and cannot be until the whitelist clears.

## Addendum, 2026-08-11: this run log no longer reproduces

The verifier output recorded in section 5 was true when it ran. Re-running the same command today
gives `UNVERIFIABLE`, for two independent reasons, and a reader following the handoff's invitation to
check a claim themselves should know before they try:

- The receipt predates schema V2. It binds no underlying observation, so its V1-encoded commitment
  cannot be recomputed by a verifier that only implements V2.
- The XRPL transaction has aged out of the retained history of both locked testnet endpoints.

Neither is a retraction of what was observed. Both are what an evidence audit means by a
reproducibility gap, and recording it is cheaper than letting a reader discover it and wonder which
other numbers moved.

The duplicate payment this phase found is corrected in schema V2. See
[ADR 0003](../adr/0003-underlying-payment-precheck.md) and [`docs/guarantee.md`](../guarantee.md).

## 9. Addendum: the FCC gap this phase did not notice

This phase reported that Signet's leg ran on the deployed chain, and it did. What it did not say,
because nobody asked until an organizer did, is that the decision ran as a CLI reading stdin. That is
not FCC in the sense the protocol means.

`extension/cmd/signet-fcc-extension` now implements the FCC extension contract, extension id `66164`
is registered on the live Coston2 `FlareTeeManager`, and the composed lifecycle takes the payment it
signs from the FCC ActionResult. No TEE machine is registered: FTDC rejects simulated attestation and
`getActiveTeeMachines(66164)` returns empty.

> **Superseded 2026-08-14.** Extension `66164` was retired by gate B and replaced by `66244`, sender
> `0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0`. The paragraph above is left as written because it was
> true when this phase ran. See [`gate-b.md`](gate-b.md). No TEE machine is registered for `66244`
> either, and the attestation position is unchanged.

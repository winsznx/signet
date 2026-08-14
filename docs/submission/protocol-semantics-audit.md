# Protocol semantics audit: FAssets lots and FDC proof type

Date: 2026-08-14
Method: live reads against deployed Coston2 state, plus a full-repository classification sweep.
Prompted by two claims from the builder group. Neither is treated as authority; both are reconciled
against deployed state and pinned first-party source.

---

## 1. FAssets lot semantics

**The claim.** Minting and redemption behaviour has changed around lots.

**What the live chain says.** `AssetManagerFXRP` at `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`:

| read | value |
|---|---|
| `lotSize()` | `10000000` AMG |
| `assetMintingDecimals()` | `6` |
| `redeemWithTagSupported()` | `true` |

All three redemption entry points resolve on the live diamond:

| method | selector |
|---|---|
| `redeem(uint256,string,address)` | `0x99646d1c` |
| `redeemAmount(uint256,string,address)` | `0x01e261f6` |
| `redeemWithTag(uint256,string,address,uint32)` | `0x9a611c20` |

Lot-based `redeem` has not been removed and `lotSize` is unchanged from what Phase 00 recorded. The
group's statement, whatever it refers to, is not "lot-based redemption is gone".

**Which method produced our request.** `scripts/fassets/mint-and-redeem.mjs` and
`scripts/lifecycle/chain.mjs` both call `redeem(lots, underlyingAddress, executor)` with
`SIGNET_LOTS` defaulting to 1. So request 44928272 and the lifecycle's fork request are
**lot-based redemptions**.

**Does Signet rely on lot semantics anywhere in executable policy? No.**

```bash
grep -rniE "\blot\b|\blots\b|lotSize|lotSizeAMG|dust|fractional|minimumRedeemAmount" \
  contracts/src/ extension/internal/ extension/cmd/ reference/src/ verifier/src/ coordinator/src/
# no matches
```

This is the finding that matters, and it is structural rather than lucky. Signet's decision consumes
the obligation FAssets *emits* — `paymentAddress`, `valueUBA`, `feeUBA`, `paymentReference`,
`firstUnderlyingBlock`, `lastUnderlyingBlock`, `lastUnderlyingTimestamp`, the tag flag and the tag,
all read through `redemptionRequestInfoExt`. It never reasons about how that obligation came to
exist. A redemption created by `redeem`, `redeemAmount` or `redeemWithTag` produces the same
canonical instruction shape, because the adapter reads the *result*, not the *call*.

### Classification of every occurrence

| location | class | note |
|---|---|---|
| `scripts/fassets/mint-and-redeem.mjs`, `scripts/lifecycle/chain.mjs`, `scripts/lifecycle/run.mjs` | **METHOD-SPECIFIC** | these *create* a redemption to test against; `redeem(lots, …)` is one valid way to do it |
| `scripts/probe-fassets-access.mjs`, `docs/protocol-seams/fassets-access-probe.json` | **CURRENT** | records live settings, including `lotSizeAMG` and free collateral lots, as observed |
| `docs/source-lock.json` (`lotSize()` selector) | **CURRENT** | a proven selector on the live diamond |
| `docs/evidence/phase-00.md`, `phase-09.md`, `phase-10.md`, `docs/run/ACCESS_STATUS.md` | **HISTORICAL** | describe what those phases did and observed; accurate as written |
| executable policy (`contracts/src`, `extension/`, `reference/src`, `verifier/`, `coordinator/`) | **absent** | nothing to classify |

**STALE: none.** No lot or dust assumption was inherited into executable policy from a superseded
FAssets version, because none was ever encoded there. Nothing was removed as a result of this audit,
and nothing should be: changing behaviour on the strength of a chat message, against deployed state
that contradicts it, would be the error.

**Dust.** The word appears nowhere in this repository outside this document. Signet has no dust
handling because it never computes an amount: it pays `valueUBA - feeUBA` as FAssets reports them.

---

## 2. FDC proof semantics

**The concern.** FAssets XRP flows require XRPL-specific proof semantics, and proof ownership can
invalidate otherwise valid-looking evidence.

**Signet's redemption-payment proof is `XRPPayment`, not the generic `Payment`.** From
`evidence/receipts/fdc-proof-28B48DC3….json`, decoded:

| field | value |
|---|---|
| `attestationType` | `0x5852505061796d656e74…` = **`XRPPayment`** |
| `sourceId` | `0x74657374585250…` = **`testXRP`** |
| `proofOwner` | `0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d` |
| `requestBody.transactionId` | `0x28b48dc3…feff4` |
| `responseBody.sourceAddress` | `rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta` |
| `responseBody.receivingAddressHash` | `0x02eca6de…3c44` |
| `responseBody.intendedReceivingAddressHash` | `0x02eca6de…3c44`, **identical** |
| `responseBody.spentAmount` / `intendedSpentAmount` | `9950010` / `9950010`, identical |
| `responseBody.receivedAmount` / `intendedReceivedAmount` | `9950000` / `9950000`, identical |
| `responseBody.firstMemoData` | `0x4642505266410002…02ad0328` — prefix `FBPRfA`, trailing id `44892968` |
| `responseBody.hasDestinationTag` / `destinationTag` | `false` / `0` |
| `responseBody.blockNumber` / `blockTimestamp` | `19823767` / `1786464011` |
| `lowestUsedTimestamp` | `1786464011` |
| `votingRound` | `1422636`, protocol id `200` |
| Merkle proof | 3 nodes |
| on-chain call | `FdcVerification` `0x906507E0…B933`, `verifyXRPPayment` returned **true** |
| request | `FdcHub` `0x48aC463d…5f1D`, tx `0xa86d5208…288c`, fee 1000 wei, block 33930414 |

`intended*` matching actual is the field pair that catches a partial payment, and the generic
`Payment` type does not carry the memo and destination-tag fields Signet's policy depends on. That is
recorded at `scripts/fdc/prove.mjs:6` and enforced by `verifierPath = "verifier/xrp/XRPPayment"`.

**`proofOwner`.** The attestation request binds an owner address, and the response carries it back in
`requestBody.proofOwner`. A proof requested by one party is not silently usable as evidence attributed
to another, so the verifier must check it rather than treating a valid Merkle proof as sufficient.

### The one place `Payment` appears, and why it is correct

Two documents say FDC `Payment` attestation. Both describe the **minting** leg, not Signet's
redemption proof, and `Payment` is the right type there:

```js
// scripts/fassets/mint-and-redeem.mjs:208
// `Payment`, not `XRPPayment`: executeMinting takes IPayment.Proof, and handing it the XRP-specific
```

`executeMinting` consumes `IPayment.Proof`. So:

| leg | type | consumer |
|---|---|---|
| minter pays the agent, to mint FXRP | `Payment` | `AssetManagerFXRP.executeMinting` |
| Signet pays the redemption obligation | `XRPPayment` | `FdcVerification.verifyXRPPayment` |

**No security-relevant conflation exists.** The distinction was already deliberate and already
commented in the code. `docs/requests/fassets-agent-whitelist.md:79` and
`docs/evidence/organizer-accepted-proof-boundary.md:60` are both describing the minting leg and are
accurate as written; neither is changed by this audit.

---

## What this audit changed

Nothing in executable behaviour. Both claims were checked against deployed state and pinned source,
and both turned out to be either inapplicable to Signet's path (lots) or already handled correctly
(proof type). That is the outcome recorded, rather than a change made to look responsive.

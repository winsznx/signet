# FAssets protocol seam

Verified: 2026-08-11 against live Coston2.
Pinned source: `flare-foundation/fassets` @ `6d5c103e4342f0fc7d3683a433a90349d544f774`,
`flare-foundation/flare-foundry-periphery-package` @ `ca264d6a31ddfb53d1bef7cb7bd1942aa89d323a`.

This is the seam that turns a public FAssets obligation into the canonical input Signet signs
against. Everything here is read from the AssetManager. Nothing is supplied by a caller.

## Resolution

| What | Value | How |
|---|---|---|
| AssetManager (FXRP) | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` | `FlareContractRegistry.getContractAddressByName("AssetManagerFXRP")` |
| Deployment shape | diamond | selectors resolve through `DiamondLoupe.facetAddress` |
| `assetMintingDecimals` | 6 | live read |
| `redeemWithTagSupported` | true | live read |

Because minting decimals are 6 and an XRP drop is 1e-6 XRP, one UBA is exactly one drop **on this
deployment**. Signet does not hard-code that: the decimals are an input and a scale that cannot
convert exactly is a refusal rather than a rounding. `test_mintingDecimalsMakeUbaAndDropsOneToOne`
fails if Flare changes it.

## The obligation

`redemptionRequestInfoExt(requestId)` is the only view Signet reads. It is a superset of
`redemptionRequestInfo` and is the sole source of `requiresDestinationTag`. Reading the base view
instead would silently treat a tagged obligation as untagged, which is the most dangerous mode
confusion available at this seam: the payment would omit the tag, FAssets would reject it as
invalid, and the agent would have spent real XRP for nothing.

| Field | Meaning for Signet |
|---|---|
| `status` | Only `ACTIVE` is payable |
| `agentVault` | Must equal the agent Signet is bound to |
| `paymentAddress` | The XRPL destination, used exactly as recorded and never normalised |
| `paymentReference` | Must equal `PaymentReference.redemption(requestId)` |
| `valueUBA`, `feeUBA` | The agent owes `valueUBA - feeUBA` |
| `firstUnderlyingBlock` | A payment before this block is rejected by FAssets |
| `lastUnderlyingBlock`, `lastUnderlyingTimestamp` | Late only when **both** have passed |
| `requiresDestinationTag`, `destinationTag` | Selects the mode and the exact tag |
| `executor` | Recorded, not used by the signing decision |

## Payment reference

From the pinned implementation:

```text
redemption(id) = bytes32(id | (0x4642505266410002 << 192))
```

`0x464250526641` is ASCII `FBPRfA`; `0x0002` is the redemption type. FAssets requires
`paymentReference == PaymentReference.redemption(requestId)` before it will confirm, so a payment
carrying anything else can never close the obligation.

Verified against a live request rather than against a reimplementation:

```text
requestId          44851498  (0x02ac612a)
derived reference  0x4642505266410002000000000000000000000000000000000000000002ac612a
on-chain reference 0x4642505266410002000000000000000000000000000000000000000002ac612a
```

The reference model in `reference/src/payment-reference.ts` and the Solidity in
`FAssetsAdapter.expectedPaymentReference` both reproduce this independently.

## Live evidence

### Standard memo mode

Transaction `0xd4f2f628f1ad1f4fc11d12e1093b1d4be1f83b2241cef1081fb15dd187319b70`, block 33,921,675.

```text
agentVault              0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC
requestId               44851498
paymentAddress          r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72
valueUBA                3060000000
feeUBA                  15300000
payable                 3044700000 drops = 3044.7 XRP
firstUnderlyingBlock    19820484
lastUnderlyingBlock     19821048
lastUnderlyingTimestamp 1786454583
requiresDestinationTag  false
```

### Destination-tag mode

Transaction `0xcb49c8d8332759516b24f3bcb5934a436db114683cccdc023cdcb3efbc918f6f`, block 33,913,301.

```text
agentVault              0x5b89514d1F060AdbEA8B7294AFf81ed8dbAa7fC5
requestId               44745040
paymentAddress          rLoaiwEpbBAQKZcgdEG5kbNTM98VuzECy2
destinationTag          412913618
requiresDestinationTag  true
executor                0x103b384064ae85577127097A7cCadfd6fb13f437
```

Both modes are live on Coston2. Across blocks 32,000,000 to 33,922,434 the explorer returns 248
`RedemptionRequested` and 175 `RedemptionWithTagRequested` events, the latter split 148 in the
recent range and 27 in the earlier one.

## Findings that change how Signet must be built

### 1. One transaction can create several obligations

The three most recent `RedemptionRequested` events all came from the same transaction, each for a
different agent. FAssets fills a redemption from the front of the FIFO queue and emits one event per
participating agent. The coordinator must therefore treat `(requestId)` as the unit of work, not
`(transactionHash)`, and must not assume one event per transaction.

### 2. A confirmed request reports SUCCESSFUL rather than reverting

The pinned interface comment says "once the redemption is confirmed, the request is deleted and this
method fails". The live deployment does not behave that way: `redemptionRequestInfoExt` returns
normally with `status = SUCCESSFUL` for a confirmed request. All 40 sampled recent requests returned
status 2.

Signet codes against the deployment, not the comment. `test_confirmedRedemptionReturnsSuccessfulRatherThanReverting`
records the real behaviour and fails loudly if the deployment ever starts matching the comment, which
would turn a clean refusal into an unhandled revert.

### 3. The payment window is not simply `underlyingBlocksForPayment`

Settings report `underlyingBlocksForPayment = 500`, but the observed window was
`19821048 - 19820484 = 564` blocks. The difference is the redemption time extension. Signet must
read the window from the obligation, never compute it from settings.

### 4. An unknown request id reverts

`redemptionRequestInfoExt(999999999999)` reverts rather than returning a zeroed struct, so the
coordinator must treat a revert as "no such obligation" rather than as an infrastructure failure.

## Adapter behaviour

`contracts/src/adapters/FAssetsAdapter.sol` returns a typed failure rather than reverting, so the
caller can record a stable reason. On any failure it returns a zeroed obligation: a refused read
leaks no destination, which matters because a caller may be asking about an obligation that is not
theirs.

| Failure | Cause |
|---|---|
| `NOT_ACTIVE` | status is not ACTIVE |
| `WRONG_AGENT` | the obligation belongs to another agent |
| `REFERENCE_MISMATCH` | reference is not `redemption(requestId)`, or not a valid redemption reference |
| `DESTINATION_EMPTY` | no payment address recorded |
| `AMOUNT_INVALID` | the fee consumes the whole value |
| `TAG_OUT_OF_RANGE` | tag exceeds uint32, or a tag is present on an untagged obligation |
| `MODE_UNSUPPORTED` | the obligation requires a tag but the deployment cannot confirm tagged payments |

## Mode support is checked, not assumed

`redeemWithTagSupported()` is read before a `DESTINATION_TAG` obligation is accepted. The flag is
set by a single-shot diamond initializer, so it cannot flip on the current instance through that
path, but a later facet cut could change it while tagged obligations already exist in storage. A
tagged obligation on a deployment that cannot confirm tagged payments has no lawful completion path,
so Signet refuses it rather than paying without the tag (FR-014).

## Open items

- `firstUnderlyingBlock <= lastUnderlyingBlock` is not asserted by the adapter. Both are constructed
  by FAssets, so an inversion would be a protocol fault rather than an attack, but the check is
  cheap and belongs in Phase 06's contract work.
- No obligation assigned to a Signet-controlled agent exists yet, because agent registration is
  governance-gated. Every case here reads obligations belonging to other agents, which is exactly
  why the `WRONG_AGENT` path is tested against a real one.
- The completion entry points (`confirmRedemptionPayment`, `confirmXRPRedemptionPayment`) are
  selector-verified but not yet exercised. Phase 05 owns the proof they consume.

## Reproduce

```bash
export COSTON2_RPC_URL=https://coston2-api.flare.network/ext/C/rpc
make test-fork
```

Twelve fork tests at pinned blocks, plus `forge test --match-path "contracts/test/unit/*.t.sol"`
for the seventeen unit tests that cover the malformed-obligation branches live Coston2 cannot
produce. In a sandbox whose egress proxy terminates TLS,
`forge` may fail to fork because its TLS stack does not read the proxy CA from the environment; that
is an environment artifact, not a protocol result, and does not apply to a normal clone.

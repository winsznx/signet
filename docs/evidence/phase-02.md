# Phase 02 — FAssets protocol seam

Result: **PASS** (after closing four security-review findings)
Date: 2026-08-11
Branch: `build/signet-autonomous`
Networks touched: Flare Coston2, read-only

## 1. Objective

Read the current Coston2 AssetManager, decode a real redemption event, call the current
request-info view, identify the exact completion and default selectors, and prove the behaviour on
the current deployment. The stop boundary is explicit: no payment builder if memo, tag or amount
semantics remain ambiguous.

## 2. What was proven

The seam is documented in `docs/protocol-seams/fassets.md` with machine-readable evidence in
`docs/protocol-seams/fassets-seam-evidence.json`. The short version:

- `AssetManagerFXRP` resolves from the live registry to
  `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`, reports `assetMintingDecimals = 6` and
  `redeemWithTagSupported = true`.
- A real memo-mode redemption and a real destination-tag redemption were decoded end to end from
  their on-chain event logs, and every field was cross-checked against
  `redemptionRequestInfoExt`.
- Both redemption modes are in active use on Coston2: 248 `RedemptionRequested` and 175
  `RedemptionWithTagRequested` events in the sampled range.

## 3. Cross-language agreement on the payment reference

The payment reference is the field that decides whether a payment can ever close its obligation, so
it is derived independently in three places and compared against what the chain recorded:

```text
requestId            44851498
TypeScript reference 0x4642505266410002000000000000000000000000000000000000000002ac612a
Solidity adapter     0x4642505266410002000000000000000000000000000000000000000002ac612a
on-chain value       0x4642505266410002000000000000000000000000000000000000000002ac612a
```

Neither implementation reads the stored value back to produce its answer, so a mistake in the
derivation cannot hide.

## 4. Findings that change how Signet must be built

### One transaction can create several obligations

The three most recent `RedemptionRequested` events came from a single transaction, each for a
different agent. FAssets fills a redemption from the front of the FIFO queue and emits one event per
participating agent. The unit of work is therefore the `requestId`, never the transaction hash. A
coordinator written on the opposite assumption would silently drop obligations.

### A confirmed request reports SUCCESSFUL rather than reverting

The pinned interface comment states that a confirmed request is deleted and the view fails. The live
deployment returns normally with `status = SUCCESSFUL`; all 40 sampled recent requests did so. Signet
codes against the deployment. `test_confirmedRedemptionReturnsSuccessfulRatherThanReverting` records
the real behaviour and fails loudly if the deployment ever starts matching the comment, which would
convert a clean refusal into an unhandled revert.

### The payment window is not `underlyingBlocksForPayment`

Settings report 500 blocks; the observed window was 564. The difference is the redemption time
extension. The window must be read from the obligation and never computed from settings, or Signet
would set `LastLedgerSequence` against a deadline the protocol does not actually enforce.

### An unknown request id reverts

It does not return a zeroed struct, so the coordinator must treat a revert as "no such obligation"
rather than as an infrastructure failure.

## 5. The adapter

`contracts/src/adapters/FAssetsAdapter.sol` takes a `requestId` and the bound agent, and returns
either a canonical obligation or a typed failure. It reads `redemptionRequestInfoExt` rather than
`redemptionRequestInfo` because the extended view is the only source of `requiresDestinationTag`;
reading the base view would silently treat a tagged obligation as untagged, which is the most
dangerous mode confusion at this seam.

On every failure path it returns a zeroed obligation, so a refused read leaks no destination. That
matters because a caller may be asking about an obligation that is not theirs.

## 6. Tests

Twelve fork tests in `contracts/test/fork/FAssetsSeam.t.sol`, each forking Coston2 at a block chosen
so a specific real redemption is in a specific real state. Expected values come from event logs
decoded independently of the adapter, so the tests compare the adapter against the protocol rather
than against itself.

```text
$ COSTON2_RPC_URL=https://coston2-api.flare.network/ext/C/rpc forge test --match-path contracts/test/fork/FAssetsSeam.t.sol
[PASS] test_confirmedRedemptionIsNoLongerActive()
[PASS] test_confirmedRedemptionReturnsSuccessfulRatherThanReverting()
[PASS] test_deploymentSupportsDestinationTagMode()
[PASS] test_mintingDecimalsMakeUbaAndDropsOneToOne()
[PASS] test_paymentReferenceMatchesTheProtocolDerivation()
[PASS] test_readsRealMemoModeRedemptionIntoCanonicalForm()
[PASS] test_readsRealTaggedRedemptionWithTheExactTag()
[PASS] test_referenceDerivationRejectsOutOfRangeIds()
[PASS] test_registryResolvesAssetManagerAtPinnedBlock()
[PASS] test_taggedAndUntaggedProduceDifferentModes()
[PASS] test_unknownRequestIdReverts()
[PASS] test_wrongAgentIsRefusedNotServed()
Suite result: ok. 12 passed; 0 failed
```

Adversarial cases covered: wrong agent, confirmed (inactive) request, unknown request id, malformed
and mistyped payment references, and both redemption modes proven distinct.

## 7. Source-lock changes

`forge-std` added at `8e40513d678f392f398620b3ef2b418648b33e89` (tag v1.11.0, Apache-2.0), pinned
and content-hashed like every other upstream. It is a test-only dependency and must never be
imported by anything under `contracts/src`.

Vendoring it into `contracts/lib` was rejected: every other upstream is reproduced from the source
lock and verified by content hash, and a second mechanism for one dependency is a second thing to
audit.

## 8. Environment note

`forge` cannot fork through an egress proxy that terminates TLS, because its TLS stack does not read
the proxy CA from the environment. That is an environment artifact, not a protocol result, and does
not apply to a normal clone. The fork tests were run with direct network access.

## 9. Limitations

- Read-only. Nothing deployed, no transaction sent.
- No obligation assigned to a Signet-controlled agent exists, because agent registration is
  governance-gated. Every case reads obligations belonging to other agents, which is precisely why
  the `WRONG_AGENT` path is proven against a real one.
- The completion entry points are selector-verified but not exercised; Phase 05 owns the proof they
  consume.
- `firstUnderlyingBlock <= lastUnderlyingBlock` is not asserted by the adapter. Recorded as an open
  item for Phase 06.

## 10. Bootstrap reproducibility, proven while this phase was in review

`upstream/` was deleted entirely and `make bootstrap` re-run. All eleven pinned sources were
re-fetched and every content hash matched, in 40 seconds:

```text
verify fce-extension-scaffold          contentSha256=47f0b162... files=208 OK
verify flare-foundry-periphery-package contentSha256=62ec4c74... files=747 OK
verify flare-npm-periphery-package     contentSha256=be46fe59... files=753 OK
verify fassets                         contentSha256=69bd367e... files=670 OK
verify fdc-client                      contentSha256=76b96884... files=105 OK
verify tee-proxy                       contentSha256=822dfd95... files=132 OK
verify fce-sign                        contentSha256=9c60cc78... files=135 OK
verify developer-hub                   contentSha256=a1a183a5... files=901 OK
verify openzeppelin-contracts          contentSha256=948748cd... files=693 OK
verify forge-std                       contentSha256=9d2c91c9... files=68  OK
verify flare-system-c-chain-indexer    contentSha256=d9f9e684... files=80  OK
```

This is the first real test of the Phase 00 decision to hash extracted content rather than the
archive: a tar or gzip framing change would have broken an archive digest, and did not break this
one. The Phase 13 fresh-clone requirement is partly discharged early.

The fork tests were re-run afterwards against the freshly fetched sources and still pass 12/12.

## 11. Adversarial review results

### Security review, verdict CONDITIONAL PASS

Four findings, all closed in this phase.

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | `MODE_UNSUPPORTED` was declared but never returned, and `readCanonicalRedemption` never called `supportsDestinationTag`. The adapter's own NatSpec claimed the FR-014 protection that no code path performed. The reviewer traced the flag to a single-shot diamond initializer, so it cannot flip today, but a later facet cut could change it while tagged obligations already exist in storage | The check is now made and `MODE_UNSUPPORTED` returned. A tagged obligation on a deployment that cannot confirm tagged payments has no lawful completion path, so signing one would spend the agent's XRP against an obligation that can never close |
| MEDIUM | The adapter checked `NOT_ACTIVE` before `WRONG_AGENT`, contradicting ADR 0002's fixed "identity before content" order. Low impact today because the underlying view is public and unrestricted, but the adapter and the reference model disagreed about the reason code for a doubly-bad input, with no test catching it | Reordered to match ADR 0002. `test_wrongAgentIsReportedBeforeInactiveStatus` sets both conditions at once and pins the answer |
| MEDIUM | `ISignetTypes.CanonicalRedemption` carried a doc comment claiming it mirrors the reference model's `RedemptionSnapshot`. It does not: four fields are Solidity-only and four are reference-model-only | The claim was false, so it was replaced rather than softened. The comment now enumerates exactly which ten fields must agree, which are Solidity-only and why, which are reference-model-only and why, and names the phase that owns reconciling them |
| LOW/MEDIUM | Four of seven `AdapterFailure` branches had no test anywhere, because live Coston2 cannot produce a malformed obligation. The arithmetic and range guards were untested code claiming to be a defence | `contracts/test/unit/FAssetsAdapter.t.sol` adds 17 tests against a configurable mock, covering every branch and its boundaries: fee equal to value, fee one below value, tag at `2^32-1`, tag at `2^32`, a tag on an untagged obligation, a required tag of zero, a minting-type reference, a zero reference, and every non-ACTIVE status |
| LOW | The "typed failure, never a revert" guarantee does not hold for `requestId == 0`, which reverts inside the AssetManager before the adapter's own bound check | Documented on `expectedPaymentReference`. It is the same behaviour as any other unknown id, and fails closed |

The reviewer separately confirmed: no caller-controlled payment fields; the payment-reference
derivation matches `PaymentReference.sol` bit for bit; the `uint32` and `uint8` narrowings are
bound-checked before the cast and the protocol itself enforces the tag range at request creation;
`paymentValueUBA` cannot underflow; failure paths return a genuinely zeroed struct; none of the 12
fork tests pass vacuously; and nothing under `contracts/src` imports `forge-std`.

It also confirmed the sandbox TLS failure is an environment artifact, reproducing both the failure
inside the sandbox and the 12 passes with direct network access.

### Test totals after the fixes

```text
contracts/test/unit/FAssetsAdapter.t.sol   17 passed
contracts/test/fork/FAssetsSeam.t.sol      12 passed
                                           29 passed, 0 failed
```

## 12. Completion gate

| Requirement | Met |
|---|---|
| Current Coston2 AssetManager read | Yes, resolved from the live registry |
| Real redemption event decoded | Yes, both modes, cross-checked against the request-info views |
| Current request-info view called | Yes, `redemptionRequestInfoExt` |
| Completion and default selectors identified | Yes, proven reachable in Phase 00 and traced to their facets |
| Behaviour proven on the current deployment | Yes, 12 fork tests at pinned blocks plus 17 unit tests for the branches the live chain cannot produce |
| Canonical fields match official event and interface behaviour | Yes |

Stop boundary check: the boundary is "no payment builder if memo, tag or amount semantics remain
ambiguous". None remain ambiguous. The memo carries the payment reference, derived identically in
three places and matching the chain. The tag is read from the extended view, range-checked, and its
mode is resolved explicitly rather than inferred. The amount is `valueUBA - feeUBA`, with the
protocol's floor semantics understood and Signet's exact-payment choice recorded. Phase 03 proceeds.

## 12. Completion gate

PENDING REVIEW.

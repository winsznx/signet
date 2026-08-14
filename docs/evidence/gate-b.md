# Gate B — canonical requestId-only derivation

Result: **PASS**, deployed and verified on live Coston2.
Date: 2026-08-12, deployed 2026-08-14
Commits: `95866e0`, `1428329`
Supersedes: the open high-severity gap recorded in [`phase-13.md`](phase-13.md) section 3

## 1. What was wrong

The organizer's proof requires the payment to be derived from the obligation. It was not.

The FCC instruction carried a caller-authored snapshot. Whoever sent it chose the destination, the
amount, the reference, the tag and the window, and `decide()` checked those fields for internal
consistency rather than truth. A coordinator reporting a genuine, active obligation while naming a
destination of its own choosing received a real signature over a real transaction paying that
destination.

What existed was attributability, and it worked: the authorization commitment covers every payment
field, phase 11's verifier recomputes it from public data, and the corruption tests prove a moved
destination is caught. That is detection after a signature exists, not prevention.

## 2. What changed

Every field the decision needs turns out to be resolvable on chain. `redemptionRequestInfoExt`
returns status, agent, destination, reference, value, fee, both window bounds, the tag flag and the
tag. `assetMintingDecimals` comes from the asset manager. So the preferred architecture was
available, and is now built.

```solidity
function authorizeRedemption(uint256 _requestId, uint32 _generation) external payable returns (bytes32)
```

The contract resolves the obligation through `FAssetsAdapter.readCanonicalRedemptionById`, which:

- reads the agent from the request rather than accepting one;
- refuses anything FAssets does not report `ACTIVE`;
- checks the binding is `ACTIVE` in `SignetRegistry`;
- checks the registry action exists for `(binding, requestId, generation)`;
- ABI-encodes the canonical instruction itself.

**There is no parameter through which a caller could express a payment field.** That is the
invariant's strongest form: structural rather than statistical.

The extension decodes that payload and reads the obligation from it alone. A caller-authored
obligation now fails to decode **on the FCC path**, and the FCC test asserts it fails as a *decode*
error rather than a policy refusal, because a policy refusal would mean the path still existed. The
standalone `cmd/signet-extension` CLI still accepts one from stdin and reaches no key; see open
finding 3.

### Two inputs the extension supplies for itself

A caller must not control these and the chain cannot know them.

| input | why, and what bounds it |
|---|---|
| XRPL allocation | bounded downstream by the fee cap and the safety margin |
| underlying observation | taken by `extension/internal/xrplobserve` across independently hosted endpoints that must agree. This is a second implementation of the coordinator's observer, and the duplication is the point: an observation supplied by the party that wants the signature is worth nothing |

## 3. Proof

### Tests

| suite | count | what they assert |
|---|---|---|
| Solidity | 5 | a 256-run fuzz over caller addresses asserting one request id yields one payload for every caller, and a selector assertion that `authorizeRedemption(uint256,uint32)` carries no payment field. All five exercise the read-only `canonicalInstructionFor` preview and the selector; **none calls the state-changing `authorizeRedemption`**, which is how open finding 1 survived |
| Go | 16 | schema refusal, truncation, and an override attempt on each of destination, amount, fee, reference, tag mode, tag value, both deadlines and agent. The trailing-byte case is **not** an assertion: it was written to accept either outcome, and the decoder does not in fact reject trailing bytes. See open finding 4 |

### Deployed, and verified by RPC rather than by reading the deploy script's output

| | |
|---|---|
| instruction sender | [`0x7e2dd9078c7d741e0cF81904264A79e70212963a`](https://coston2.testnet.flarescan.com/address/0x7e2dd9078c7d741e0cF81904264A79e70212963a) |
| extension id | `66248` |
| `FlareTeeManager` | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| deploy tx | `0x60ba84a3899f5d3e040acc8798ddfe05fb4738b7eed25e562fd57a675809ee72` |
| register tx | `0x8bd0c42111d1d117a52e5c56a27a7708aed095eea6877e2f9125df767ce230a5` |
| setExtensionId tx | `0x430e1bace9371c68afce868e22b1e91ba57c6f99556d17ba04e22b74bd2f1f14` |
| runtime size | 9088 bytes |

Reproduce the binding:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeExtensionInstructionsSender(uint256)(address)" 66248 \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc
# 0x7e2dd9078c7d741e0cF81904264A79e70212963a
```

The deployed runtime contains the selectors `authorizeRedemption(uint256,uint32)` (`0x064267dd`),
`canonicalInstructionFor(uint256,uint32)` (`0x011adba4`) and `SCHEMA_VERSION()` (`0x6233b32a`).

### Fails closed on a settled obligation, identically for every caller

Request 44928272 is settled, so FAssets no longer reports it `ACTIVE`:

```bash
cast call 0x7e2dd9078c7d741e0cF81904264A79e70212963a \
  "canonicalInstructionFor(uint256,uint32)" 44928272 1 \
  --from <any address> --rpc-url https://coston2-api.flare.network/ext/C/rpc
# reverts AdapterRefused(1) == NOT_ACTIVE
```

Two unrelated callers receive byte-identical revert data. That is consistent with the caller having
no influence over the result, and it is the live half of what the 256-run caller fuzz asserts
locally.

### Composed lifecycle through the gate B path

`node scripts/lifecycle/run.mjs`, run 2026-08-14 after the change:

```text
76/76 lifecycle checks pass
```

Receipt: `evidence/receipts/lifecycle-A10C7C3C6C644FB97B97F796C356F8CBFC8F58B19931859E470B3050AFF8399D.json`

| field | value |
|---|---|
| `derivedInsideFccExtension` | `true` |
| `registeredExtensionId` | `66248` |
| `registeredInstructionSender` | `0x7e2dd9078c7d741e0cF81904264A79e70212963a` |
| `obligationHash` / `obligationHashOnChain` | identical, `0xcfa36a2d…f8db` |
| XRPL tx | `A10C7C3C…399D`, validated ledger 19895487, `tesSUCCESS` |
| replay of the identical blob | `tefPAST_SEQ` |
| FDC | `VALID` |
| `teeMachineRegistered` | `false` |
| `attestation` | `"none: the extension ran as a local process, not in a Confidential Space VM"` |

The FAssets obligation in this run is a Coston2 **fork** at block 34039607, because Flare declined to
approve new FAssets agents. The XRPL payment and the FDC verification in the same run are on live
testnet and live Coston2 respectively. The separately executed live redemption is request 44928272.

## 4. Superseded extensions

Both are recorded with reasons in `deployments/coston2.json`. Neither ever carried a live TEE
machine, so no instruction was ever executed through either.

| extension | sender | why retired |
|---|---|---|
| `66163` | `0x6D49c54D2F75214616a0964Bd52c695384f1b6E2` | its `authorizeRedemption` relayed the decision input unmodified, so any caller could name an obligation that did not exist |
| `66164` | `0xDd8aA7A4f43f01258A426a30d02032821De9bc6e` | it checked the obligation against `SignetRegistry`, which is why it superseded 66163, but still accepted a caller-authored message |
| `66244` | `0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0` | the first gate B sender. It closed the caller-authored-payload gap, but gated on `state != NONE` and kept no record of having dispatched. See section 5 |

A registration script defect was found while doing this: it hardcoded 66163's retirement reason and
wrote it verbatim over 66164's, putting a false statement into the deployment record. The record is
corrected and the script now refuses to invent a reason, emitting an obvious `UNRECORDED:` placeholder
and a warning instead of a plausible lie.

## 5. What an adversarial review found afterwards

A security review of this boundary on 2026-08-14 found five defects and confirmed the central claim.
The full write-up, with severities, reachability and the live checks, is in
[`../threat-model.md`](../threat-model.md) under "Open after gate B". In short:

| # | defect | reachable today |
|---|---|---|
| 1 | `authorizeRedemption` gates on `state != NONE` instead of `== REQUESTED`, so an already-authorized action can be instructed again | **no.** No TEE machine exists, so `getRandomTeeIds(66248, 1)` reverts `0xd65ac61e` first. **It arms the moment gate A lands, and is a blocker there** |
| 2 | the extension sets `Prior: nil`, so `generation > 0` is always refused `S018` and the replacement flow is dead code | yes, fail-closed |
| 3 | `internal/wire` still decodes a fully caller-authored obligation for `cmd/signet-extension` | yes, reaches no key |
| 4 | `fccinput.Decode` does not reject trailing bytes although its doc comment says it does | no |
| 5 | `xrplobserve` matches only `Memos[0]` | yes, narrows an accepted residual |

None is fixed here. Phase 14's completion gate forbids feature work, and the contract half is already
deployed: changing the source without redeploying would put this repository and the chain out of
agreement, which is worse than a stated defect.

The review's attempts to influence destination, amount, fee, reference, tag mode, tag value, either
window bound or the agent vault through the FCC path all failed. That is the claim this gate exists
to make, and it survived.

## 6. What gate B does not buy

The extension still runs as a local process with no attestation. An operator with host access can
bypass the contract path entirely by running its own binary against its own key.

Gate B removes the **protocol-level** path to an arbitrary signature. It does not create isolation
between the decider and the host. That is what a real TEE would buy, and this deliverable does not
have one. The residual is rated medium, accepted for this build, blocking for production, and the
checklist for closing it is [`../run/GATE_A_STRETCH.md`](../run/GATE_A_STRETCH.md).

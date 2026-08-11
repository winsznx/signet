# Phase 06 — Minimum Signet contracts

Result: **PASS**
Date: 2026-08-11
Branch: `build/signet-autonomous`
Networks touched: none. Local only, as the phase requires.

## 1. Objective

Agent binding, canonical request, action lifecycle, result verification and pause. The completion
gate is that the contracts cannot authorize arbitrary fields.

## 2. What the completion gate means here

The gate is a negative, so most of the evidence is about what these contracts refuse.

`SignetInstructionSender` has exactly one entry point that can start an action:

```solidity
function requestRedemptionSignature(uint256 _requestId, address _agentVault, uint32 _generation)
```

There is no overload taking a destination, an amount, a memo or a tag. Every payment field is read
through `FAssetsAdapter` from the AssetManager, so there is no calldata a compromised host can craft
that changes what gets paid. That is FR-010 enforced by the shape of the function rather than by a
check inside it.

The entry point is deliberately callable by anyone. A lawful obligation should be payable without
trusting a privileged operator to trigger it, and since every field comes from FAssets, an
unauthorized caller can at most cause Signet to pay an obligation the agent already owes.

`SignetRegistry` never learns a payment field at all. `recordActionRequested` takes a binding, a
request id, a generation and an obligation hash. Governance can bind, pause and retire; governance
cannot authorize a payment, and `test_governanceCannotAuthorizeAnything` proves it by having
governance attempt a decision and be rejected as an unapproved signer.

## 3. Cross-language parity

`contracts/test/unit/ObligationHashParity.t.sol` pins the Solidity obligation hash to values
produced by `reference/src/encoding.ts`, pasted as literals. Deriving them in Solidity would only
prove that two copies of one idea agree; a literal fails the moment either side's encoding moves.

```text
synthetic obligation        0x31e3d860072262eeb11afc5e250c3d7e4c884b9702fc4fbc24c0da966c0e9f75
real Coston2 obligation     0x77f552171323c53f688fb2a9edfdde983665c2a740cc50d94f1247cec5c7f957
same obligation, gen 3      0x1375aabe90d1342c258043f72dbf53c52d3a718f5d621949fd367ad1e2bc7a55
```

The second is the obligation decoded from live Coston2 in Phase 02, so the parity is proven against
a real request id rather than only a synthetic one. A further test asserts every field moves the
hash.

This is the seam where a cross-language encoding bug would otherwise hide until the extension's
signature failed to verify on chain, long after the payment had gone out.

## 4. Invariants covered

| Invariant | Test |
|---|---|
| I-009 one action per request generation | `test_oneActionPerRequestGeneration`, `test_aNewGenerationIsADistinctAction` |
| I-011 an action from another binding or chain is rejected | `test_actionIdBindsTheChainAndTheBinding`, binding pinned to the contract's own chain id |
| I-012 a paused agent cannot receive a new authorization | `test_pausePreventsNewInstructions`, `test_systemPausePreventsNewInstructions` |
| I-013 finalisation continues while signing is paused | `test_pauseDoesNotBlockFinalisingWorkAlreadyAuthorized` |
| I-015 history is derived only from finalized evidence | `test_historyEqualsFinalizedEvidenceAndNothingElse` |
| I-017 no completion without final evidence | `test_evidenceRequiresAnAuthorizedAction`, `test_evidenceCannotBeFinalizedTwice` |
| I-018 a valid signature over the wrong action is rejected | `test_aValidSignatureOverAnotherActionIsRejected` |
| retirement prevents new actions and is terminal | `test_retirementPreventsNewActionsAndIsTerminal` |
| revoked or unapproved code version cannot decide | `test_aRevokedCodeHashCannotRecordADecision`, `test_aCodeHashTheBindingDidNotApproveIsRejected` |

`test_aValidSignatureOverAnotherActionIsRejected` is the sharpest of these: it signs a genuine
digest with a genuinely approved key, and submits it against a different action. The recovered
address does not match, so it is rejected.

## 5. Design decisions worth stating

- **Immutable.** No proxy, no `delegatecall`, no arbitrary external call. A new version is a new
  deployment (NFR-003).
- **Signature malleability.** `_recover` rejects high-`s` values and any `v` outside {27, 28}, so a
  second valid encoding of the same signature cannot be replayed.
- **A refusal is terminal for its generation** and is counted separately from completions, so a
  refusal can never inflate the objective history.
- **The instruction sender does not re-emit the obligation.** Every field is already public in
  FAssets, and re-emitting would create a second source of truth for values that must only ever be
  read from the AssetManager.

## 6. Tests

```text
contracts/test/unit/SignetRegistry.t.sol        26 passed
contracts/test/unit/FAssetsAdapter.t.sol        19 passed
contracts/test/unit/ObligationHashParity.t.sol   4 passed
contracts/test/fork/FAssetsSeam.t.sol           12 passed
                                                61 passed, 0 failed
```

Three registry tests initially failed because `vm.expectRevert` was arming against a view call
inside a helper rather than the state-changing call. The tests were wrong, not the contract; fixing
them was the right resolution and is worth recording because the opposite reflex is how a real
defect gets papered over.

## 7. Limitations

- Local only. Nothing is deployed; deployment needs C2FLR.
- Result verification here is an approved-signer allowlist. Verifying a genuine FCC `ActionResult`
  against the on-chain registries is Phase 03's blocked half, and this contract must be re-pointed
  at it once that is unblocked.
- No invariant-style fuzzing yet; the coverage above is example-based. Phase 13 owns fuzz and
  invariant campaigns.
- `recordFinalEvidence` is governance-gated as a placeholder. PRD section 19.3 requires it to be
  gated on deterministic evidence checks instead, which needs the FDC proof path from Phase 05.

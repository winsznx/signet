# Recovery runbook

Every procedure here starts from the same question, because getting it wrong is how one redemption
becomes two payments:

> **Do I know, from a source outside this process, what happened to the last signed transaction?**

If the answer is no, do nothing else until it is yes. A replacement created during an unresolved
ledger-history gap is the failure mode this system exists to prevent, and no amount of urgency
changes that.

## 1. The coordinator crashed between signing and submitting

**Symptom:** a row in `signed_transactions` with `submitted_at` null.

The blob is durable. This is the case the design is built for: `persistBeforeSubmit` runs before the
first submission precisely so a crash here loses nothing.

1. Read the blob. Do not rebuild it. A rebuilt transaction is a different transaction, and the
   commitment covers the one that was signed.
2. Submit it. Resubmitting an already-submitted blob is safe: the ledger refuses a consumed sequence
   with `tefPAST_SEQ`, which is proven in `scripts/lifecycle/run.mjs`.
3. Reconcile before believing anything. A provisional `tesSUCCESS` is not a result.

## 2. A submitted transaction has no validated outcome

**Symptom:** submitted, but reconciliation returns neither success nor a definite absence.

1. Ask every endpoint, not one. `reconcile` in `scripts/xrpl/submit.mjs` requires an endpoint that
   answers "not found" **and** whose `complete_ledgers` covers the whole span from submission to
   `LastLedgerSequence`. An endpoint that never held those ledgers cannot testify to absence.
2. If no endpoint covers the span, you are in a ledger-history gap. **Stop.** Do not create a
   replacement. Wait for an endpoint with the history, or for `LastLedgerSequence` to pass and a
   covering endpoint to confirm absence.
3. Only once absence is established across the full span may a replacement generation be opened, and
   only through the registry, which records it as a new generation rather than a repeat.

## 3. The extension refuses and you believe it is wrong

Refusals are typed. Read the code before acting:

- `S017_STATE_UNAVAILABLE` is the only one that is safe to retry unchanged. It means the extension
  could not read its own state.
- Everything else is a policy denial. Retrying it produces the same answer, and a denial that is
  wrong is a bug to fix in the policy, never something to route around by editing an input.

There is no override. A path that lets an operator turn a refusal into an authorization is an
arbitrary signing endpoint wearing a different name.

## 4. A key must be rotated

The signing key is an XRPL RegularKey. The master key is not in the signing path.

1. Set the new RegularKey on the source account.
2. Move the binding's key state through `ROTATION_PENDING` before the old key is retired. Only
   `ACTIVE` may sign, so a binding caught mid-rotation refuses with `S019_KEY_NOT_ACTIVE` rather
   than signing with an ambiguous key.
3. Do not disable the master key in a test deployment. Recovering an account whose RegularKey is
   lost and whose master key is disabled is not possible.

## 5. Suspected extension compromise

1. Pause the system: `setSystemPaused(true)`. Every decision then refuses `S016_PAUSED`.
2. Revoke the code hash: `approveCodeHash(hash, ..., false)`. A revoked build refuses
   `S015_CODE_VERSION_REVOKED` even if it is running.
3. Both are governance calls, and neither can be made by the coordinator.

Revocation stops future decisions. It does not recall a signature already produced, so also
reconcile every unresolved action before deciding anything else.

## 6. Verifying an incident afterwards

```bash
pnpm --filter @signet/verifier verify:receipt <transaction hash>
```

`UNVERIFIABLE` exits 3 and is not a pass. Treat it as an open question, never as a clean bill.

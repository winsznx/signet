# XRPL protocol seam

Status: **proven.**
Verified: 2026-08-11 against XRPL Testnet (network id 1).
SDK: `xrpl` 5.0.0, pinned in `pnpm-lock.yaml`.

This seam answers one question: can the reference model's transaction template be signed and
validated on a real ledger, exactly as the model produced it, and can Signet tell the difference
between a payment that failed and a payment it simply cannot see.

## Accounts

Three keys, all XRPL Testnet, all generated locally and stored mode 600 under `.runtime/secrets/`,
which is gitignored and deny-read by the sandbox.

| Role | Address | Purpose |
|---|---|---|
| agent source | `rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta` | the agent's underlying account, funded 100 XRP |
| redeemer destination | `rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb` | stands in for the redeemer's address |
| Signet RegularKey | `r39Wfn26tTY6JA3vACnRwucLSeQ2v5JcXU` | delegated signing authority, no account of its own |

The key is generated locally rather than by the faucet on purpose. A faucet that mints the key
returns the seed in its HTTP response, which would put it in a log, a terminal buffer and this
agent's context at once. Asking the faucet only to fund an address we already own keeps the secret
in one place.

## Key lifecycle

`SetRegularKey` validated at ledger 19,822,182, transaction
`03445ECA6C42EA46BDF2AA0CBAA348C0A889529334798126602BDC9477E3C82F`.

This is the only operation in the entire system that uses the master key. Afterwards the account
reports `RegularKey = r39Wfn26tTY6JA3vACnRwucLSeQ2v5JcXU`, read back from a validated ledger rather
than assumed from the submission, because rotation is not complete until the new configuration is
independently observed.

`lsfDisableMaster` is deliberately **not** set. The master key stays offline as the recovery path if
the RegularKey is lost or compromised (FR-070, G4). Disabling it would make the demo tidier and the
account unrecoverable.

## The exact payment

Transaction `7500DA52CAB254DBD1B64BC88975B2D01C4DFDF309A6C78398C57142493759AF`, validated at ledger
19,822,204 with `tesSUCCESS`.

https://testnet.xrpl.org/transactions/7500DA52CAB254DBD1B64BC88975B2D01C4DFDF309A6C78398C57142493759AF

What makes this evidence rather than a demo: the transaction was **not** hand-built and then
compared against the model. The model's `txTemplate` *is* the transaction. The script feeds the live
sequence, fee and ledger height into `decide()`, and submits whatever comes out, verbatim:

```json
{"TransactionType":"Payment","Account":"rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta",
 "Destination":"rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb","Amount":"1990000","Fee":"10","Flags":0,
 "LastLedgerSequence":19822242,
 "Memos":[{"Memo":{"MemoData":"4642505266410002000000000000000000000000000000000000000002AC612A"}}],
 "Sequence":19822140}
```

The memo is the FAssets payment reference for the real Coston2 obligation 44851498 decoded in
Phase 02, so the same value ties this ledger transaction to that obligation. The authorization
commitment for it is
`0xbfd579481792c57c7ba0f84f1e2decf9669f87ad533d7528db0645ba2ec14f92`.

Signed by the RegularKey. The master key is not present anywhere in this path.

## Reliable submission

The state machine is `BUILT -> SIGNED -> DURABLY_PERSISTED -> SUBMITTED_PROVISIONAL ->
VALIDATED_SUCCESS | VALIDATED_FAILURE | EXPIRED_NOT_FOUND | UNKNOWN_LEDGER_GAP`.

Three properties are enforced by construction rather than by convention:

**Persist before submit.** `submitPersisted` refuses to send a blob that is not already on disk. A
signed blob that exists only in memory is a payment that may already be spendable and that a restart
would forget. The store also refuses to overwrite a different blob under the same hash.

**A provisional result is not a result.** `submit` returns `tesSUCCESS` immediately for a
transaction that has not been validated by anything. The code records it as an *attempt* and moves
to `SUBMITTED_PROVISIONAL`, never to success.

**Absent is not the same as unknown.** After the window closes, "not found" only means
`EXPIRED_NOT_FOUND` when an endpoint that **was itself asked for the transaction** can prove its
`complete_ledgers` range spans the **entire** window, from the ledger current at first submission
through `LastLedgerSequence`. Otherwise the answer is `UNKNOWN_LEDGER_GAP`, and no replacement may
be built from that state.

Both halves of that sentence were bought with a bug. See below.

## Adversarial cases

Ten cases, all run against the live testnet, recorded in `evidence/receipts/xrpl-adversarial.json`.

| Case | Result |
|---|---|
| fee above the cap | refused before signing, `S013_FEE_CAP_EXCEEDED` |
| partial-payment flag | unreachable: `Flags` is pinned to 0 on every authorized template |
| missing `LastLedgerSequence` | unreachable: always present |
| `LastLedgerSequence` in the past | refused, `S008_INSUFFICIENT_SAFETY_MARGIN` |
| resubmit the identical blob | `tesSUCCESS` then `tefPAST_SEQ`, exactly one validated payment |
| submission attempts are recorded | 2 attempts against 1 hash |
| reuse a consumed sequence | `tefPAST_SEQ` |
| let a transaction expire | `EXPIRED_NOT_FOUND` with complete coverage |
| coverage parsing | in-range true, out-of-range false, empty false |
| pruned window | reported not covered, so unknown rather than absent |

The expiry case is a real one: a transaction was signed, submitted and allowed to die past its
`LastLedgerSequence`, and the reconciler then had to distinguish a genuine absence from an
unobservable one.

## Two defects this phase found in itself

### The one the tests found

The first adversarial run failed partway through with `tx: HTTP 418`. The public testnet cluster
rate-limits an aggressive reconciliation loop, and the client treated any failed lookup as an
answer. That is the exact shape of the bug the seam exists to prevent: a rate limit would have been
indistinguishable from a missing transaction, and a missing transaction near the deadline is what
authorizes a replacement.

Fixed by classifying transient failures separately from answers. 408, 418, 425, 429 and 5xx are
retried with exponential backoff across every locked endpoint, and the reconciler records an outage
and waits rather than advancing the state machine. A transient failure can no longer produce
`EXPIRED_NOT_FOUND`.

### The one the review found, which was worse

An adversarial review reproduced a second instance of the same bug class, and this one the ten live
cases could never have caught.

`reconcile` asked endpoint A whether it had the transaction, got "not found", and then asked
`ledgerCoverage` whether *any* endpoint could see the window. If endpoint B said yes, the module
returned `EXPIRED_NOT_FOUND` — on the strength of a coverage claim from a server that had never
been asked about the transaction at all. If A were lagging or resyncing while B held the validated
transaction, a payment that had actually succeeded would be reported as definitively absent. That
is the state a later phase consumes to authorize a replacement, so it could have produced a second
validated payment for one obligation.

A second, narrower defect came with it: coverage was tested at the single point
`LastLedgerSequence` rather than across the window, and the submission-time ledger was never
recorded, so a node whose retention boundary was transiting the window would report it fully
covered while having pruned the head where the transaction could have validated.

Both are fixed:

- every endpoint is asked for the transaction, and only an endpoint that answered "not found" may
  testify to absence;
- that endpoint's own coverage must span `[submittedAtLedger, lastLedgerSequence]` entirely, with
  one contiguous range;
- `requestFrom` asks one endpoint with retry but **no rotation**, because rotation is right for
  "what is the answer" and wrong for "what does this server know";
- a single endpoint reporting a validated transaction settles it, because a validated ledger cannot
  be invented, whereas absence needs both consensus and coverage.

`scripts/xrpl/reconcile.test.mjs` pins all of it with a stubbed transport, which is the only way to
make two endpoints disagree on demand. Two of its five cases return `EXPIRED_NOT_FOUND` under the
old logic and `UNKNOWN_LEDGER_GAP` under the new.

The lesson worth keeping: both defects were the same mistake, letting a source that cannot see the
whole picture stand in for one that can. The live suite found the first because real infrastructure
rate-limited it. Only an adversarial reader found the second, because real infrastructure never
disagreed with itself during the run.

## Reproduce

```bash
node scripts/xrpl/provision-account.mjs agent-source --fund
node scripts/xrpl/provision-account.mjs redeemer-destination --fund
node scripts/xrpl/provision-account.mjs signet-regular-key
node scripts/xrpl/set-regular-key.mjs
node --experimental-strip-types scripts/xrpl/pay-from-reference.mjs
node --experimental-strip-types scripts/xrpl/adversarial.mjs
```

These scripts read key material from `.runtime/secrets/`, which the sandbox deny-reads. That control
was added in Phase 00 after a security review and it does its job: the scripts must be run with
filesystem access to that directory. They print addresses, hashes and public keys, never a seed.

## Open items

- Transaction construction here uses the reference model plus the `xrpl` SDK for serialisation and
  signing. The PRD assigns security-critical construction and signing to the Go extension; that is
  Phase 07, and it must consume the same frozen fixtures rather than reimplement the template.
- Tickets are modelled and covered by fixtures but no Ticket-carried payment has been sent on chain.
- The multi-sign fee floor is still modelled from documented XRPL scaling rather than measured.
- Both locked endpoints are public infrastructure. Production requires two independently operated
  providers under Signet's own control.

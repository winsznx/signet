# Phase 04 — XRPL transaction seam

Result: **PASS**
Date: 2026-08-11
Branch: `build/signet-autonomous`
Networks touched: XRPL Testnet (state-changing), Coston2 (read-only, in earlier phases)

## 1. Objective

Create a test account, configure a RegularKey, construct an exact Payment from a fixture, and
persist, submit and reconcile it reliably. The completion gate is one exact test payment reaching
validated success with deterministic evidence. The stop boundary is that no FAssets claim may be
made from this phase.

## 2. The payment

Transaction `7500DA52CAB254DBD1B64BC88975B2D01C4DFDF309A6C78398C57142493759AF`, validated at XRPL
Testnet ledger 19,822,204 with `tesSUCCESS`.

https://testnet.xrpl.org/transactions/7500DA52CAB254DBD1B64BC88975B2D01C4DFDF309A6C78398C57142493759AF

The transaction was not hand-built and then compared against the reference model. The model's
`txTemplate` **is** the transaction: `scripts/xrpl/pay-from-reference.mjs` feeds the live sequence,
fee and ledger height into `decide()` and submits whatever comes out, verbatim. If the model ever
produced a template the ledger rejects, that script fails rather than quietly correcting it.

```json
{"TransactionType":"Payment","Account":"rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta",
 "Destination":"rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb","Amount":"1990000","Fee":"10","Flags":0,
 "LastLedgerSequence":19822242,
 "Memos":[{"Memo":{"MemoData":"4642505266410002000000000000000000000000000000000000000002AC612A"}}],
 "Sequence":19822140}
```

The memo carries the FAssets payment reference for the real Coston2 obligation 44851498 decoded in
Phase 02, which is what ties this ledger transaction back to that obligation. The authorization
commitment is `0xbfd579481792c57c7ba0f84f1e2decf9669f87ad533d7528db0645ba2ec14f92`.

## 3. Key lifecycle

`SetRegularKey` validated at ledger 19,822,182, transaction
`03445ECA6C42EA46BDF2AA0CBAA348C0A889529334798126602BDC9477E3C82F`. The account was then re-read
from a validated ledger and reports the expected RegularKey, because rotation is not complete until
the new configuration is independently observed.

That is the only use of the master key anywhere in this system. `lsfDisableMaster` is deliberately
not set: the master stays offline as the recovery path (FR-070, G4). Disabling it would make the
demo tidier and the account unrecoverable.

Keys were generated locally rather than by the faucet. A faucet that mints the key returns the seed
in its HTTP response, which would put it in a log, a terminal buffer and this agent's context at
once.

## 4. Reliable submission

Three properties enforced by construction:

- `submitPersisted` refuses to send a blob that is not already on disk, and the store refuses to
  overwrite a different blob under the same hash (FR-040).
- A `submit` response moves the record to `SUBMITTED_PROVISIONAL`, never to success. Only a
  validated ledger produces `VALIDATED_SUCCESS` (FR-042).
- "Not found after the window closed" resolves to `EXPIRED_NOT_FOUND` only when a server's
  `complete_ledgers` range actually spans the window. Otherwise it is `UNKNOWN_LEDGER_GAP`, from
  which no replacement may be built (FR-043, FR-044, I-010).

## 5. Adversarial cases

Ten, all against the live testnet, recorded in `evidence/receipts/xrpl-adversarial.json`.

| Case | Result |
|---|---|
| fee above the cap | refused before signing, `S013_FEE_CAP_EXCEEDED` |
| partial-payment flag | unreachable: `Flags` pinned to 0 on every authorized template |
| missing `LastLedgerSequence` | unreachable: always present |
| `LastLedgerSequence` in the past | refused, `S008_INSUFFICIENT_SAFETY_MARGIN` |
| resubmit identical blob | `tesSUCCESS` then `tefPAST_SEQ`, one validated payment |
| submission attempts recorded | 2 attempts, 1 hash |
| reuse a consumed sequence | `tefPAST_SEQ` |
| real expiry | `EXPIRED_NOT_FOUND`, coverage complete |
| coverage parsing | all cases correct |
| pruned window | not covered, so unknown rather than absent |

The expiry case is genuine: a transaction was signed, submitted and allowed to die past its
`LastLedgerSequence`.

## 6. A defect this phase found in itself

The first adversarial run failed with `tx: HTTP 418`. The public testnet cluster rate-limits an
aggressive reconciliation loop, and the client treated any failed lookup as an answer.

That is precisely the failure the seam exists to prevent. A rate limit would have been
indistinguishable from a missing transaction, and a missing transaction near the deadline is what
authorizes a replacement. The bug could have produced a second payment for one obligation.

Fixed by separating transient failures from answers: 408, 418, 425, 429 and 5xx are retried with
exponential backoff across every locked endpoint, and the reconciler records an outage and waits
rather than advancing the state machine. A transient failure can no longer produce
`EXPIRED_NOT_FOUND`. All ten cases pass after the fix.

Worth stating plainly: this was found by running the adversarial cases against real infrastructure,
not by reading the code. A mocked RPC would have returned a clean answer every time.

## 7. Sandbox interaction with the Phase 00 secret control

The `.runtime/secrets` deny-read rule added in Phase 00 after the security review blocks these
scripts from reading their own key material. That is the control working as designed rather than a
misconfiguration: it means no injected instruction can read a seed through ordinary tooling. The
scripts are run with filesystem access to that directory deliberately, and they print addresses,
hashes and public keys, never a seed.

The trade-off is worth recording: a control that blocks the agent also blocks the agent's scripts,
so the protection depends on the scripts being written not to print secrets rather than on the
sandbox alone. In the target architecture signing happens inside the TEE and this question does not
arise.

## 8. Limitations

- XRPL Testnet only, test-only key material throughout.
- No FAssets claim is made. The obligation fields come from a real Coston2 redemption belonging to a
  third-party agent; this is a seam proof, not a settlement. No FDC proof and no FAssets completion
  accompany it.
- Signing used the `xrpl` SDK in a local process, not the Go extension inside a TEE. The extension
  is Phase 07 and must consume the same frozen fixtures rather than reimplement the template.
- Tickets are modelled and covered by fixtures but no Ticket-carried payment has been sent on chain.
- Ledger-gap handling is proven by a pruned-window probe rather than by a real history gap, which
  cannot be induced on demand.
- The reconciler is a script, not the durable coordinator. Restart safety under a real database is
  Phase 08.
- Both endpoints are public infrastructure, not independently operated providers under Signet's
  control.

## 9. Completion gate

| Requirement | Met |
|---|---|
| Test account created | Yes, three accounts, keys generated locally |
| RegularKey configured | Yes, validated and read back; master retained offline |
| Exact Payment constructed from a fixture | Yes, the reference model's template submitted verbatim |
| Persisted, submitted and reconciled reliably | Yes, persist-before-submit enforced, provisional never final |
| One exact test payment at validated success with deterministic evidence | Yes, ledger 19,822,204, receipt committed |

Stop boundary respected: no FAssets claim is made from this phase. The claim ledger records the
payment as a seam proof with the absence of FDC and FAssets completion stated explicitly.

# Phase 08 — Durable coordinator

Result: **PARTIAL PASS.** The durability and concurrency safety properties are proven against a real
PostgreSQL. The live observer and orchestration loops are not built, because they need the deployed
contracts that Phase 03 is blocked on.
Date: 2026-08-11
Branch: `build/signet-autonomous`

## 1. Objective

Event observers, the Postgres model, leases, action polling, persist-before-submit, XRPL
reconciliation and FDC orchestration. The completion gate is: no restart or duplicate delivery
creates duplicate authority.

## 2. The design decision that matters

Every safety property is a **database constraint**, not application logic.

That is the whole point. A code path holds only if every future caller remembers it; a constraint
holds under concurrency, under a crash mid-transaction, and against a worker that skips the
application layer entirely. The tests below deliberately attack the database directly rather than
going through any coordinator API, because a safety property that only holds when you use the front
door is not a safety property.

Concretely:

| Property | Mechanism |
|---|---|
| one action per request generation | `UNIQUE (flare_chain_id, asset_manager, request_id, request_generation)` |
| at most one completed payment per obligation (I-009) | partial unique index on `state = 'FASSETS_COMPLETED'` |
| one signed transaction per action | unique index on `signed_transactions (action_id)` |
| a sequence or ticket consumed once per account | unique index on `(source_account, sequence_mode, sequence_or_ticket)` |
| single-writer leases with fencing (NFR-011) | `leases` plus a globally monotonic `fencing_token_seq` |
| duplicate event delivery is a no-op (NFR-010) | `observed_events` primary key with `ON CONFLICT DO NOTHING` |

## 3. Proven

```text
ok   a duplicate event cannot create a second action for one generation
ok   a new generation is a distinct action
ok   one obligation can never have two completed payments
ok   one action cannot hold two signed transactions
ok   a sequence cannot be consumed by two transactions on one account
ok   a second worker cannot take a live lease
ok   an expired lease can be taken, and the new token is strictly higher
ok   a write fenced by a stale token is rejected
ok   redelivering the same event does no work twice
ok   a signed transaction persisted before submission survives a restart
ok   three concurrent workers produce exactly one action

11/11 durability properties hold
```

The concurrency case runs three workers racing to insert the same action and asserts exactly one
wins. The fencing case takes a lease, expires it, lets a second worker take it, and then proves the
first worker's now-stale token cannot write.

## 4. Is durable PostgreSQL actually required?

The PRD asks this question rather than assuming it, and the answer is **yes**, for a reason that is
about safety rather than convenience: the properties above are enforced by unique indexes and a
monotonic sequence. A store without transactional uniqueness across concurrent writers cannot
express them, and the coordinator would have to re-implement them in application logic, which is
exactly what makes double-authority bugs possible.

For local proof, PostgreSQL in Docker needs no credentials. A deployed coordinator would need
managed Postgres, and per the run's infrastructure policy that means Supabase with user-supplied
credentials. That is not requested yet, because nothing is deployed.

## 5. What is not built

- The Coston2 and XRPL observers, action polling and FDC orchestration loops. These consume deployed
  contract events; Phase 03's deployment is blocked on C2FLR.
- Crash injection at every external-call boundary as running processes. The equivalent invariants are
  proven at the state layer instead: the persisted-blob test shows a crash between signing and
  submitting leaves the blob recoverable with `submitted_at` still null.
- Two live workers competing over a real action. Proven as a database race instead.

## 6. Limitations

- Local PostgreSQL 17 in Docker, not a managed deployment.
- The schema is proven; the coordinator process that uses it is not written.
- `signed_blob` is stored in plain text. PRD section 14.3 calls for encryption at rest for this
  column; that is a Phase 13 hardening item and is recorded rather than done.
- No lease renewal or heartbeat logic yet, only acquisition and expiry.

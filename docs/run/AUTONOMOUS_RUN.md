# Signet autonomous run

Branch: `build/signet-autonomous`
Started: 2026-08-11
Mode: one-approval build. Phases 00-05 were the validation block; Phases 06-13 continued
automatically. Phases 14 and 15 are explicitly out of scope for this run.

Live state: `docs/run/run-state.json`.
Guarantee, stated narrowly: `docs/guarantee.md`.
Outstanding external request: `docs/requests/fassets-agent-whitelist.md`.

> **This file was empty from commit `86f9417` until it was restored.** A phase-status edit removed
> its contents, and every later run that "recorded status in the run ledger" wrote a string
> replacement into an empty file and silently succeeded. Nothing checked. The operator page parses
> this file for its phase table, so the deployed page showed an empty table for the whole run, and
> an evidence audit is what caught it. `web/test/check.mjs` now fails the build if the table is
> empty, because a silent nothing is the failure mode that survives longest.

## Phase index

| Phase | Title | Result | Evidence | Summary | Commit |
|---|---|---|---|---|---|
| 00 | Source lock and environment | PASS | [phase-00.md](../evidence/phase-00.md) | | `6c41986` |
| 01 | Executable reference model | PASS | [phase-01.md](../evidence/phase-01.md) | | `bce7748` |
| 02 | FAssets protocol seam | PASS | [phase-02.md](../evidence/phase-02.md) | | `293f7fa` |
| 03 | FCC scaffold seam | PASS (deployment half completed once C2FLR arrived) | [phase-06.md](../evidence/phase-06.md), [phase-10.md](../evidence/phase-10.md) | | `c23d915` |
| 04 | XRPL transaction seam | PASS | [phase-04.md](../evidence/phase-04.md) | | `4b6625a` |
| 05 | FDC seam | PASS (proof accepted on chain) | [phase-05.md](../evidence/phase-05.md) | | `c23d915` |
| 06 | Minimum Signet contracts | PASS | [phase-06.md](../evidence/phase-06.md) | | `6bafa14` |
| 07 | Signet extension policy | PASS | [phase-07.md](../evidence/phase-07.md) | | `c23d915` |
| 08 | Durable coordinator | PARTIAL (durability proven; observer loops need a running coordinator) | [phase-08.md](../evidence/phase-08.md) | | `a178bbd` |
| 09 | Full local composed lifecycle | PASS | [phase-09.md](../evidence/phase-09.md) | | `1d688a8` |
| 10 | Target-chain lifecycle | PARTIAL (Signet's leg verified on chain; own-agent settlement out of scope by organizer guidance, not pending) | [phase-10.md](../evidence/phase-10.md) | | `c23d915` |
| 11 | Independent verifier and claim ledger | PASS | [phase-11.md](../evidence/phase-11.md) | | `b8845e3` |
| 12 | Essential operator and proof UI | PASS (deployed) | [phase-12.md](../evidence/phase-12.md) | | `8310aad` |
| 13 | Hardening | PASS (the high risk it recorded is closed by gate B) | [phase-13.md](../evidence/phase-13.md) | | `2152095` |
| gate B | Canonical requestId-only derivation | PASS (deployed on Coston2, extension `66244`) | [gate-b.md](../evidence/gate-b.md) | | `95866e0` |
| 14 | Submission | PASS (package assembled, nothing submitted externally) | [phase-14.md](../evidence/phase-14.md) | | pending |

## After the phases: schema V2

Phase 10 ran on the target chain and found that Signet had double-paid a live Coston2 redemption
(request 44928272). The agent had already paid it; FAssets reported `ACTIVE` throughout, because
confirmation is a separate transaction submitted after the payment validates.

| | |
|---|---|
| ADR | [0003](../adr/0003-underlying-payment-precheck.md), accepted and implemented |
| Correction | schema V2: a required XRP ledger observation, bound into the authorization commitment |
| Reason codes | `S021_PAYMENT_ALREADY_OBSERVED`, `S022_UNDERLYING_STATE_UNAVAILABLE`, `S023_UNDERLYING_STATE_DISAGREEMENT`, `S024_UNDERLYING_OBSERVATION_STALE` |
| Regression | [`scripts/lifecycle/incident-44928272.test.mjs`](../../scripts/lifecycle/incident-44928272.test.mjs) |
| What is actually guaranteed | [`docs/guarantee.md`](../guarantee.md) |

## Standing constraints

- The extension has no arbitrary signing endpoint, and the public request API accepts a FAssets
  request identifier only.
- A provisional XRPL response is never a final result, and no replacement is created during an
  unresolved ledger-history gap.
- Simulated TEE execution is labelled simulated everywhere it appears.
- Every public number is generated from `evidence/claim-ledger.json`, never typed in.

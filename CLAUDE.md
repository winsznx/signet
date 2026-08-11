# CLAUDE.md

## Product

Signet is an attested external execution layer for FAssets agents.

Core mechanism:

```text
FAssets obligation
  -> FCC-constrained XRP signature
    -> FDC-proven completion
```

Read `PRD.md` before changing architecture or protocol code.

## Source of truth

Priority order:

1. Pinned official source in `docs/source-lock.json`
2. Executable reference model and shared fixtures
3. PRD invariants and phase gate
4. Existing implementation
5. Comments and prose

Do not invent an interface, address, selector, payment encoding, deadline, proof type or FCC behavior.

Resolve current Flare addresses from official periphery or ContractRegistry. Verify code and selectors by RPC.

## Critical safety rules

- There is no arbitrary signing endpoint.
- The caller supplies a FAssets `requestId`, not payment fields.
- Destination, amount, memo or reference, tag and window come from FAssets.
- Persist a signed XRPL transaction before first submission.
- A provisional XRPL response is not final.
- Never create a replacement during an unresolved ledger-history gap.
- Never expose, log, print, store or request a seed, private key or secret share.
- Never read `.env`, secret-manager exports, cloud credentials or wallet files.
- Never claim simulated TEE execution is hardware-attested.
- Never mark FAssets completion from local state alone.
- Never alter pinned upstream framework code without an ADR and source-lock update.

## Working method

The repository may be executed in autonomous-run mode when the user supplies `AUTONOMOUS_EXECUTION_PROMPT.md`. In that mode, the prompt below supersedes the older fresh-session-per-phase workflow.

For each phase:

1. Read the current phase in `PRD.md`.
2. Inspect the repository and upstream pinned files.
3. Produce an internal plan with exact files, tests, evidence and stop condition. Do not wait for user approval unless a hard external blocker exists.
4. Stay inside the phase.
5. Implement the smallest complete change.
6. Run verification.
7. Ask the security reviewer and evidence auditor to review.
8. Write `docs/evidence/phase-NN.md` and `docs/run/phase-NN-summary.md`.
9. Commit the passing phase.
10. Continue automatically to the next admitted phase.

Autonomous-run sequencing:

- Phases 00-05 are the validation block.
- If validation passes, continue through Phases 06-13 without confirmation between phases.
- Stop for an explicit hard blocker, a falsified central claim without a safe admitted fallback, or after Phase 13 has passed and `docs/run/FINAL_REVIEW_HANDOFF.md` exists.
- Do not execute Phase 14 submission or Phase 15 production-candidate expansion in the autonomous build run.

The exact autonomous rules, deployment boundaries, Cloudflare policy, Supabase handoff, design rules, funding behavior and run-state schema live in `AUTONOMOUS_EXECUTION_PROMPT.md`.

## Repository commands

Use the Makefile entry points rather than ad hoc command variants.

```bash
make bootstrap
make fmt
make lint
make typecheck
make test-unit
make test-property
make test-contract
make test-race
make test-integration
make test-e2e
make scan
make verify
make verify-phase PHASE=NN
```

When a command is not implemented yet, add it in the phase that owns it. Do not silently skip it.

## Languages and boundaries

- Solidity and Foundry: contracts and contract tests
- Go: FCC extension and security-critical XRPL transaction construction
- TypeScript: reference model, coordinator, verifier and web
- PostgreSQL: durable coordinator state
- Redis: only where required by the pinned FCC proxy stack

The coordinator is untrusted for payment authority.

## Code rules

- Fail closed.
- Reject unknown fields and unsupported versions.
- Use typed errors and stable reason codes.
- Keep functions small around trust boundaries.
- Add tests before or with implementation.
- Use shared fixtures rather than duplicated expected values.
- Use explicit state transitions.
- Use idempotency keys, leases and fencing tokens.
- Keep secrets out of logs, traces, errors and fixtures.
- Do not add upgradeable proxies, arbitrary external calls or `delegatecall`.
- Do not add AI, tokens, governance, markets or analytics unless the PRD phase admits them.

## Evidence rules

Every public claim must exist in `evidence/claim-ledger.json`.

A phase is not complete because code compiles. It is complete only when the phase evidence and target-network requirement pass.

Do not count:

- local runs as public-chain evidence;
- mocks as protocol composition;
- deployed addresses as completed workflows;
- simulated TEE as hardware attestation;
- test wallets as users.

## Git rules

- In autonomous-run mode, use one dedicated run branch and one coherent commit per phase. Do not create external worktrees.
- Outside autonomous-run mode, one coherent phase or fix per branch remains acceptable.
- Do not mix refactors with protocol behavior.
- Never commit `.env`, generated secrets, wallet files or credentials.
- Include test evidence in the PR description.
- Require review for contracts, policy, key lifecycle, transaction builder and recovery.

## Autonomous infrastructure constraints

When `AUTONOMOUS_EXECUTION_PROMPT.md` is active:

- All project artifacts remain inside the repository.
- User-owned application hosting is Cloudflare only.
- Flare Coston2, XRPL Testnet, FDC and protocol-required FCC/GCP Confidential Space are protocol-native exceptions, not general application hosting.
- If durable PostgreSQL is required, use Supabase Postgres with user-supplied credentials.
- `design.md` and root branding assets control Phase 12 visual implementation.
- Testnet-only keys may be generated under `.runtime/secrets/`, which must be gitignored. Never log or commit private material.
- Missing funding or credentials is an external blocker. Ask only for the exact missing input, then resume.

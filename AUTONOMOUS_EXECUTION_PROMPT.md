# Signet autonomous build prompt for Claude Code

You are now the implementation agent for Signet. The product is already locked. Do not reopen ideation.

## 1. Read before acting

Read, in this order:

1. `CLAUDE.md`
2. `PRD.md`
3. `design.md` if present
4. `docs/source-lock.json` and source-lock templates if the concrete file is not created yet
5. all existing `docs/evidence/phase-*.md`
6. all existing `docs/run/*`
7. `.claude/agents/*` and `.claude/skills/*`
8. root-level branding/image assets
9. the current repository, tests, git status and deployment manifests

The PRD is the product and protocol source of truth except where newer pinned official protocol source disproves an assumption. If that happens, document the contradiction, update the source lock, add an ADR, narrow the claim if needed, and preserve the dominant mechanism where technically valid.

Do not generate alternative products.

## 2. Dominant mechanism

The mechanism that must survive every implementation decision is:

```text
FAssets redemption obligation
  -> FCC-constrained XRP signature
    -> FDC-proven completion
```

The host must never be able to turn Signet into an arbitrary XRP signer.

## 3. Workspace boundary

Treat the repository root as the only project workspace.

- All code, vendored/pinned source copies, generated artifacts, caches that can be configured locally, logs, evidence, screenshots, deployment manifests, temporary fixtures and scripts must stay under this repository.
- Do not create Claude worktrees or project clones outside the repository.
- Do not write project files into the parent directory, home directory, Desktop, Downloads or another repository.
- Do not read unrelated files outside the repository.
- OS/toolchain caches outside the repository are tolerated only when a tool cannot reasonably be configured otherwise. Never place project source or secrets there.
- Remote deployments are allowed only under the deployment policy below.

## 4. Deployment policy

There are three different deployment classes. Do not confuse them.

### 4.1 Protocol-native deployments

These are required by the product and are allowed:

- Flare Coston2 smart contracts
- XRP Ledger Testnet transactions/accounts
- FDC requests and proofs
- Flare FCC/FCE infrastructure on the officially supported environment
- GCP Confidential Space only when required by the official FCC architecture for a real attested TEE

Do not move FCC security-critical execution to Cloudflare Workers just to satisfy the application-hosting rule. A protocol-mandated TEE environment is part of Flare integration, not general web hosting.

### 4.2 User-owned off-chain application infrastructure

Anything we choose to host ourselves must use Cloudflare only.

This includes, when needed:

- web frontend
- proof site
- public API
- coordinator API or edge gateway where technically appropriate
- static assets
- scheduled web jobs that are safe for the Cloudflare runtime

Do not deploy the application to Vercel, Railway, Render, Fly.io, AWS application hosting, Netlify, Heroku or another general-purpose host.

Before choosing a Cloudflare product, verify the current official Cloudflare documentation and choose the current production-appropriate primitive. Do not assume old Pages/Workers behavior.

If a required service cannot correctly run on Cloudflare because of protocol or runtime constraints, document why. Keep the service local for the proof unless the PRD admits another protocol-mandated environment. Do not silently introduce another hosting provider.

### 4.3 Database

If Phase 08 proves durable PostgreSQL is required, use Supabase Postgres as the managed database.

- Do not substitute Cloudflare D1 for the PRD's PostgreSQL state machine without an ADR proving semantic equivalence.
- Do not provision a database before the phase requires one.
- The user will provide Supabase credentials if needed.
- Migrations must be committed and reproducible.

## 5. Frontend and design policy

Do not build the frontend before the PRD phase admits it.

When Phase 12 is reached:

- `design.md` in the repository root is the authoritative design direction.
- Inspect and use the branding images/assets placed in the repository root.
- Do not invent a replacement brand, logo, visual system or generic crypto dashboard style.
- Do not generate new brand imagery unless explicitly instructed later.
- Preserve the proof-first information hierarchy from the PRD.
- Build production-quality responsive UI with keyboard support, accessible semantics, visible focus, reduced-motion support, loading/error/empty states and mobile layouts.
- Never hide protocol limitations in visual polish.
- Never hard-code unverified marketing numbers. Public metrics must be generated from the claim ledger/evidence.

If `design.md` is absent when Phase 12 begins, do not block protocol work. Stop only Phase 12, record `WAITING_DESIGN_INPUT`, and continue any independent non-UI hardening work that does not violate phase order.

## 6. Credentials, keys and funding

Never print, echo, commit, screenshot or place secrets into evidence files.

### Credentials

Prefer credentials supplied through environment variables or authenticated CLIs. Use only the credentials required for the active phase.

If Cloudflare, Supabase, Flare indexer or other required credentials are missing, batch all missing credential names into one blocker request instead of asking separately.

Do not copy credentials into source files.

### Testnet keys

You may generate dedicated testnet-only keys when the phase requires them.

- Store them only under `.runtime/secrets/` or an equivalent gitignored repo-local runtime directory.
- Never commit them.
- Never include private material in logs, phase summaries, command output copied into evidence, frontend state or chat responses.
- Public addresses may be logged.
- Never generate or manage mainnet-value custody keys in this autonomous run.

For the Signet XRPL model, preserve the PRD rule: offline master key plus rotatable RegularKey. Do not weaken the key lifecycle to make the demo easier.

### Funding

If a generated account requires funds:

1. write `docs/run/FUNDING_REQUEST.md`
2. include only the public address, exact network, asset, minimum amount and reason
3. set `docs/run/run-state.json` to `awaiting_external_input` with blocker type `funding`
4. stop only for that external event
5. after the user funds it and restarts/resumes the session, verify funding on-chain and continue without asking for another approval

Do not ask the user to approve ordinary implementation decisions.

## 7. Autonomous execution model

This is a one-approval build after protocol validation.

### Stage A: validation block

Execute Phases 00 through 05 in PRD order.

For each phase:

1. inspect the current code and pinned upstream source
2. make an internal implementation plan
3. implement only the phase
4. run every required test/check
5. invoke the relevant protocol-seam verifier, security reviewer and evidence auditor
6. write `docs/evidence/phase-NN.md`
7. write `docs/run/phase-NN-summary.md`
8. update `docs/run/run-state.json`
9. update the claim ledger when a claim changes proof level
10. commit the coherent phase with a phase-scoped commit message
11. continue automatically if the gate passes

Do not ask me to approve each phase plan.

After Phase 05, write `docs/run/VALIDATION_DECISION.md` with exactly one top-level status:

- `PASS`
- `BLOCKED`
- `FAIL`

`PASS` requires the actual protocol seams required by the PRD to be sufficiently proven for the remaining build. Local mocks cannot produce PASS.

If `BLOCKED` or `FAIL`, stop and provide one consolidated blocker report. Do not build later phases on a disproven seam.

### Stage B: autonomous build

If validation is `PASS`, continue immediately through Phases 06 to 13 in the same run with no user confirmation between phases.

The same per-phase evidence, tests, adversarial review, summary and commit rules apply.

A phase may use a documented fallback already allowed by the PRD. Any new fallback that changes a trust boundary, security invariant, external protocol behavior or public claim requires an ADR and must not silently broaden the claim.

Do not skip a failed test to keep moving.

Do not mark a phase passed while its target-network requirement is unmet.

## 8. Hard blockers that may interrupt the one-shot run

Only interrupt for one of these:

- required credential/authentication is absent
- a testnet account needs user funding
- Flare/FCC access must be granted by an external party
- a current official protocol interface disproves a central PRD assumption and no safe admitted fallback exists
- a destructive or irreversible action outside testnet is required
- a security invariant cannot be satisfied
- a required root design input is missing exactly when its phase begins and no independent work remains

When blocked, ask for the smallest exact external action needed. Batch related blockers. Do not ask yes/no questions for normal coding choices.

## 9. Git behavior for the autonomous run

Stay in this repository.

- Create one run branch such as `build/signet-autonomous` if not already on a dedicated branch.
- Do not create external worktrees.
- Commit after every passing phase.
- Use commit messages like `phase 04: prove xrpl reliable submission seam`.
- Never mix later-phase features into an earlier phase commit.
- Never commit secrets, `.runtime/secrets/`, `.env*`, credential files or raw wallet material.
- Preserve a clean `git status` at phase gates except for intentionally generated evidence committed with that phase.

## 10. Required run ledger

Create and maintain:

### `docs/run/run-state.json`

At minimum:

```json
{
  "product": "Signet",
  "status": "running",
  "currentPhase": 0,
  "lastPassingPhase": null,
  "validation": "pending",
  "blocker": null,
  "updatedAt": "ISO-8601 timestamp"
}
```

Allowed statuses:

- `running`
- `awaiting_external_input`
- `failed`
- `ready_for_review`

### `docs/run/phase-NN-summary.md`

Every phase summary must contain:

- phase objective
- exact scope completed
- files/components changed
- source-lock changes
- commands run and pass/fail
- tests added
- adversarial cases exercised
- target-network evidence
- contract addresses and transaction IDs where applicable
- deployment URL where applicable
- security-review result
- evidence-audit result
- deviations/ADRs
- unresolved limitations
- claim-ledger changes
- commit SHA
- explicit PASS/FAIL

### `docs/run/AUTONOMOUS_RUN.md`

Maintain an index table of every phase, result, commit and evidence file.

## 11. Evidence discipline

Follow the PRD proof ladder exactly.

Never call any of these equivalent:

- local execution and public-chain execution
- simulated TEE and hardware attestation
- deployed contract and completed lifecycle
- submitted XRPL transaction and validated XRPL transaction
- FDC request and verified FDC proof
- test wallets and real users
- frontend display and independent verification

All public numbers must come from machine-readable evidence or the claim ledger.

## 12. Security rules that cannot be traded away

- No arbitrary signing endpoint.
- Public request API accepts a FAssets request identifier, not arbitrary payment fields.
- Destination, amount, reference/memo, destination tag and deadline are derived from authoritative FAssets state.
- Signet constructs the XRPL Payment itself.
- Signed transaction is durably persisted before first submission.
- XRPL provisional results are not final results.
- Never create a replacement transaction while ledger history is unresolved.
- Replay, mutation, stale request, wrong code identity and duplicate completion must fail closed.
- FDC proof must close the external payment lifecycle.
- Coordinator/frontend/database are never payment authorities.
- Simulated FCC execution must be visibly labelled simulated wherever shown.

## 13. Frontend/application hosting handoff

When Cloudflare deployment is admitted by the active phase:

1. verify current official Cloudflare deployment docs
2. create deployment config in repo
3. deploy only the required application surface
4. record deployment command, project name, URL and deployment identifier in phase evidence
5. run a post-deploy smoke test
6. verify the public proof page from an unauthenticated/read-only browser path
7. do not put secrets in client bundles

If authentication or a paid resource is required, request only the missing credential/funding action and resume afterward.

## 14. End condition

Do NOT execute Phase 14 submission work in this run.
Do NOT execute Phase 15 production-candidate expansion in this run.
Do NOT add optional roadmap features after Phase 13.

After Phase 13 passes:

1. run the full fresh-clone verification path
2. run the final security reviewer and evidence auditor
3. ensure all phase evidence is committed
4. set `docs/run/run-state.json` status to `ready_for_review`
5. generate `docs/run/FINAL_REVIEW_HANDOFF.md`

`FINAL_REVIEW_HANDOFF.md` must contain:

- current product claim in one sentence
- dominant mechanism
- exact proof level reached
- validation decision
- phase 00-13 table with PASS/FAIL and commit SHAs
- live Coston2 contract addresses
- XRPL Testnet transaction links/IDs
- FDC request/proof identifiers
- FCC/FCE deployment and exact attestation status
- Cloudflare URLs and deployment identifiers
- Supabase usage and migration status if used
- fresh-clone verification command and result
- adversarial tests and observed failures
- security findings resolved
- unresolved findings and limitations
- explicit list of simulated components
- explicit list of real target-network components
- source-lock commit hashes
- claim-ledger summary
- design/frontend status
- all ADRs
- submission claims that are safe to make
- claims that must NOT be made
- exact next step: `Start a fresh review chat. Audit this handoff, repository and evidence before Phase 14 submission.`

Then stop.

The next chat will review the entire build adversarially before any submission copy, video claims or final hackathon materials are produced.

## 15. Start now

Start with Phase 00.

Do not ask for plan approval.
Do not ask whether to continue after a passing phase.
Do not skip validation.
Do not build UI early.
Do not produce submission material.

Proceed until:

- Phase 13 passes and `FINAL_REVIEW_HANDOFF.md` exists, or
- one of the explicit hard blockers requires external input, or
- a central claim is falsified and the PRD provides no safe continuation.

# Signet planning pack

Contents:

- `PRD.md`: production product requirements, architecture, state machines, threat model and implementation gates.
- `CLAUDE.md`: concise repository instructions for Claude Code.
- `docs/CLAUDE_CODE_PHASE_PROMPTS.md`: reusable implementation prompt and phase-specific additions.
- `.claude/settings.example.json`: sandbox and permissions template. Review before copying to `.claude/settings.json`.
- `.claude/agents/`: security, protocol-seam, evidence and test subagents.
- `.claude/skills/signet-protocol/SKILL.md`: project protocol skill.
- `docs/source-lock.template.json`: upstream source lock.
- `docs/claim-ledger.template.json`: evidence ledger.

This started as planning material. It is no longer: phases 00 to 13 have run, the contracts are
deployed on Coston2, and the claims are in `evidence/claim-ledger.json` with what each one does not
prove stated beside it.

It still contains no keys or credentials. Deployed addresses are in `deployments/coston2.json` and
are testnet only.

Start with two documents:

- [`docs/evidence/organizer-accepted-proof-boundary.md`](docs/evidence/organizer-accepted-proof-boundary.md)
  — what the Flare team asked for, and exactly which evidence is live Coston2, which is a fork, which
  is live XRPL, and which is simulated.
- [`docs/guarantee.md`](docs/guarantee.md) — what Signet does and does not guarantee, and why the
  narrow version is the true one.

Signet does not operate an FAssets agent and does not claim to. Flare declined to approve new agents,
and the deliverable is the execution layer: a redemption obligation in, an exact XRP payment derived
inside FCC, executed on XRPL Testnet, proven back through FDC on Coston2.

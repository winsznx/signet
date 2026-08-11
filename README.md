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

Start with [`docs/guarantee.md`](docs/guarantee.md), which states narrowly what Signet does and does
not guarantee, and why the narrow version is the true one.

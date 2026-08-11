# Signet Claude Code phase prompts

Use one fresh Claude Code session per phase. Start with:

```bash
claude --permission-mode plan
```

## Standard phase prompt

```text
We are implementing Signet Phase <NN> from PRD.md.

Read:
- PRD.md, especially Phase <NN>
- CLAUDE.md
- docs/source-lock.json
- all completed docs/evidence/phase-*.md
- the existing repository state

First use an exploration subagent to inspect the relevant code and pinned upstream interfaces. Do not edit yet.

Then produce a plan that states:
1. exact files to create or modify
2. interfaces and invariants affected
3. tests to add
4. adversarial cases
5. target-network evidence required
6. commands that must pass
7. what is explicitly out of scope
8. the stop boundary

Challenge any PRD assumption contradicted by pinned current source. Do not invent an interface or address.

After I approve the plan, implement only this phase. Run all phase checks. Invoke the security-reviewer and evidence-auditor subagents. Write docs/evidence/phase-<NN>.md with exact command output, transaction links where relevant, limitations and pass/fail.

Do not continue to the next phase.
```

## Phase-specific additions

### Phase 00

Pin official sources and toolchains, resolve live addresses through official mechanisms, verify bytecode and selectors, establish sandbox and secret exclusions. Do not implement product logic.

### Phase 01

Build the network-free TypeScript reference model and frozen cross-language fixtures. No Solidity or Go policy implementation.

### Phase 02

Prove the current FAssets Coston2 seam. Decode a real or deliberately created redemption and identify exact view, completion and default interfaces from pinned source.

### Phase 03

Run the untouched FCC scaffold first. Then prove the smallest Coston2 ActionResult verification. Do not introduce XRP key material.

### Phase 04

Build the XRPL Testnet Payment seam with RegularKey, persist-before-submit and validated-ledger reconciliation. Reject partial payment and unsafe replacement.

### Phase 05

Obtain and verify a real testXRP FDC proof. Confirm exact proof fields and current verifier from pinned source.

### Phase 06

Build immutable Signet contracts. The public request API accepts only `requestId` and derives payment semantics from FAssets.

### Phase 07

Implement the Go extension policy against frozen fixtures. There must be no arbitrary signing command. Fuzz all fields.

### Phase 08

Build the restart-safe coordinator with Postgres, leases, fencing, reconciliation and proof orchestration. Crash-test every boundary.

### Phase 09

Compose the complete local valid and attack lifecycles. No polished frontend.

### Phase 10

Execute the target-chain lifecycle on Coston2 and XRPL Testnet with real FDC evidence. Label simulated TEE use everywhere if applicable.

### Phase 11

Build the fresh-clone verifier and corrupted-evidence rejection test.

### Phase 12

Build only the operator state view and public proof page. Generate claims from the claim ledger.

### Phase 13

Run threat-model closure, fuzz, race, chaos, supply-chain and recovery tests. Resolve all critical and high findings.

### Phase 14

Prepare submission artifacts from verified evidence. Add no features.

# Signet Production Product Requirements Document

Document status: Product lock, production PRD and implementation plan  
Version: 1.0  
Verification date: August 4, 2026  
Primary networks for the public proof: Flare Testnet Coston2, XRPL Testnet  
Primary bounty: Confidential Compute Apps  
Secondary bounty: Interoperable Asset Products  
Implementation workflow: Claude Code with phased, evidence-gated execution  
Owner: Win SZN  
Product name: Signet

## Acceptance boundary (superseding, 2026-08-11)

Flare declined to approve new FAssets agents and directed Signet to test the execution layer. The
acceptance criteria for this deliverable are the four steps in
[`docs/evidence/organizer-accepted-proof-boundary.md`](docs/evidence/organizer-accepted-proof-boundary.md):

1. taking a valid FAssets redemption obligation
2. deriving the required XRPL payment inside FCC
3. signing and executing that exact payment
4. proving the resulting payment back through FDC

Own-agent settlement is **out of scope**, not pending. Any acceptance criterion below that requires
Signet to hold an FAssets agent's signing authority is superseded by this section and describes
production architecture rather than a deliverable. Claims are governed by
[`docs/submission-claims.md`](docs/submission-claims.md).

## 1. Executive summary

Signet is an attested external execution layer for FAssets agents.

A FAssets redemption creates an authoritative obligation on Flare. The obligation specifies the assigned agent, destination on the underlying chain, amount, payment reference and payment deadline. Signet turns that public obligation into one narrowly authorized XRP Ledger payment. A Flare Confidential Compute extension constructs and signs only the exact XRPL transaction permitted by the active redemption. The host never receives a general-purpose signing interface. After the payment reaches a validated XRPL ledger, Flare Data Connector evidence closes the redemption on Flare.

The judge-compressible mechanism is:

```text
FAssets obligation
  -> FCC-constrained XRP signature
    -> FDC-proven completion
```

The plain-language sentence is:

> Flare says what the agent owes, the enclave signs only that payment, and FDC proves it was paid.

Signet is not a generic key vault. The extension must not expose `sign(message)` or accept caller-supplied destination, amount, memo, deadline or transaction body. Its public operation is equivalent to `signRedemption(requestId)`. All payment fields are derived from the current FAssets obligation and pinned protocol adapters.

The public proof must show both sides of the guarantee:

1. A compromised host requests an arbitrary XRP transfer and receives no signature.
2. A real Coston2 FAssets redemption produces one exact XRPL Testnet payment, one FDC proof and one completed onchain lifecycle.
3. Altered, expired and replayed requests fail.
4. A read-only verifier reconstructs the result without trusting the frontend or the team.

## 2. Source freshness and truth policy

This PRD was written from official Flare, XRPL and Claude Code documentation checked on August 4, 2026.

The implementation must maintain `docs/source-lock.json`. Every external protocol dependency must record:

- official repository or documentation URL;
- pinned repository commit or package lock version;
- verification date;
- relevant interface file and selector;
- network and resolved address;
- deployed runtime bytecode hash where applicable;
- license;
- known limitation;
- owner responsible for re-verification.

No production code may rely on an address copied from this PRD. Addresses must be resolved from the current Flare periphery package or ContractRegistry, then checked by RPC for code, expected selectors and expected behavior.

No implementation claim may exceed its evidence level. The following current facts materially constrain the design:

- The official FCC extension development guide currently demonstrates a local simulated TEE connected to live Coston2. The proxy requires Flare C-chain indexer credentials supplied through Flare support.
- Flare labels FCC as beta in its official GitHub organization.
- The official private-key extension is a demonstration. Flare explicitly warns that encrypted secrets should not be placed onchain for production and recommends an offchain secret-delivery channel.
- FAssets redemption events provide the assigned agent, payment destination, amount, payment reference and deadline.
- An FAssets agent may make the underlying redemption payment from an address it controls. It need not be the minting address.
- XRPL transaction submission is not final when a server first returns a provisional result. A sender must persist the signed transaction, use `LastLedgerSequence`, reconcile against validated ledgers and avoid unsafe replacement.
- XRPL supports an offline master key, a rotatable RegularKey and signer-list based multi-signing.
- FDC supports XRP payment proofs and payment-nonexistence proofs on `testXRP`.

### 2.1 Verified, assumed and gated

| Item | Status on August 4, 2026 | Product treatment |
|---|---|---|
| Coston2 instruction sender and extension registration | Documented | Required for the public proof |
| Local simulated TEE against live Coston2 | Documented | Allowed only as clearly labelled simulation |
| Real GCP Confidential Space deployment for this team | Unverified until access and attestation succeed | Production and top proof-level gate |
| C-chain indexer credentials | Available by request, not public | Day-zero access gate |
| FAssets Coston2 agent registration and live redemption | Unverified for this team | Day-zero access gate |
| XRPL Testnet Payment, RegularKey and multi-sign | Documented | Used in test and production design |
| Durable FCC secret sealing or threshold wallet service | Not established by the public quickstart | Production release gate |
| Public Protocol Managed Wallet interface | Not required for V1 | Roadmap only |
| Exact FAssets completion selector for every redemption mode | Must be read from pinned current periphery interfaces | Protocol-seam gate |
| Core Vault integration | Existing separate system | Explicit non-goal for initial public proof |

## 3. Product lock

### 3.1 Dominant mechanism

```text
Active, unconsumed FAssets redemption
  -> canonical instruction created by a Flare contract
  -> registered Signet extension constructs an exact XRPL Payment
  -> enclave signing authority signs that immutable transaction
  -> coordinator persists and submits it reliably
  -> validated XRPL result is proven through FDC
  -> FAssets redemption completes
```

### 3.2 Falsifiable core claim

Given a fully compromised agent host, Signet signs no XRP transaction unless an active, unconsumed FAssets redemption assigned to that agent requires the exact destination, amount, payment reference, optional destination tag and payment window encoded in the transaction.

Every successful payment must be independently linked to:

- the Coston2 redemption request;
- the approved Signet extension version and code hash;
- the exact signed XRPL transaction hash;
- a validated XRPL ledger result;
- an accepted FDC proof;
- the final FAssets redemption state.

The claim is false if any of the following occurs:

- an arbitrary payment receives a signature;
- destination, destination tag, amount or payment reference differs from the obligation;
- an expired obligation is signed;
- one obligation produces more than one validated successful payment;
- a replacement is signed before the earlier transaction is authoritatively reconciled;
- an unauthorized extension version produces an accepted result;
- a payment is marked complete without the expected FDC proof and final FAssets state;
- the host extracts signing secret material;
- live output differs from the executable reference model;
- a read-only verifier cannot reproduce the claimed linkage.

### 3.3 Headline proof

The completed proof page must show:

```text
COMPROMISED HOST TEST

Unauthorized payment attempts:     3
Signatures produced:                0

VALID FASSETS REDEMPTION

Live obligations received:          1
Exact XRPL payments signed:         1
FDC-confirmed completions:          1
Duplicate payments:                 0
Deadline met:                       YES

REPLAY ATTEMPT:                     REJECTED
ALTERED DESTINATION:                REJECTED
ALTERED AMOUNT:                     REJECTED
```

These numbers must be generated from the machine-readable claim ledger and public evidence. They must not be typed into the frontend as marketing copy.

## 4. Goals

### G1. Prevent arbitrary underlying-chain spending

A host, bot, operator process or compromised dependency must not be able to turn Signet into a general XRP signer.

### G2. Preserve FAssets protocol semantics

The signed payment must be exactly compatible with the pinned FAssets redemption rules, including memo or destination-tag requirements, payment range and proof mode.

### G3. Complete one real composed lifecycle

The minimum complete public transaction is:

```text
real Coston2 redemption
  -> Signet extension decision
  -> real XRPL Testnet payment
  -> real FDC proof
  -> final Coston2 redemption state
```

### G4. Be recoverable

Loss or failure of the active TEE must not permanently lose control of the XRPL account. The XRPL master key remains offline for recovery. Production requires quorum signing or an independently tested key-rotation and recovery process.

### G5. Produce independently verifiable evidence

A judge or operator must be able to verify a completed and refused request without a private key and without trusting the Signet API.

### G6. Create objective operational history

Signet records facts, not subjective safety scores:

- valid obligations observed;
- obligations settled;
- deadline performance;
- refused unauthorized requests;
- refused mutations;
- refused replays;
- recovery events;
- defaults;
- code versions.

## 5. Non-goals

The initial product does not claim to be:

- a private XRP payment system;
- an anonymous redemption system;
- a replacement for FAssets;
- a replacement for the Core Vault;
- a generic wallet or arbitrary message signer;
- a general TEE key-management service;
- a cross-chain atomic transaction in the synchronous sense;
- production-ready solely because the contracts are deployed;
- trustless against the CPU vendor, cloud provider or all traffic analysis;
- a rating agency for FAssets agents;
- an AI agent;
- a token, governance system or marketplace;
- a private orderbook;
- a netting engine;
- a mainnet custody product before the production release gates pass.

Crosscurrent-style private batching and net settlement remain roadmap extensions. They cannot block the first complete Signet lifecycle.

## 6. Users and personas

### 6.1 Primary user: FAssets agent operator

The operator runs an agent and must complete underlying-chain redemption payments before the protocol deadline. They need automation without giving the ordinary host arbitrary spending authority.

First value:

- bind the agent’s underlying XRP account to an approved Signet policy;
- complete one redemption without exposing a signing secret to the host;
- see a signed receipt for denied unauthorized requests.

### 6.2 Secondary user: agent operations engineer

The engineer monitors redemption queues, XRPL submission, FDC proof generation and recovery. They need explicit state, alerts and runbooks.

### 6.3 Secondary user: pool capital provider or protocol integrator

This user does not receive a subjective rating. They inspect objective execution history and decide their own routing, allocation or risk policy.

### 6.4 Secondary user: judge or auditor

The judge needs a two-minute, read-only path that proves:

- what was requested;
- what was denied;
- what was signed;
- what reached XRPL;
- what FDC proved;
- what Coston2 finalized;
- what remains simulated or unproven.

## 7. Scope by release level

### 7.1 Public proof release, V0

Required:

- Coston2 contracts;
- current official FCC scaffold;
- current official Coston2 extension lifecycle;
- test-only XRPL account;
- offline testnet master key and active RegularKey;
- exact redemption policy;
- reliable XRPL submission;
- FDC payment proof;
- replay, mutation and unauthorized-request tests;
- proof page;
- verifier CLI;
- claim ledger;
- honest simulated-versus-attested status.

V0 must never be marketed as production custody when the TEE is simulated.

### 7.2 Production candidate, V1

Required before real-value activation:

- real attested TEE deployment;
- reproducible image and approved code hash;
- no secret delivery through public chain data;
- tested durable key lifecycle;
- two or more independent XRPL RPC providers;
- production secrets manager and operator access controls;
- quorum signing, preferably XRPL 2-of-3 signer list across independently operated attested Signet instances;
- tested disaster recovery;
- external security review;
- load, chaos and failover tests;
- monitored FDC and XRPL finality;
- mainnet configuration review;
- legal and operational review by the deploying agent;
- least-privilege governance through a multisig and delayed changes;
- incident response and key-revocation drill.

### 7.3 Later extensions

After V1:

- Core Vault executor integration;
- Protocol Managed Wallet integration;
- FBTC and FDOGE adapters;
- private batching of multiple lawful obligations;
- objective agent execution history API;
- agent routing based on user-defined reliability policy;
- cross-protocol obligation-gated signing.

## 8. Functional requirements

### 8.1 Agent binding

FR-001: The system shall bind one FAssets agent vault to one FAssets AssetManager, one underlying XRPL account and one approved Signet policy version.

FR-002: The binding shall include network identifiers, extension identifier, approved code hash and expected XRPL public signing configuration.

FR-003: Binding activation shall require proof that the configured XRPL signing authority is active for the underlying account.

FR-004: Production binding changes shall require multisig governance and a delay. Emergency disable may be immediate.

FR-005: The system shall reject an agent binding when the expected AssetManager or FCC registry cannot be verified by code, selector and behavior.

### 8.2 Canonical redemption request

FR-010: The instruction sender shall accept only a `requestId`, never a caller-constructed payment body.

FR-011: The instruction sender shall obtain authoritative redemption fields from the pinned current FAssets interface or events.

FR-012: It shall verify that the request is active, assigned to the bound agent and not already consumed by Signet.

FR-013: It shall include the Flare chain ID, sender address, AssetManager, agent vault, request ID, payment fields, payment window, Signet policy version and extension version in the action commitment.

FR-014: It shall reject unsupported redemption modes rather than silently degrade them.

FR-015: Standard memo-mode and XRP destination-tag mode shall use separate typed protocol adapters and test vectors.

### 8.3 Policy decision

FR-020: The extension shall expose no arbitrary-sign endpoint.

FR-021: The extension shall parse only the canonical Signet instruction schema.

FR-022: The extension shall independently enforce policy over destination, tag, amount, payment reference, source account, fee ceiling, sequence or ticket, ledger window, code version and request generation.

FR-023: A denial shall return a signed typed refusal receipt with a stable reason code.

FR-024: A transient infrastructure failure shall not be recorded as a permanent policy denial.

FR-025: The same canonical input and state shall produce the same decision and transaction template.

### 8.4 XRPL transaction construction

FR-030: The extension shall construct the XRPL `Payment` internally.

FR-031: The transaction shall contain an exact XRP amount in drops and shall not enable partial payment.

FR-032: The transaction shall include the FAssets payment reference in the protocol-required memo encoding.

FR-033: A tagged redemption shall include the exact `DestinationTag`.

FR-034: Every transaction shall include a bounded fee and `LastLedgerSequence`.

FR-035: The transaction shall use either an allocated account sequence or a pre-created XRPL Ticket. Production multi-sign shall fully define all fields before signatures are collected.

FR-036: The source account shall be the account bound to the agent.

FR-037: The signed transaction blob and hash shall be returned without returning secret material.

### 8.5 Durable submission and reconciliation

FR-040: The coordinator shall persist the signed transaction, transaction hash, source account, sequence or ticket, `LastLedgerSequence`, request generation and latest validated ledger before first submission.

FR-041: Submission shall be idempotent by transaction hash.

FR-042: A provisional `submit` response shall not be treated as final.

FR-043: The coordinator shall reconcile against validated ledgers until success, authoritative failure, authoritative expiry or an unresolved ledger-history gap.

FR-044: An unresolved history gap shall stop automatic replacement.

FR-045: A replacement may be authorized only after the prior transaction is proven not to have succeeded and the FAssets obligation remains payable.

FR-046: The coordinator shall detect sequence collision, ticket consumption, account configuration change and unexpected outgoing balance decrease.

### 8.6 FDC proof and completion

FR-050: The coordinator shall request the correct FDC proof type for the redemption mode.

FR-051: The proof shall bind the expected source, destination, amount, payment reference or memo, optional destination tag and proof owner where applicable.

FR-052: The current pinned AssetManager completion interface shall be invoked only after the proof has been locally decoded and matched to the obligation.

FR-053: Signet shall observe the final FAssets state rather than assuming that proof submission equals completion.

FR-054: A read-only evidence record shall link the action ID, XRPL transaction, FDC request and proof, Coston2 completion transaction and final state.

### 8.7 Refusal and attack evidence

FR-060: Unauthorized, mutated, expired, duplicate, wrong-agent, wrong-network, wrong-code and fee-cap violations shall be covered by stable reason codes.

FR-061: Refusal receipts shall include no signing secret or sensitive internal state.

FR-062: The proof page shall show at least one real unauthorized request and one valid request from the same registered Signet deployment.

FR-063: The frontend shall distinguish policy denial, transient error, unavailable infrastructure and unverified result.

### 8.8 Key lifecycle

FR-070: The XRPL master key shall remain offline and outside all application, TEE, CI and Claude Code environments.

FR-071: V0 shall use a test-only rotatable RegularKey.

FR-072: Production shall prefer XRPL signer-list quorum across independent Signet instances. A single-RegularKey production mode requires a documented exception and external review.

FR-073: Key generation, provisioning, activation, rotation, retirement and emergency revocation shall be explicit state transitions.

FR-074: No key or seed may appear in contract calldata, events, Postgres, Redis, logs, traces, screenshots, crash dumps, CI artifacts or Claude Code context.

FR-075: The system shall continuously verify that the expected XRPL account signing configuration has not changed.

## 9. Non-functional requirements

### 9.1 Security

NFR-001: Default deny. Any malformed, unknown or stale state must not produce a signature.

NFR-002: The signing boundary shall be smaller than the coordinator, frontend and operator stack.

NFR-003: Contracts shall be immutable for the public proof. Production upgrades, if later required, must use versioned deployments rather than opaque proxy upgrades unless separately justified and audited.

NFR-004: All network and protocol dependencies shall be pinned and checked.

NFR-005: Build artifacts shall include SBOM, dependency lockfiles, container digest and provenance.

### 9.2 Reliability

NFR-010: Reprocessing an event or job shall not duplicate a signature, submission or proof.

NFR-011: Coordinator workers shall use leases and fencing tokens so only one active worker controls a request generation.

NFR-012: Every external call shall have bounded timeout, retry class and idempotency behavior.

NFR-013: Restarting any non-TEE component shall not lose the transaction state required for reconciliation.

### 9.3 Performance targets

These are product targets, not statements about current network guarantees.

- Instruction observed to policy decision, p95: less than 30 seconds or less than 10 percent of the current onchain payment window, whichever is stricter.
- Signed transaction persisted to first XRPL submission, p95: less than 10 seconds.
- Reconciliation interval: every validated XRPL ledger or no slower than 10 seconds.
- Proof request creation after validated payment: less than 30 seconds.
- Read-only proof page availability target: 99.9 percent after production launch.
- Maximum automatic signing safety margin: configurable from live FAssets settings and never less than the measured worst-case end-to-end latency plus a fixed operational buffer.

### 9.4 Privacy

NFR-020: The product privacy claim is limited to signing-secret confidentiality and host inability to authorize arbitrary payments.

NFR-021: Final FAssets and XRPL activity is public.

NFR-022: Timing, traffic volume and public transaction metadata are not hidden.

NFR-023: Telemetry shall never contain raw secret material or private provisioning payloads.

### 9.5 Auditability

NFR-030: Every public claim shall be traceable to a claim-ledger entry.

NFR-031: All decisions shall include a policy version and code version.

NFR-032: The verifier shall work from a fresh clone with public RPC access and no team-owned credentials.

## 10. System architecture

```text
                            Flare Coston2
+----------------+     +-------------------------+
| FAssets        |     | SignetInstructionSender |
| AssetManager   |<----| reads canonical request |
+-------+--------+     +------------+------------+
        |                           |
        | RedemptionRequested       | sendInstructions
        v                           v
+----------------+       +------------------------+
| Coordinator    |       | FCC registry + relay   |
| observer       |       +-----------+------------+
+-------+--------+                   |
        |                            v
        |                   +----------------------+
        |                   | Signet FCC extension |
        |                   | policy + XRPL builder|
        |                   | signing boundary     |
        |                   +----------+-----------+
        |                              |
        |                       signed tx / refusal
        v                              v
+-------------------------------------------------+
| Durable coordinator                              |
| Postgres state, queue, reconciliation, evidence |
+----------------------+--------------------------+
                       |
                       | submit and reconcile
                       v
                +-------------+
                | XRPL        |
                | Testnet/live|
                +------+------+ 
                       |
                       | validated payment
                       v
                +-------------+
                | FDC request |
                | and proof   |
                +------+------+ 
                       |
                       v
+----------------------+--------------------------+
| AssetManager completion + Signet evidence       |
+----------------------+--------------------------+
                       |
                       v
              +------------------+
              | Verifier + web   |
              | read-only proof  |
              +------------------+
```

### 10.1 Repository layout

```text
signet/
├── CLAUDE.md
├── PRD.md
├── Makefile
├── pnpm-workspace.yaml
├── go.work
├── foundry.toml
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   ├── public-private-boundary.md
│   ├── protocol-seams.md
│   ├── source-lock.json
│   ├── claim-ledger.schema.json
│   ├── runbooks/
│   ├── adr/
│   └── evidence/
├── reference/
│   ├── src/
│   ├── test-vectors/
│   └── README.md
├── contracts/
│   ├── src/
│   │   ├── SignetInstructionSender.sol
│   │   ├── SignetRegistry.sol
│   │   ├── SignetActionVerifier.sol
│   │   ├── interfaces/
│   │   └── adapters/
│   ├── test/
│   │   ├── unit/
│   │   ├── invariant/
│   │   ├── fork/
│   │   └── e2e/
│   └── script/
├── extension/
│   ├── cmd/signet/
│   ├── internal/
│   │   ├── action/
│   │   ├── policy/
│   │   ├── xrpl/
│   │   ├── keyring/
│   │   ├── state/
│   │   └── receipt/
│   ├── testdata/
│   └── Dockerfile
├── coordinator/
│   ├── src/
│   │   ├── observers/
│   │   ├── jobs/
│   │   ├── xrpl/
│   │   ├── fdc/
│   │   ├── evidence/
│   │   └── api/
│   ├── migrations/
│   └── test/
├── verifier/
│   ├── src/
│   └── fixtures/
├── web/
│   ├── app/
│   ├── components/
│   └── e2e/
├── infra/
│   ├── compose/
│   ├── gcp/
│   └── monitoring/
├── deployments/
│   ├── coston2.json
│   └── README.md
├── evidence/
│   ├── claim-ledger.json
│   ├── receipts/
│   └── completed/
└── .claude/
    ├── settings.json
    ├── agents/
    └── skills/
```

### 10.2 Component responsibilities

#### `SignetInstructionSender`

Owns:

- agent binding lookup;
- canonical request retrieval;
- precondition checks;
- action ID creation;
- FCC instruction submission;
- action state and replay guard.

Does not own:

- XRPL secret material;
- arbitrary payment fields;
- XRPL submission;
- FDC proof generation.

#### `SignetRegistry`

Owns:

- agent and policy binding;
- action lifecycle;
- accepted result and refusal receipt hashes;
- version and code-hash history;
- objective execution history;
- pause status.

It is an evidence and authorization registry, not the authoritative FAssets ledger.

#### Signet FCC extension

Owns:

- strict input parsing;
- policy evaluation;
- exact XRPL transaction construction;
- signing within the protected boundary;
- typed refusal receipts;
- state necessary to prevent duplicate signing within one request generation.

Does not own:

- FAssets contract state;
- public proof storage;
- frontend state;
- XRPL finality;
- subjective agent rating.

#### Coordinator

Owns:

- Coston2 and XRPL observation;
- durable job state;
- action-result retrieval;
- transaction persistence before submission;
- reliable XRPL submission and reconciliation;
- FDC request and proof orchestration;
- final-state observation;
- evidence generation.

The coordinator is untrusted for payment authority. Compromise may delay or censor, but must not create a valid arbitrary payment.

#### Verifier

Owns:

- read-only reconstruction;
- source and deployment checks;
- result-domain verification;
- XRPL validated-result checks;
- FDC proof linkage;
- FAssets final-state check;
- claim-ledger validation.

## 11. Protocol responsibility matrix

| Guarantee | Authoritative component |
|---|---|
| A redemption exists and is assigned to an agent | FAssets AssetManager |
| Payment destination, amount, reference and window | FAssets request |
| Instruction is canonical | SignetInstructionSender |
| Extension and code version are allowed | FCC registries plus Signet binding |
| Arbitrary payment cannot be signed | Signet extension policy and key boundary |
| Transaction fields are immutable after signing | XRPL signature |
| Transaction is final | Validated XRPL ledger |
| Payment matches expected XRPL fields | FDC proof |
| Redemption completes | FAssets AssetManager final state |
| Evidence is inspectable | Signet registry, evidence bundle and verifier |
| Host cannot read signing secret | Real TEE boundary, only after attested deployment |
| Recovery authority exists | Offline XRPL master key and production signer configuration |

## 12. Cryptographic and key architecture

### 12.1 V0 public proof

- Create a dedicated XRPL Testnet account.
- Keep its master seed offline and outside the repository.
- Configure one rotatable RegularKey whose private key exists only in the test Signet protected process.
- Do not disable the master key.
- Record the RegularKey public key and activation transaction.
- Treat all value as test-only.
- Label simulated TEE use in the proof page and claim ledger.

### 12.2 V1 production target

Preferred design:

- One XRPL operational account.
- Offline master key retained under organizational recovery controls.
- XRPL signer list with three signer accounts, weight 1 each, quorum 2.
- Each signer account’s active key is held by a distinct attested Signet deployment with separate administrative and cloud failure domains.
- The coordinator creates one fully specified transaction and requests signatures from all eligible Signet instances.
- Each instance independently derives the same authorization commitment from the same FAssets obligation.
- The coordinator accepts the first valid quorum and sorts the XRPL `Signers` array as required.
- No single TEE, operator or coordinator can move funds.

This production target is gated by a real multi-TEE seam test. It is not part of the minimum hackathon claim.

Fallback production design:

- One active RegularKey in an attested TEE.
- Offline master key with tested rotation.
- Warm standby using a separately provisioned RegularKey activated only during controlled failover.
- Lower balance limits and stronger operational monitoring.
- External security sign-off required.

### 12.3 Key lifecycle states

```text
UNINITIALIZED
  -> GENERATED
  -> PUBLIC_KEY_VERIFIED
  -> ACTIVATION_PENDING
  -> ACTIVE
  -> ROTATION_PENDING
  -> RETIRED

ACTIVE -> EMERGENCY_REVOKED
ACTIVE -> RECOVERY_REQUIRED
RECOVERY_REQUIRED -> ROTATION_PENDING
```

Rules:

- Only public-key material may cross the ordinary application boundary.
- Activation requires a validated XRPL configuration transaction.
- Rotation is not complete until the new configuration is validated and independently read back.
- A retired key must never be accepted by a Signet policy version.
- Secret deletion must be verified where the TEE platform supports it. Where deletion cannot be proven, the XRPL account configuration must render the old key powerless.

## 13. Domain separation and authorization commitment

The extension decision must bind every field that can change the meaning of the payment.

Conceptual commitment:

```text
SIGNET_FASSETS_REDEMPTION_V1(
  flareChainId,
  instructionSender,
  assetManager,
  agentVault,
  requestId,
  requestGeneration,
  xrplNetworkId,
  xrplSourceAccount,
  destination,
  destinationTagMode,
  destinationTag,
  amountDrops,
  paymentReference,
  firstUnderlyingBlock,
  lastUnderlyingBlock,
  lastUnderlyingTimestamp,
  xrplSequenceOrTicket,
  lastLedgerSequence,
  maxFeeDrops,
  policyVersion,
  extensionId,
  extensionCodeHash
)
```

The actual binary encoding must be specified once, tested across Solidity, Go and TypeScript and frozen in an ADR.

Requirements:

- no ambiguous packed encoding;
- explicit field lengths;
- explicit endianness;
- canonical address representation;
- canonical empty-tag representation;
- version prefix;
- chain and contract domain;
- test vectors shared across all languages;
- mutation tests for every field.

## 14. Core data model

### 14.1 `agent_bindings`

- `id`
- `flare_chain_id`
- `asset_manager`
- `agent_vault`
- `xrpl_network`
- `xrpl_account`
- `signing_mode`
- `extension_id`
- `approved_code_hash`
- `policy_version`
- `status`
- `activated_at`
- `retired_at`

### 14.2 `redemption_actions`

- `action_id`
- `request_id`
- `request_generation`
- `agent_binding_id`
- `obligation_hash`
- `state`
- `reason_code`
- `first_underlying_block`
- `last_underlying_block`
- `last_underlying_timestamp`
- `safety_deadline`
- `created_block`
- `created_tx_hash`
- `version`

Unique constraint:

```text
(flare_chain_id, asset_manager, request_id, request_generation)
```

### 14.3 `signed_transactions`

- `action_id`
- `authorization_commitment`
- `tx_hash`
- `signed_blob_encrypted_at_rest`
- `source_account`
- `sequence`
- `ticket_sequence`
- `last_ledger_sequence`
- `fee_drops`
- `signer_set_hash`
- `persisted_at`
- `submitted_at`
- `validated_ledger`
- `engine_result`
- `final_status`

The signed blob is not a secret, but it is sensitive operational material and must be access-controlled until submission.

### 14.4 `fdc_evidence`

- `action_id`
- `attestation_type`
- `source_id`
- `request_bytes_hash`
- `proof_owner`
- `voting_round`
- `proof_hash`
- `proof_status`
- `submission_tx_hash`
- `asset_manager_completion_tx`
- `final_fassets_state`

### 14.5 `decision_receipts`

- `action_id`
- `decision`
- `reason_code`
- `policy_version`
- `code_hash`
- `result_hash`
- `tee_signature`
- `recorded_tx_hash`
- `created_at`

### 14.6 `leases`

Every mutable job has:

- `resource_id`
- `lease_owner`
- `fencing_token`
- `expires_at`

Any write from an old fencing token is rejected.

## 15. State machines

### 15.1 Redemption action

```text
DISCOVERED
  -> ELIGIBILITY_CHECKED
  -> INSTRUCTION_SENT
  -> DECISION_PENDING
  -> AUTHORIZED
  -> SIGNED_PERSISTED
  -> SUBMITTED
  -> XRPL_VALIDATED
  -> FDC_REQUESTED
  -> FDC_PROVEN
  -> FASSETS_COMPLETED
  -> EVIDENCE_FINALIZED
```

Branches:

```text
ELIGIBILITY_CHECKED -> POLICY_REFUSED
DECISION_PENDING -> TRANSIENT_FAILURE
AUTHORIZED -> SIGNING_FAILED
SUBMITTED -> VALIDATED_FAILURE
SUBMITTED -> EXPIRED_NOT_FOUND
SUBMITTED -> UNKNOWN_LEDGER_GAP
EXPIRED_NOT_FOUND -> NONPAYMENT_PROOF_PENDING
NONPAYMENT_PROOF_PENDING -> REISSUE_AUTHORIZED
REISSUE_AUTHORIZED -> INSTRUCTION_SENT with generation + 1
ANY_NONFINAL -> PAUSED
PAYMENT_WINDOW_EXPIRED -> DEFAULT_OBSERVED
```

Terminal states:

- `EVIDENCE_FINALIZED`
- `POLICY_REFUSED`
- `DEFAULT_OBSERVED`
- `CANCELLED`
- `MANUAL_INTERVENTION`

### 15.2 XRPL reliable submission

```text
BUILT
  -> SIGNED
  -> DURABLY_PERSISTED
  -> SUBMITTED_PROVISIONAL
  -> VALIDATED_SUCCESS
     | VALIDATED_FAILURE
     | EXPIRED_NOT_FOUND
     | UNKNOWN_LEDGER_GAP
```

Rules:

- Never transition from `SUBMITTED_PROVISIONAL` to success from a provisional server response.
- Never replace from `UNKNOWN_LEDGER_GAP`.
- `EXPIRED_NOT_FOUND` requires checking all validated ledgers through `LastLedgerSequence`.
- A sequence or ticket used by an unexpected transaction is a critical incident.
- Re-submitting the identical signed blob is allowed.
- Building a different transaction is a new request generation.

### 15.3 Extension version

```text
DRAFT
  -> REPRODUCIBLY_BUILT
  -> CODE_HASH_ALLOWED
  -> MACHINE_REGISTERED
  -> ACTIVE
  -> DRAINING
  -> REVOKED
```

A draining version may finish previously authorized actions but may not accept new actions unless governance explicitly permits it.

## 16. Invariants

I-001: No signed transaction exists without a canonical active FAssets obligation.

I-002: Signed destination equals the obligation destination.

I-003: Signed destination tag equals the tagged obligation when tag mode applies.

I-004: Signed amount equals the required payment amount in drops.

I-005: Signed memo contains the exact protocol payment reference.

I-006: Signed source account equals the bound XRPL account.

I-007: Signed fee is less than or equal to the configured fee cap and compatible with the current signing mode.

I-008: `LastLedgerSequence` is within the FAssets payment window and leaves the configured safety margin.

I-009: At most one validated successful payment exists per FAssets request.

I-010: A replacement can be signed only after the earlier generation is proven not successful.

I-011: An action from another Flare chain, sender, AssetManager, agent, extension or code version is rejected.

I-012: A paused agent cannot receive a new authorization.

I-013: Verification and reconciliation continue while signing is paused.

I-014: No secret material reaches ordinary storage or observability systems.

I-015: Objective history is derived from final evidence and cannot be incremented from frontend events.

I-016: The reference model and production policy produce identical authorization commitments for all shared fixtures.

I-017: Registry state cannot mark a request completed unless the expected FAssets final state is observed.

I-018: A TEE result with a valid cryptographic signature but wrong action domain is rejected.

I-019: Every public metric can be regenerated from the claim ledger.

I-020: An unsupported protocol version fails closed.

## 17. End-to-end workflows

### 17.1 Bootstrap

1. Pin official FCC scaffold, Flare periphery, FAssets interfaces, FDC interfaces and XRPL client dependencies.
2. Generate `docs/source-lock.json`.
3. Resolve current Coston2 addresses from official registries or periphery.
4. Verify code and selectors by RPC.
5. Deploy Signet contracts.
6. Register the Signet extension and allowed code version.
7. Register the TEE machine or clearly labelled simulated machine.
8. Store deployment outputs with transaction hashes and runtime bytecode hashes.
9. Run the official scaffold lifecycle before any Signet behavior is added.

### 17.2 Agent onboarding

1. Operator selects an existing Coston2 test agent or creates one through the current supported process.
2. Operator creates a dedicated XRPL Testnet underlying payment account.
3. Master key is stored offline.
4. Signet signing authority is generated in the protected environment.
5. Operator activates the RegularKey or signer-list configuration on XRPL Testnet.
6. Signet verifies the validated account configuration.
7. Governance binds the agent vault to the XRPL account and Signet extension.
8. A dry-run request constructs but does not submit a zero-value or invalid transaction. No payment signature is produced.
9. Binding becomes active only after all checks pass.

### 17.3 Valid redemption

1. Redeemer creates an actual Coston2 redemption.
2. Coordinator observes `RedemptionRequested`.
3. Coordinator waits for a safe finalized Coston2 view.
4. Anyone calls `requestRedemptionSignature(requestId)`, or the coordinator does so.
5. The instruction sender reads canonical request data and submits the FCC action.
6. The extension validates the complete policy.
7. It allocates an XRPL sequence or Ticket under a single-writer lease.
8. It constructs and signs the transaction.
9. Coordinator verifies the returned result and authorization commitment.
10. Coordinator persists the signed blob before submission.
11. Coordinator submits to at least one XRPL server and reconciles through an independent server.
12. After a validated successful result, coordinator builds the proper FDC request.
13. Coordinator retrieves and verifies the proof.
14. Coordinator invokes the pinned FAssets completion interface.
15. Coordinator observes the final FAssets state.
16. Evidence builder creates a receipt bundle.
17. Claim ledger is updated from evidence.

### 17.4 Unauthorized request

1. Attacker or compromised host calls an operator-facing API with an arbitrary destination and amount.
2. The ordinary API has no route that maps such input to a signing operation.
3. The adversarial harness attempts direct extension input with malformed or caller-supplied fields.
4. The extension rejects the schema or detects mismatch.
5. A typed refusal receipt is produced.
6. No XRPL signed blob exists.
7. The proof page links the refusal result and relevant code version.

### 17.5 Expiry and replacement

1. Signed transaction remains unvalidated near `LastLedgerSequence`.
2. Coordinator resubmits the identical blob to healthy XRPL peers.
3. After the ledger passes `LastLedgerSequence`, coordinator searches validated history from the last known validated ledger through expiry.
4. If history is incomplete, transition to `UNKNOWN_LEDGER_GAP` and page an operator.
5. If transaction is absent and the obligation remains payable, obtain the relevant nonexistence evidence where the protocol flow requires it.
6. Create request generation `n + 1`.
7. Allocate a new sequence or Ticket and new `LastLedgerSequence`.
8. Sign a replacement with a commitment that includes the new generation.
9. Never reuse a prior generation’s sequence assumption.

### 17.6 Pause

Emergency pause stops:

- new agent bindings;
- new signing instructions;
- replacement generation.

It does not stop:

- XRPL reconciliation;
- FDC proof completion for already validated payments;
- evidence generation;
- read-only verification;
- key revocation.

## 18. Public and private boundary

| Field or event | Private forever | Private until completion | Public at submission | Public at settlement |
|---|---:|---:|---:|---:|
| Offline XRPL master secret | Yes |  |  |  |
| TEE signer secret or signer shares | Yes |  |  |  |
| Secret provisioning payload | Yes |  |  |  |
| Signed transaction blob before broadcast |  | Yes |  |  |
| FAssets redemption fields |  |  | Yes, already public | Yes |
| Signet action commitment |  |  | Yes | Yes |
| Extension ID and code hash |  |  | Yes | Yes |
| Refusal reason code |  |  | Optional public receipt | Yes in demo evidence |
| XRPL transaction |  |  |  | Yes |
| Destination, amount, memo and tag |  |  |  | Yes on XRPL |
| FDC request and proof |  |  |  | Yes |
| Objective execution history |  |  |  | Yes |
| Traffic timing and volume | No protection claimed |  |  |  |

Required privacy tests inspect:

- contract calldata and events;
- FCC proxy and extension logs;
- Postgres rows;
- Redis keys;
- error responses;
- tracing attributes;
- browser storage;
- screenshots;
- CI artifacts;
- crash dumps;
- generated evidence;
- Docker image layers;
- Git history.

## 19. Contract interfaces

The exact upstream FAssets and FCC interfaces must come from pinned official source. The following are Signet-owned conceptual interfaces.

### 19.1 `SignetInstructionSender`

```solidity
interface ISignetInstructionSender {
    function requestRedemptionSignature(
        uint256 requestId
    ) external returns (bytes32 actionId);

    function getAction(
        bytes32 actionId
    ) external view returns (SignetAction memory);

    function pauseAgent(address agentVault) external;
    function unpauseAgent(address agentVault) external;
}
```

### 19.2 `SignetRegistry`

```solidity
interface ISignetRegistry {
    function bindAgent(AgentBinding calldata binding) external;
    function retireBinding(bytes32 bindingId) external;

    function recordDecision(
        ActionResult calldata result,
        bytes calldata teeSignature
    ) external;

    function recordFinalEvidence(
        bytes32 actionId,
        FinalEvidence calldata evidence
    ) external;

    function bindingFor(
        address assetManager,
        address agentVault
    ) external view returns (AgentBinding memory);
}
```

### 19.3 Access control

- Public callers may request signing for an eligible active obligation. This avoids trusting a privileged host to trigger lawful payment.
- Only valid registered TEE results may record decisions.
- Only evidence satisfying deterministic checks may record final evidence.
- Governance may bind, pause and retire.
- No governance function can create an arbitrary XRP signature.

### 19.4 Events

- `AgentBound`
- `AgentPaused`
- `ActionRequested`
- `DecisionRecorded`
- `RefusalRecorded`
- `EvidenceFinalized`
- `BindingRetired`
- `PolicyVersionActivated`

Events must use indexed fields for request ID, action ID and agent vault without duplicating sensitive payloads.

## 20. Extension protocol

### 20.1 Operation types

Use distinct `bytes32` operation type and command constants across Solidity, Go configuration and router code.

Commands:

- `AUTHORIZE_REDEMPTION`
- `HEALTH_CHECK`
- `PUBLIC_KEY`
- `ROTATION_PREPARE`
- `ROTATION_CONFIRM`

There is no `SIGN_ARBITRARY` command.

### 20.2 Input

Use a versioned deterministic encoding. JSON may be used at the outer scaffold boundary, but the signed authorization payload must use a canonical binary schema.

Input includes:

- action ID;
- canonical obligation;
- binding ID;
- policy version;
- requested sequence or Ticket;
- current validated XRPL ledger;
- maximum fee;
- safety deadline.

### 20.3 Output

Authorized output:

- status;
- action ID;
- authorization commitment;
- XRPL transaction hash;
- signed transaction blob or per-signer signature;
- signer public key or signer account;
- sequence or Ticket;
- `LastLedgerSequence`;
- fee;
- policy and code version.

Refused output:

- status;
- action ID;
- obligation hash;
- stable reason code;
- policy and code version;
- no transaction signature.

### 20.4 Stable reason codes

- `S001_UNKNOWN_SCHEMA`
- `S002_WRONG_DOMAIN`
- `S003_UNBOUND_AGENT`
- `S004_INACTIVE_REDEMPTION`
- `S005_WRONG_AGENT`
- `S006_ALREADY_CONSUMED`
- `S007_EXPIRED_WINDOW`
- `S008_INSUFFICIENT_SAFETY_MARGIN`
- `S009_DESTINATION_INVALID`
- `S010_AMOUNT_INVALID`
- `S011_REFERENCE_INVALID`
- `S012_TAG_INVALID`
- `S013_FEE_CAP_EXCEEDED`
- `S014_SEQUENCE_CONFLICT`
- `S015_CODE_VERSION_REVOKED`
- `S016_PAUSED`
- `S017_STATE_UNAVAILABLE`
- `S018_REPLACEMENT_NOT_AUTHORIZED`
- `S019_KEY_NOT_ACTIVE`
- `S020_INTERNAL_FAIL_CLOSED`

## 21. Reference model

The reference model is a small TypeScript package with no network, wallet or database dependency.

Input:

```ts
type ReferenceInput = {
  domain: SignetDomain;
  binding: AgentBindingSnapshot;
  redemption: RedemptionSnapshot;
  xrpl: XrplAllocationSnapshot;
  policy: PolicySnapshot;
  prior: PriorGenerationSnapshot[];
};
```

Output:

```ts
type ReferenceDecision =
  | { kind: "authorize"; commitment: Hex; txTemplate: CanonicalXrplPayment }
  | { kind: "refuse"; commitment: Hex; reason: ReasonCode };
```

It must cover:

- standard memo redemption;
- destination-tag redemption;
- zero and maximum values;
- malformed XRP address;
- invalid tag;
- expired and near-expiry requests;
- wrong agent;
- wrong AssetManager;
- wrong network;
- duplicate request;
- duplicate generation;
- replacement without reconciliation;
- fee spike;
- sequence collision;
- Ticket collision;
- paused binding;
- revoked code version;
- rounding and UBA-to-drops conversion;
- payment-reference encoding;
- changed field in an otherwise valid action;
- restart with prior signed transaction;
- FDC delay;
- ledger-history gap.

The reference model is the specification until real protocol execution disproves it. Go and Solidity tests must consume shared fixtures generated by the reference model. They must not copy expected values by reimplementing the same logic.

## 22. Threat model

### 22.1 Protected assets

- XRP backing funds;
- signing authority;
- exact FAssets payment semantics;
- request uniqueness;
- agent availability;
- objective history integrity;
- evidence and public claims.

### 22.2 Adversaries

- compromised agent host with root access;
- malicious coordinator operator;
- malicious frontend;
- malicious caller;
- malicious or stale RPC server;
- compromised dependency or container;
- stale or revoked extension;
- malicious redeemer supplying a blocking address;
- network censor;
- attacker with access to logs or CI;
- prompt-injection content encountered by Claude Code;
- TEE or cloud operator within the trusted-computing-base boundary.

### 22.3 Required mitigations

| Threat | Mitigation |
|---|---|
| Arbitrary payment request | No arbitrary signing API, canonical request ID only |
| Field mutation | Domain commitment over every semantic field |
| Replay | Onchain action state, generation, XRPL sequence or Ticket, FAssets reference |
| Double submission | Persist-before-submit, idempotent tx hash, reliable reconciliation |
| Unsafe replacement | Replace only after authoritative absence or failure |
| Stale code | Code-hash allowlist, policy version, draining and revoke states |
| Malicious coordinator | Coordinator cannot obtain arbitrary signature |
| Malicious RPC | Two independent endpoints, finalized-state checks, mismatch halt |
| XRPL sequence race | Single-writer lease and fencing token, optional Tickets |
| TEE loss | Offline master recovery, production quorum signer list |
| Secret leakage | Offchain provisioning, no logs, sandboxed development, secret scans |
| Supply-chain compromise | Pinned commits, lockfiles, SBOM, signed images, reproducible build |
| FDC delay | Explicit pending state, deadline buffer, no false completion |
| Address blocking | Use current FAssets address-validity and payment rules, fail closed |
| Denial of service | Public lawful trigger, redundant observers, backpressure, rate limits |
| Governance compromise | Multisig, delay for non-emergency changes, immutable core |
| Prompt injection | Claude Code sandbox, restricted network, deny secret reads, source review |

### 22.4 Trusted computing base

Production claims must name:

- CPU TEE implementation;
- cloud Confidential Space environment;
- FCC node and proxy software;
- approved extension image;
- Flare FCC registries and governance;
- FAssets AssetManager;
- FDC provider system;
- XRPL consensus and selected RPC infrastructure;
- Signet governance;
- offline recovery process.

The host operating system and coordinator are outside the payment-authorization trust boundary.

## 23. Error handling and recovery

### 23.1 Error classes

- `POLICY_DENIAL`: deterministic and final for this request generation.
- `TRANSIENT_INFRA`: retry without changing semantic transaction.
- `XRPL_PROVISIONAL`: continue reconciliation.
- `XRPL_FINAL_FAILURE`: inspect engine result and protocol state.
- `XRPL_UNKNOWN`: stop replacement and require operator review.
- `FDC_PENDING`: wait and retry proof retrieval.
- `FDC_REJECTED`: compare request construction against pinned type and evidence.
- `FASSETS_FINALIZATION_FAILED`: inspect pinned interface, request status and proof.
- `KEY_INCIDENT`: pause signing and activate recovery runbook.
- `PROTOCOL_DRIFT`: halt unsupported version.

### 23.2 Recovery principles

- Never retry by creating a different payment silently.
- Never skip a failed state.
- Never mark a request complete from local state alone.
- Preserve all signed transactions and reconciliation observations.
- Pausing must be reversible, but key compromise requires rotation.
- Operator overrides must produce signed audit records and cannot bypass policy.

## 24. Observability

### 24.1 Metrics

- `signet_actions_total{state,reason}`
- `signet_policy_decisions_total{decision,reason}`
- `signet_instruction_latency_seconds`
- `signet_signing_latency_seconds`
- `signet_xrpl_submission_latency_seconds`
- `signet_xrpl_reconciliation_age_seconds`
- `signet_fdc_proof_latency_seconds`
- `signet_fassets_completion_latency_seconds`
- `signet_deadline_margin_seconds`
- `signet_rpc_disagreement_total`
- `signet_replacement_total`
- `signet_key_state`
- `signet_extension_version_active`
- `signet_evidence_finalized_total`

### 24.2 Tracing

One trace spans:

```text
redemption observed
  -> instruction transaction
  -> FCC action
  -> policy decision
  -> transaction persistence
  -> XRPL submission
  -> XRPL validation
  -> FDC request
  -> proof
  -> FAssets completion
  -> evidence finalization
```

Trace attributes may include hashes and public identifiers. They must not include secrets, seeds, private provisioning payloads or raw environment variables.

### 24.3 Alerts

Critical:

- unauthorized signature produced;
- expected signing configuration changed;
- sequence or Ticket consumed unexpectedly;
- duplicate validated payment;
- RPC disagreement during replacement decision;
- key material detected by secret scanner;
- request enters unsafe deadline margin;
- extension code hash differs;
- FAssets and Signet final states disagree.

High:

- FDC proof delayed beyond budget;
- XRPL reconciliation age above threshold;
- indexer or proxy unavailable;
- standby signer unavailable;
- evidence finalization failed.

## 25. Security engineering

### 25.1 Smart contracts

- Foundry tests, fuzzing and invariant testing.
- Slither and manual access-control review.
- No `delegatecall`.
- No arbitrary external call.
- Checks-effects-interactions.
- Bounded storage growth where practical.
- Typed custom errors.
- Explicit pause semantics.
- Immutable external dependencies for each deployment.
- Versioned replacement rather than unreviewed proxy upgrade.
- Governance cannot bypass the signing policy.

### 25.2 Go extension

- Strict JSON or binary decoding with unknown-field rejection.
- No shell execution.
- No dynamic code loading.
- Memory zeroization where supported.
- Constant-time cryptographic library operations from maintained dependencies.
- Go race detector.
- Fuzz parsers and transaction builders.
- Structured logs with redaction.
- Read-only root filesystem and non-root container user.
- Network egress allowlist.
- Minimal image.

### 25.3 TypeScript services

- Runtime schema validation.
- Prepared database queries.
- Durable transactions around state transitions.
- Worker leases and fencing.
- No direct access to signing secret.
- Separate public API and privileged operational API.
- CSRF and origin controls for browser mutations.
- Rate limiting.
- Read-only verifier separated from coordinator.

### 25.4 Supply chain

- Pin upstream repositories by commit.
- Pin package managers with lockfiles.
- Verify checksums.
- Generate SBOM.
- Scan containers and dependencies.
- Sign release images and manifests.
- Rebuild with a fixed `SOURCE_DATE_EPOCH` where the FCC toolchain supports it.
- Compare produced code hash in CI.
- Record compiler, Go, Node and package-manager versions in `toolchain.lock`.
- Do not auto-merge dependency updates into signing code.

## 26. Testing strategy

### 26.1 Unit tests

- reference model;
- canonical encoding;
- payment-reference adapter;
- XRPL transaction builder;
- reason codes;
- state transitions;
- database leases;
- evidence builder;
- verifier.

### 26.2 Property and fuzz tests

- every field mutation changes commitment;
- unauthorized input never authorizes;
- authorized input preserves exact fields;
- state cannot move backward except explicit recovery transitions;
- no two generations can both become successful;
- parsers never panic;
- all uint bounds and UBA conversion cases;
- random restarts preserve reconciliation safety.

### 26.3 Contract invariant tests

- one action per request generation;
- no decision from unapproved signer;
- no completion without final evidence;
- pause prevents new instructions;
- retirement prevents new actions;
- immutable action domain;
- execution history equals finalized evidence count.

### 26.4 Integration tests

- local pinned FAssets deployment or fork;
- local FCC scaffold in simulated mode;
- XRPL local or test harness;
- FDC request construction against official fixtures;
- Postgres restart;
- proxy restart;
- duplicate event delivery;
- conflicting coordinator workers.

### 26.5 Target-network tests

Required public evidence:

- Coston2 contract deployment and code check;
- Coston2 extension registration;
- one Coston2 `RedemptionRequested`;
- one Signet instruction;
- one FCC result;
- one XRPL Testnet validated Payment;
- one FDC proof;
- one Coston2 finalization;
- one replay rejection;
- one mutation rejection;
- one unauthorized-request refusal.

### 26.6 Chaos tests

- kill coordinator after persistence but before submit;
- kill coordinator after submit but before response;
- kill coordinator during FDC request;
- disconnect one XRPL RPC;
- return inconsistent ledger data from one RPC;
- restart extension;
- expire lease while a worker is running;
- revoke code version while an action is pending;
- fill disk;
- delay Coston2 and XRPL observations.

### 26.7 Security tests

- leaked `.env` prevention;
- log redaction;
- image-layer secret scan;
- forged ActionResult;
- wrong action ID;
- wrong chain;
- wrong signer;
- stale code hash;
- malicious memo;
- Unicode and encoding confusion;
- high fee;
- partial-payment flag;
- missing `LastLedgerSequence`;
- unsupported NetworkID;
- invalid destination tag;
- FDC proof replay;
- proof-owner mismatch where supported.

## 27. User interface

### 27.1 Operator console

Required screens:

- agent binding;
- key and signer configuration status;
- active redemptions;
- action state;
- deadline margin;
- XRPL submission state;
- FDC proof state;
- pause and recovery status;
- objective execution history.

The console must never display or accept signing secrets.

### 27.2 Public proof page

The first screen shows:

- one-sentence product definition;
- dominant mechanism;
- current evidence level;
- completed result;
- unauthorized request refusal;
- replay and mutation failures;
- Coston2, XRPL and FDC links;
- code hash and policy version;
- verifier command;
- limitations.

### 27.3 Accessibility and resilience

- keyboard navigation;
- semantic status labels;
- no color-only meaning;
- exact timestamps and network names;
- copyable hashes;
- graceful RPC failure;
- static cached evidence for completed demonstrations.

## 28. Evidence and claim ledger

`evidence/claim-ledger.json` is authoritative for public claims.

Each entry contains:

```json
{
  "id": "claim-valid-redemption-001",
  "wording": "One Coston2 FAssets redemption was paid on XRPL Testnet and completed with FDC evidence.",
  "status": "unavailable",
  "proofLevel": 0,
  "network": ["coston2", "testXRP"],
  "evidence": [],
  "verifiedAt": null,
  "limitations": ["Not executed yet"]
}
```

Allowed statuses:

- `verified`
- `failed`
- `unavailable`
- `reported_not_independently_verified`

The web app and README summary must be generated from or checked against this file.

Do not count:

- deployed but unused contracts;
- scripts that were never executed;
- mocked proof calls;
- predicted gas as measured gas;
- local runs as target-chain runs;
- addresses as completed workflows;
- test wallets as users;
- simulated TEE as hardware-attested execution.

## 29. Deployment environments

### 29.1 Local deterministic

- pinned local dependencies;
- deterministic reference fixtures;
- local Postgres;
- simulated FCC stack;
- XRPL transaction fixture or local node;
- no public claims.

### 29.2 Coston2 integration

- live Coston2;
- official FCC scaffold;
- simulated TEE until real access succeeds;
- XRPL Testnet;
- FDC testXRP;
- test-only key material;
- public evidence labelled accurately.

### 29.3 Attested test

- real GCP Confidential Space or official FCC machine;
- reproduced code hash;
- attestation verified;
- testXRP only;
- required before claiming the key was protected from the host by hardware.

### 29.4 Production candidate

- Flare mainnet only after all release gates;
- real XRP account with explicit risk limit;
- quorum signing or approved exception;
- external audit;
- runbooks and drills;
- no hackathon deadline may override this gate.

## 30. CI and release gates

Every pull request runs:

```text
format
lint
typecheck
unit
property
contract-invariant
race
integration
secret-scan
dependency-scan
container-scan
source-lock-check
claim-ledger-schema
reproducible-build-check
```

Release candidate adds:

- fork or pinned protocol integration;
- Coston2 smoke test;
- XRPL Testnet smoke test;
- FDC proof smoke test;
- verifier from fresh clone;
- SBOM;
- signed images;
- deployment manifest diff;
- manual security approval.

Mainnet release adds:

- external audit closure;
- production TEE attestation;
- key-recovery drill;
- quorum-signing test;
- incident drill;
- governance multisig check;
- change-management record.

## 31. Acceptance criteria

The core is complete only when:

- reference model predicts the authorization result;
- Solidity and Go match the reference fixtures;
- current official FCC stack produces the result;
- one real XRPL Testnet payment validates;
- FDC proves the expected payment;
- the current FAssets interface accepts the proof;
- Coston2 records the completed lifecycle;
- unauthorized, mutated and replayed requests fail;
- target-chain result is linked from the proof page;
- verifier succeeds from a fresh clone;
- public/private boundary tests pass;
- claim ledger contains no inflated claim;
- the complete claim fits one sentence;
- the result fits one screenshot or short clip.

## 32. Phased implementation gates

No phase may begin optional work before its predecessor passes. A phase report is stored at `docs/evidence/phase-NN.md`.

### Phase 00: Source lock and environment

Scope:

- create monorepo;
- pin official sources;
- record current interfaces and toolchains;
- acquire Flare indexer and Coston2 agent access;
- establish Claude Code sandbox.

Files:

- `docs/source-lock.json`
- `toolchain.lock`
- `CLAUDE.md`
- `.claude/`
- `Makefile`
- lockfiles

Evidence:

- upstream commits and checksums;
- successful clean bootstrap;
- `make verify-bootstrap`;
- documented access status.

Tests:

- source-lock schema;
- checksum verification;
- no-secret scan.

Completion gate:

- every required upstream source pinned;
- current Coston2 addresses resolved and code-checked;
- access blockers explicitly marked.

Stop boundary:

- do not implement protocol logic if FCC indexer access or a credible Coston2 redemption path cannot be obtained.

### Phase 01: Executable reference model

Scope:

- define canonical types, decision function, encoding and fixtures.

Files:

- `reference/`
- `docs/adr/0001-canonical-encoding.md`
- `docs/adr/0002-policy-semantics.md`

Evidence:

- fixtures for valid and all central invalid cases;
- deterministic commitment hashes.

Tests:

- exhaustive small-state tests;
- property tests;
- mutation tests.

Completion gate:

- independent reviewer can implement the decision from the spec;
- fixture hashes are frozen.

Stop boundary:

- no contracts or extension policy implementation before this passes.

### Phase 02: FAssets protocol seam

Scope:

- read current Coston2 AssetManager;
- decode real redemption event;
- call current request-info view;
- identify exact completion and default selectors;
- prove behavior on current deployment or pinned local source.

Files:

- `contracts/src/adapters/FAssetsAdapter.sol`
- `contracts/test/fork/FAssetsSeam.t.sol`
- `docs/protocol-seams/fassets.md`

Evidence:

- RPC code hash;
- selector checks;
- one decoded live or deliberately created Coston2 request;
- pinned ABI and source commit.

Adversarial cases:

- inactive request;
- wrong agent;
- tagged request;
- malformed address;
- incomplete redemption.

Completion gate:

- canonical fields match official event and interface behavior.

Stop boundary:

- no payment builder if memo, tag or amount semantics remain ambiguous.

### Phase 03: FCC scaffold seam

Scope:

- run untouched official scaffold lifecycle;
- deploy minimal Signet sender;
- register extension;
- retrieve one signed ActionResult;
- verify result domain onchain.

Files:

- scaffold pin;
- `contracts/src/SignetActionVerifier.sol`
- minimal `extension/`.

Evidence:

- Coston2 deployment;
- extension ID;
- code hash;
- machine registration;
- successful action and verifier transaction.

Tests:

- wrong signer;
- wrong action ID;
- wrong chain;
- stale code hash;
- duplicate result.

Completion gate:

- exact current FCC result-verification path works.

Stop boundary:

- no secret or XRPL signing until result provenance is proven.

### Phase 04: XRPL transaction seam

Scope:

- create test account;
- configure RegularKey;
- construct exact Payment from fixture;
- persist, submit and reconcile reliably.

Files:

- `extension/internal/xrpl/`
- `coordinator/src/xrpl/`
- `docs/protocol-seams/xrpl.md`

Evidence:

- validated SetRegularKey transaction;
- validated exact Payment;
- stored signed blob before submit;
- reconciliation log.

Tests:

- fee cap;
- partial-payment flag rejection;
- missing `LastLedgerSequence`;
- sequence collision;
- resubmit identical blob;
- expiry.

Completion gate:

- one exact test payment reaches validated success with deterministic evidence.

Stop boundary:

- no FAssets claim yet.

### Phase 05: FDC seam

Scope:

- construct current FDC request for the validated test payment;
- obtain proof;
- verify it locally and on Coston2.

Files:

- `coordinator/src/fdc/`
- `contracts/src/adapters/FdcAdapter.sol`
- `docs/protocol-seams/fdc.md`

Evidence:

- request bytes;
- voting round;
- Merkle proof;
- verification transaction.

Tests:

- wrong memo;
- wrong tag;
- wrong amount;
- wrong proof owner;
- proof replay;
- nonexistence fixture.

Completion gate:

- real testXRP payment proof accepted by current FDC verifier.

Stop boundary:

- no full lifecycle until proof construction is stable.

### Phase 06: Minimum Signet contracts

Scope:

- agent binding;
- canonical request;
- action lifecycle;
- result verification;
- pause.

Files:

- `SignetInstructionSender.sol`
- `SignetRegistry.sol`
- unit and invariant tests.

Evidence:

- deployed local contracts;
- all invariants pass.

Tests:

- authorization;
- replay;
- access control;
- pause;
- retirement;
- forged result.

Completion gate:

- contracts cannot authorize arbitrary fields.

### Phase 07: Signet extension policy

Scope:

- implement canonical decoder;
- compare against reference model;
- construct and sign XRPL Payment;
- typed refusals.

Files:

- `extension/internal/action/`
- `extension/internal/policy/`
- `extension/internal/xrpl/`
- `extension/internal/receipt/`

Evidence:

- Go outputs match every reference fixture;
- no arbitrary signing endpoint exists.

Tests:

- fuzz input;
- field mutation;
- key-state errors;
- race;
- restart.

Completion gate:

- valid fixture signs, all invalid fixtures refuse, no secret in logs.

### Phase 08: Durable coordinator

Scope:

- event observers;
- Postgres model;
- leases;
- action polling;
- persist-before-submit;
- XRPL reconciliation;
- FDC orchestration.

Files:

- `coordinator/`
- migrations;
- runbooks.

Evidence:

- restart-safe local lifecycle;
- duplicate event tolerance;
- worker fencing.

Tests:

- crash at every external-call boundary;
- two workers;
- RPC mismatch;
- delayed proof.

Completion gate:

- no restart or duplicate delivery creates duplicate authority.

### Phase 09: Full local composed lifecycle

Scope:

- compose pinned FAssets, FCC simulation, XRPL harness and FDC fixtures;
- run valid and attack lifecycles.

Evidence:

- one command;
- deterministic artifacts;
- reference match.

Completion gate:

- local end-to-end plus replay and mutation failures.

Stop boundary:

- do not build polished UI before this passes.

### Phase 10: Target-chain lifecycle

Scope:

- create real Coston2 redemption;
- Signet instruction;
- real testXRP payment;
- real FDC proof;
- Coston2 completion.

Evidence:

- all transaction links;
- code hashes;
- timing measurements;
- completed receipt.

Adversarial evidence:

- unauthorized request refusal;
- changed destination;
- changed amount;
- replay.

Completion gate:

- minimum complete live transaction exists and is independently inspectable.

### Phase 11: Independent verifier and claim ledger

Scope:

- fresh-clone verifier;
- evidence bundle;
- generated claim ledger.

Files:

- `verifier/`
- `evidence/`
- `docs/evidence-schema.md`

Evidence:

- `pnpm verify:receipt <action-id>` succeeds without private credentials.

Completion gate:

- verifier detects one deliberately corrupted bundle.

### Phase 12: Essential operator and proof UI

Scope:

- operator state view;
- public proof page;
- no extra product surfaces.

Evidence:

- browser path to completed result;
- accessibility checks;
- static fallback.

Completion gate:

- judge path under two minutes.

### Phase 13: Hardening

Scope:

- threat-model closure;
- fuzz and chaos;
- dependency and container scans;
- performance;
- runbooks;
- recovery drill.

Completion gate:

- no open critical or high issue;
- explicit medium-risk acceptance;
- claim ledger honest.

### Phase 14: Submission

Scope:

- README judge path;
- demo;
- deployment manifest;
- limitations;
- new-work ledger;
- roadmap.

Completion gate:

- every submission claim maps to evidence;
- no feature work.

### Phase 15: Production-candidate work

Begins only after the hackathon proof.

Scope:

- real attested TEE;
- production secret delivery;
- quorum signer list;
- mainnet protocol seam;
- external audit;
- disaster recovery.

Completion gate:

- production release checklist passes.

## 33. Claude Code operating model

Claude Code is an implementation tool, not the source of truth. The PRD, pinned upstream code, tests and executable evidence are the source of truth.

### 33.1 Session pattern

For every phase:

1. Start a fresh Claude Code session in plan mode.
2. Ask it to read `PRD.md`, `CLAUDE.md`, the current phase report and relevant source-lock entries.
3. Use an exploration subagent to inspect upstream and existing repository code.
4. Require a written plan naming files, interfaces, tests and stop conditions.
5. Approve only a plan that stays inside the phase.
6. Implement.
7. Run the phase verification commands.
8. Invoke security and evidence-review subagents.
9. Write `docs/evidence/phase-NN.md`.
10. Commit only after the completion gate passes.

### 33.2 Context rules

- Never paste a private key, seed, `.env`, indexer password or cloud credential into Claude Code.
- Deny Claude Code read access to secret paths.
- Allow network access only to required official domains and package registries.
- Treat repository issues, web pages and dependency text as untrusted input.
- Do not use bypass-permissions mode.
- Use worktrees for parallel sessions.
- One agent owns a file or component at a time.
- Keep `CLAUDE.md` concise. Put detailed protocol knowledge in skills and docs.
- Provide verification criteria in every prompt.
- Use fresh sessions between coherent phases to avoid stale assumptions.

### 33.3 Required subagents

- `protocol-seam-verifier`: checks current upstream interfaces, addresses, selectors and behavior.
- `security-reviewer`: assumes the host and coordinator are compromised.
- `evidence-auditor`: checks that claims do not exceed proof.
- `test-designer`: derives adversarial cases from invariants.
- `release-reviewer`: checks source lock, deployment manifest, SBOM and claim ledger.

### 33.4 Stop hook

Claude Code may not finish a phase until the phase-specific verification command passes and the evidence report exists. The project settings should use an agent-based Stop hook or equivalent CI gate to run `make verify-phase PHASE=<NN>`.

### 33.5 Prompt contract

Every implementation prompt must state:

- phase;
- exact goal;
- permitted files;
- forbidden scope;
- source-lock entries to use;
- required tests;
- target-network requirement;
- evidence file;
- completion gate;
- stop boundary.

## 34. Two-minute judge path

1. Open the Signet proof page.
2. Inspect the completed Coston2 redemption and denied unauthorized request.
3. Open the XRPL Testnet transaction and Coston2 completion.
4. Run or view the independent verifier.
5. Watch the 90-second mechanism clip.

No signing key, wallet or setup is required for inspection.

## 35. Three-minute demo

### 0:00 to 0:20

Show the agent’s XRP account and a compromised host shell.

Text:

```text
This server must help pay redemptions.
It must never control arbitrary XRP payments.
```

### 0:20 to 0:45

Attempt:

```text
Send 50,000 XRP to attacker address
```

Result:

```text
DENIED
No matching FAssets obligation
Signed refusal receipt: <hash>
```

### 0:45 to 1:10

Show a real Coston2 `RedemptionRequested` with request ID, agent, destination, amount, reference and deadline.

### 1:10 to 1:35

Show the Signet action entering the registered extension. Show policy version and code hash. Do not expose secret material.

### 1:35 to 2:00

Show the validated XRPL Testnet transaction with exact destination, amount and memo or tag.

### 2:00 to 2:20

Show the FDC proof and final Coston2 redemption state.

### 2:20 to 2:40

Replay the request, change destination and change amount. Show three refusals.

### 2:40 to 3:00

Run:

```bash
pnpm verify:receipt <action-id>
```

Display all checks as passed.

## 36. Risks and kill criteria

### 36.1 Critical risks

| Risk | Decision |
|---|---|
| FCC real deployment inaccessible | Public proof may proceed only with explicit simulated label. No hardware-security claim |
| Coston2 agent or redemption path unavailable | Stop Signet build or use a pinned local protocol proof without claiming full target-chain completion |
| Indexer credentials unavailable | Stop FCC target-chain work |
| FCC latency cannot fit redemption window | Reject current architecture or move to a direct-request path only if officially supported and equally verifiable |
| Key persistence is not safely recoverable | No production activation |
| Existing FAssets agent stack already offers equivalent obligation-gated HSM policy | Reassess differentiation |
| Current FAssets V2 roadmap already implements identical mechanism | Reframe as reference implementation only with sponsor confirmation |
| Exact FDC/FAssets composition fails | Narrow claim or abandon, do not mock |

### 36.2 Product kill criteria

Abandon or materially revise if:

- an arbitrary payment can be signed through any exposed path;
- one obligation can create two validated payments;
- replacement safety cannot be proven;
- the real protocol seam requires modified upstream code;
- production recovery requires revealing a key to the ordinary host;
- judges cannot verify the composed lifecycle;
- operator interviews show no additional value over current HSM or MPC practices.

## 37. Roadmap

### After public proof

- interview active agent operators;
- integrate objective history into an agent operations surface;
- test real Confidential Space;
- build 2-of-3 XRPL multi-sign;
- test failover and signer loss;
- external review.

### Later

- Core Vault executor adapter;
- PMW adapter when public and stable;
- FBTC and FDOGE;
- private batch clearing of multiple authorized obligations;
- routing policies based on objective execution records;
- obligation-gated signing SDK.

## 38. Official sources verified August 4, 2026

Flare:

- FCC getting started: https://dev.flare.network/fcc/guides/getting-started
- FCC private key extension: https://dev.flare.network/fcc/guides/sign-extension
- Flare Foundation GitHub organization: https://github.com/flare-foundation
- FAssets redemption: https://dev.flare.network/fassets/redemption
- FAssets redemption guide: https://dev.flare.network/fassets/developer-guides/fassets-redeem
- FAssets default monitoring: https://dev.flare.network/fassets/developer-guides/fassets-redemption-default
- FAssets reference: https://dev.flare.network/fassets/reference
- FDC XRP payment: https://dev.flare.network/fdc/reference/IXRPPayment
- FDC XRP payment nonexistence: https://dev.flare.network/fdc/reference/IXRPPaymentNonexistence
- FDC reference: https://dev.flare.network/fdc/reference
- Foundry periphery: https://github.com/flare-foundation/flare-foundry-periphery-package
- npm periphery: https://github.com/flare-foundation/flare-npm-periphery-package
- FAssets demo dapp: https://github.com/flare-foundation/fassets-demo-dapp
- FDC client: https://github.com/flare-foundation/fdc-client

XRPL:

- Accounts and key options: https://xrpl.org/docs/concepts/accounts
- Multi-signing: https://xrpl.org/docs/concepts/accounts/multi-signing
- Tickets: https://xrpl.org/docs/concepts/accounts/tickets
- Transaction common fields: https://xrpl.org/docs/references/protocol/transactions/common-fields
- Reliable transaction submission: https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission
- Payment transaction: https://xrpl.org/docs/references/protocol/transactions/types/payment

Claude Code:

- Best practices: https://code.claude.com/docs/en/best-practices
- Common workflows: https://code.claude.com/docs/en/common-workflows
- Settings: https://code.claude.com/docs/en/settings
- Sandboxing: https://code.claude.com/docs/en/sandboxing
- Hooks: https://code.claude.com/docs/en/hooks
- Subagents: https://code.claude.com/docs/en/sub-agents

## 39. Final release rule

The public proof is successful when one lawful payment succeeds and one unlawful payment fails through the same deployed policy.

Production is successful only when the signing authority is genuinely protected by attested infrastructure, recovery is proven, quorum or approved equivalent custody is active, and an independent reviewer can reproduce every core guarantee.

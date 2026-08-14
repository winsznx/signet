# Signet architecture

**FAssets decides what is owed. Signet decides whether that exact XRP payment may exist. FDC proves
what happened.**

Signet sits between a FAssets redemption obligation on Flare and the XRP payment that discharges it
on the XRP ledger. The design goal is narrow and structural: **an operator, a coordinator, or anyone
else with access to the request path must not be able to choose what gets paid.**

---

## 1. The whole flow

```mermaid
graph LR
  Redeemer["FXRP holder<br/>redeems"] --> AssetManager

  subgraph FLARE["FLARE &middot; COSTON2"]
    AssetManager["FAssets AssetManager<br/><br/>Creates the obligation.<br/>Destination, amount, reference,<br/>tag and payment window."]
    Registry["SignetRegistry<br/><br/>Binds an agent vault to a<br/>signing boundary. Opens one<br/>action per request+generation."]
    Sender["SignetFccInstructionSender<br/><br/>authorizeRedemption(requestId, generation)<br/>Reads every payment field from FAssets.<br/>No parameter can express one."]
    FdcHub["FDC<br/><br/>Attests the XRP payment<br/>back onto Flare."]
  end

  subgraph BOUNDARY["SIGNING BOUNDARY &middot; FCC EXTENSION"]
    Policy["policy.Decide<br/><br/>Authorize, or a typed refusal.<br/>Total: every input yields one<br/>or the other."]
    Observer["xrplobserve<br/><br/>Independent look at the XRP<br/>ledger. Endpoints must agree."]
    Signer["Transaction builder<br/><br/>Persists the signed blob<br/>before first submission."]
  end

  subgraph XRPL["XRP LEDGER &middot; TESTNET"]
    Ledger["Validated ledger<br/><br/>Consumes the account sequence.<br/>Refuses a replay itself."]
  end

  AssetManager -->|"obligation, read on chain"| Sender
  Registry -->|"binding + action state"| Sender
  Sender -->|"canonical instruction<br/>ABI-encoded by the contract"| Policy
  Observer -->|"observation, bound into<br/>the authorization commitment"| Policy
  Ledger -->|"has this obligation<br/>already been paid?"| Observer
  Policy -->|"authorized payment"| Signer
  Signer -->|"exactly one payment"| Ledger
  Ledger -->|"validated transaction"| FdcHub
  FdcHub -->|"XRPPayment proof,<br/>verifiable by anyone"| Verifier["Independent verifier<br/><br/>Recomputes the commitment.<br/>Re-observes the ledger.<br/>Exits 3 on UNVERIFIABLE."]
```

Take any one of the four away and something specific breaks:

| remove | what breaks |
|---|---|
| **FAssets** | there is no authoritative obligation, and Signet degrades into enforcing a policy someone typed |
| **FCC** | a compromised host signs arbitrary XRP |
| **XRPL observation** | a payment already made by another party is invisible. This is [incident 44928272](docs/evidence/incident-44928272.md), not a hypothesis |
| **FDC** | completion cannot be established on Flare, and the operator's word becomes the evidence |

---

## 2. What a caller can and cannot express

This is the core security property, and it is structural rather than statistical: the fields simply
do not exist as parameters.

```mermaid
graph LR
  Caller["Any caller<br/><br/>Operator, coordinator,<br/>attacker. Same path."] -->|"requestId, generation"| Entry

  Entry["authorizeRedemption(uint256, uint32)<br/><br/>The entire payment-bearing API surface."]

  Entry --> Guard1{"Does FAssets report<br/>this request ACTIVE?"}
  Guard1 -->|no| Refuse1["AdapterRefused(NOT_ACTIVE)<br/>No instruction is built"]
  Guard1 -->|yes| Guard2{"Is the agent binding<br/>ACTIVE in SignetRegistry?"}
  Guard2 -->|no| Refuse2["BindingNotActive"]
  Guard2 -->|yes| Guard3{"Is the action in<br/>state REQUESTED?"}
  Guard3 -->|no| Refuse3["ActionNotRequested(found)<br/>Already decided, refused,<br/>or finalized"]
  Guard3 -->|yes| Guard4{"Has an instruction already<br/>been dispatched for it?"}
  Guard4 -->|yes| Refuse4["InstructionAlreadyDispatched<br/>At most one, ever"]
  Guard4 -->|no| Build["Mark dispatched, then build<br/>the canonical instruction<br/><br/>Destination, amount, reference,<br/>tag, window and agent all read<br/>from FAssets by the contract"]

  Build --> Dispatch["Send to the FCC extension"]

  Note["There is no destination parameter.<br/>No amount. No reference. No window.<br/>Nothing to validate, because nothing<br/>can be supplied."] -.-> Entry
```

The dispatch marker is written **before** the external call, so a reentrant caller cannot get
underneath it, and it lives on chain rather than in the extension because a restart gives the
extension a new identity and would lose it.

---

## 3. The decision, and every way it refuses

`Decide` is total: every input produces an authorization or a typed refusal, never a crash and never
silence. That totality is what makes the boundary trustworthy, and it is fuzzed rather than asserted.

```mermaid
graph TD
  Input["Canonical instruction<br/>from the contract"] --> Decode{"Decodes as the<br/>expected schema?"}
  Decode -->|no| S001["S001_UNKNOWN_SCHEMA<br/><br/>A caller-authored payload<br/>fails here, as a decode error<br/>rather than a policy refusal"]
  Decode -->|yes| Obs{"Is there an observation<br/>of the XRP ledger?"}

  Obs -->|"none, or too few<br/>agreeing sources"| S022["S022_UNDERLYING_STATE_UNAVAILABLE"]
  Obs -->|"sources disagree"| S023["S023_UNDERLYING_STATE_DISAGREEMENT<br/><br/>Deliberately never retried"]
  Obs -->|"too old to rely on"| S024["S024_UNDERLYING_OBSERVATION_STALE"]
  Obs -->|"agreed and fresh"| Paid{"Does a validated payment<br/>already carry this reference<br/>to this destination?"}

  Paid -->|yes| S021["S021_PAYMENT_ALREADY_OBSERVED<br/><br/>The reason code incident<br/>44928272 created"]
  Paid -->|no| Prior{"Is every prior generation<br/>proven not successful?"}

  Prior -->|no| S018["S018_REPLACEMENT_NOT_AUTHORIZED"]
  Prior -->|yes| Build2{"Deadline, fee cap and<br/>safety margin satisfied?"}

  Build2 -->|no| SXXX["Typed refusal<br/>with its reason code"]
  Build2 -->|yes| Auth["AUTHORIZE<br/><br/>One exact payment.<br/>Commitment covers every field."]
```

Refusing is the default. There is no input that authorizes without an observation.

---

## 4. Incident 44928272, and why V2 exists

The first model asked Flare whether an obligation was outstanding. Flare answered honestly, and the
answer was not the question that mattered.

```mermaid
graph LR
  subgraph BEFORE["V1 &middot; WHAT WE BELIEVED"]
    B1["FAssets says ACTIVE"] --> B2["Therefore unpaid"] --> B3["Authorize the payment"]
  end

  subgraph REALITY["WHAT WAS ACTUALLY TRUE"]
    R1["Ledger 19825006<br/><br/>The assigned agent had<br/>already paid, on XRPL"] --> R2["ACTIVE means<br/>not yet confirmed on Flare<br/><br/>Confirmation is a separate<br/>transaction the agent sends<br/>after its payment validates"]
    R2 --> R3["Ledger 19825042<br/><br/>Signet paid the same<br/>obligation again"]
  end

  subgraph AFTER["V2 &middot; THE CORRECTION"]
    A1["Observe the XRP ledger<br/>from the signing boundary"] --> A2["Independent endpoints<br/>must agree"] --> A3["S021_PAYMENT_ALREADY_OBSERVED<br/><br/>Bound into the authorization<br/>commitment, not checked beside it"]
  end

  BEFORE --> REALITY
  REALITY --> AFTER
```

All three of Signet's duplicate-payment guards were real and all three watched Flare. The registry
action state, the coordinator's unique indexes and the ledger's sequence consumption each prevent
*Signet* paying twice. None can see a payment made by somebody else. **The defect was not a missing
check. It was a missing chain.**

Residual, stated rather than hidden: `S021` fires on a payment that has *validated*. Between another
party submitting and that payment validating, Signet can still observe nothing. That window cannot
be closed by observation, only by exclusive signing authority over the underlying account, which is
production architecture and is not instantiated here.

---

## 5. Trust boundaries

```mermaid
graph TB
  subgraph UNTRUSTED["UNTRUSTED FOR PAYMENT AUTHORITY"]
    Coordinator["Coordinator<br/><br/>Schedules work, holds durable state.<br/>Cannot choose a payment field."]
    Host["Operator host<br/><br/>Runs the process today.<br/>No isolation from the decider."]
    Frontend["Product surface<br/><br/>Read-only. Runtime state<br/>is never evidence."]
  end

  subgraph TRUSTED["RELIED ON"]
    FAssetsT["FAssets AssetManager<br/>Defines the obligation"]
    FCCT["Flare Confidential Compute<br/>Constrains what may be signed"]
    XRPLT["XRPL consensus<br/>Refuses replays, orders payments"]
    FDCT["FDC<br/>Attests outcomes onto Flare"]
  end

  subgraph GAP["NOT PRESENT IN THIS DEPLOYMENT"]
    TEE["Hardware attestation<br/><br/>No TEE machine registered.<br/>MachineManager owner allowlist<br/>refused registration."]
  end

  Coordinator -->|"requestId only"| FCCT
  Host -.->|"can bypass the contract path<br/>by running its own binary"| GAP
  FAssetsT --> FCCT
  FCCT --> XRPLT
  XRPLT --> FDCT
```

The host is the honest weak point. Gate B removes the **protocol-level** path to an arbitrary
signature; it does not create isolation between the decider and the machine it runs on. That is what
a real TEE would buy, and this deployment does not have one. Recorded as a medium residual in
[the threat model](docs/threat-model.md), and every claim that touches it says so.

---

## 6. Components

| component | language | role |
|---|---|---|
| [`contracts/src/fcc/SignetFccInstructionSender.sol`](contracts/src/fcc/SignetFccInstructionSender.sol) | Solidity | the only payment-bearing entry point; derives the canonical instruction from FAssets |
| [`contracts/src/adapters/FAssetsAdapter.sol`](contracts/src/adapters/FAssetsAdapter.sol) | Solidity | reads the obligation, refuses anything not `ACTIVE` |
| [`contracts/src/SignetRegistry.sol`](contracts/src/SignetRegistry.sol) | Solidity | agent bindings, action lifecycle, approved code hashes and signers |
| [`extension/internal/policy/`](extension/internal/policy/) | Go | the decision, its reason codes, and its totality |
| [`extension/internal/xrplobserve/`](extension/internal/xrplobserve/) | Go | independent XRP ledger observation across endpoints that must agree |
| [`extension/internal/fccinput/`](extension/internal/fccinput/) | Go | decodes the contract-built instruction; a caller-authored payload fails to decode |
| [`reference/src/`](reference/src/) | TypeScript | executable reference model and frozen fixtures the Go side must match |
| [`verifier/src/`](verifier/src/) | TypeScript | re-checks a receipt from a fresh clone with no credentials |
| [`coordinator/`](coordinator/) | SQL, JS | durable state, untrusted for payment authority |
| [`web/`](web/) | JS | the product surface, generated from the evidence in this repository |

---

## 7. What is deployed

| | |
|---|---|
| Network | Flare Coston2, chain id 114 |
| `SignetRegistry` | [`0x381bdE5961695914B28B16f405d51E8acB877f6e`](https://coston2.testnet.flarescan.com/address/0x381bdE5961695914B28B16f405d51E8acB877f6e) |
| `SignetFccInstructionSender` | [`0x7e2dd9078c7d741e0cF81904264A79e70212963a`](https://coston2.testnet.flarescan.com/address/0x7e2dd9078c7d741e0cF81904264A79e70212963a) |
| FCC extension | `66248`, registered on the live `FlareTeeManager` |
| FCC machine | **not registered.** Registration reverted `OwnerNotAllowed` |
| Execution | **simulated.** A local process, not a Confidential Space VM |
| Hardware attestation | **none, and not claimed anywhere** |

Addresses are read from [`deployments/coston2.json`](deployments/coston2.json), which is the source
of truth. Superseded extensions `66163`, `66164` and `66244` are recorded there with their reasons.

---

## 8. Reproducing it

```bash
git clone https://github.com/winsznx/signet
cd signet
pnpm install --frozen-lockfile
bash scripts/install-go.sh

make verify     # every gate: contracts, Go, reference model, conformance, secrets, evidence
make judge      # independent verification: no wallet, no funds, no Docker, no GCP, no secrets
make doctor     # read-only diagnosis of the deployed FCC surface
```

`make judge` currently returns **13 PASS, 0 FAIL, 2 UNVERIFIABLE**. `UNVERIFIABLE` is never folded
into a pass: it means the check could not be performed from where it ran, and both instances are
explained on [the proof page](https://signet-proof.pages.dev/proof).

Further reading: [threat model](docs/threat-model.md) &middot;
[guarantee](docs/guarantee.md) &middot;
[incident 44928272](docs/evidence/incident-44928272.md) &middot;
[claim ledger](evidence/claim-ledger.json) &middot;
[open-source surface](docs/submission/open-source-surface.md)

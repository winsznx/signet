// Command signet-fcc-extension is Signet's decision boundary as a Flare Confidential Compute
// extension.
//
// The CLI in cmd/signet-extension takes a decision on stdin and writes it to stdout. That was enough
// to prove the policy, and it is not what FCC runs. FCC runs an HTTP extension inside a tee-node,
// hands it an Action, and signs keccak over the ActionResult it returns. Until this file existed,
// nothing in Signet actually derived a payment "inside FCC" in the sense the protocol means, and an
// organizer asking for exactly that would have been right to say so.
//
// What this adds is the wire surface and nothing else. The decision is the same `policy.Decide`
// the 76 frozen fixtures hold to, called from a different transport. That is deliberate: a second
// decision implementation reachable only through FCC would be a second thing to get wrong, and the
// whole point of the fixture set is that there is one decision.
//
// The op-type registers exactly the commands PRD 20.1 fixes and no wildcard. A wildcard handler
// under Signet's op-type would accept any command name, which is the shape of an arbitrary signing
// endpoint even when no caller uses it.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"strings"
	"sync"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	"github.com/flare-foundation/tee-node/pkg/processorutils"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/signet/extension/internal/fccinput"
	"github.com/signet/extension/internal/policy"
	"github.com/signet/extension/internal/xrplobserve"
)

// Version is the extension's own version string, distinct from the state version. The scaffold
// warns that the sign repo's ports get this asymmetry wrong, so it is spelled out here: this is a
// plain string, and StateResponse.stateVersion is a bytes32.
const Version = "0.1.0"

const (
	OPTypeRedemption = "SIGNET_REDEMPTION"

	// The commands PRD section 20.1 fixes. There is no SIGN_ARBITRARY and no wildcard.
	CommandAuthorizeRedemption = "AUTHORIZE_REDEMPTION"
	CommandHealthCheck         = "HEALTH_CHECK"
)

type stateResponse struct {
	StateVersion any   `json:"stateVersion"`
	State        state `json:"state"`
}

// state is deliberately thin. An extension that accumulates interesting state accumulates something
// worth tampering with, and every field here is a counter that no decision reads.
type state struct {
	Decisions     int    `json:"decisions"`
	Authorized    int    `json:"authorized"`
	Refused       int    `json:"refused"`
	LastReason    string `json:"lastReason"`
	PolicyVersion int    `json:"policyVersion"`
	SchemaVersion int    `json:"schemaVersion"`
}

type extension struct {
	mu sync.RWMutex
	st state

	// The extension observes the XRP ledger itself. An observation handed to it by whoever wants
	// the signature is worth nothing.
	observer   *xrplobserve.Observer
	minSources int
	maxAge     int
}

// decisionResult is what lands in ActionResult.Data, and therefore what the node signs.
//
// It carries the obligation hash and the authorization commitment because those are the two values
// an outside party recomputes. It does NOT carry the decision input: the input contains the
// underlying observation and the binding, and re-emitting them here would create a second source of
// truth for values that must be read from FAssets and the ledger.
type decisionResult struct {
	Kind                    string          `json:"kind"`
	ObligationHash          string          `json:"obligationHash"`
	AuthorizationCommitment string          `json:"authorizationCommitment,omitempty"`
	Reason                  string          `json:"reason,omitempty"`
	ErrorClass              string          `json:"errorClass,omitempty"`
	Payment                 *policy.Payment `json:"payment,omitempty"`
	SchemaVersion           int             `json:"schemaVersion"`
}

func main() {
	extensionPort := flag.Int("port", 8080, "port for the extension HTTP surface")
	xrplEndpoints := flag.String("xrpl", "https://testnet.xrpl-labs.com/,https://s.altnet.rippletest.net:51234/",
		"comma-separated XRPL endpoints the extension observes for itself")
	minSources := flag.Int("min-sources", 2, "independently hosted endpoints that must agree")
	maxAge := flag.Int("max-observation-age", 20, "how many ledgers old an observation may be")
	flag.Parse()

	e := &extension{
		st:         state{PolicyVersion: 1, SchemaVersion: policy.SchemaVersion},
		observer:   xrplobserve.New(strings.Split(*xrplEndpoints, ",")),
		minSources: *minSources,
		maxAge:     *maxAge,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	addr := fmt.Sprintf(":%d", *extensionPort)
	log.Printf("signet fcc extension listening on %s, op-type %s, schema v%d", addr, OPTypeRedemption, policy.SchemaVersion)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("serving: %v", err)
	}
}

func (e *extension) stateHandler(w http.ResponseWriter, _ *http.Request) {
	e.mu.RLock()
	response := stateResponse{StateVersion: teeutils.ToHash(Version), State: e.st}
	e.mu.RUnlock()
	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
	}
}

// actionHandler follows the extension contract exactly: an action that reached a handler returns 200
// with an ActionResult even when the handler failed, and failure is signalled by ActionResult.status
// rather than by the HTTP status. Only an unregistered op returns 501 and only a malformed body 400.
func (e *extension) actionHandler(w http.ResponseWriter, r *http.Request) {
	var action teetypes.Action
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&action); err != nil {
		http.Error(w, fmt.Sprintf("decoding action: %v", err), http.StatusBadRequest)
		return
	}

	status, body := e.processAction(action)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (e *extension) processAction(action teetypes.Action) (int, []byte) {
	// The pinned helper, not a hand-rolled one. An earlier version of this file hex-decoded the
	// message first, on the strength of a comment claiming the contract double-encodes it. That was
	// wrong: `Data.Message` is `hexutil.Bytes` and the JSON decoder has already unhexed it by the
	// time this runs, so the extra step could never fire and its fallback silently did what the
	// pinned helper does correctly. Using the real one also restores the size bound the hand-rolled
	// version dropped.
	dataFixed, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	if dataFixed.OPType != teeutils.ToHash(OPTypeRedemption) {
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			dataFixed.OPType.Hex(), teeutils.ToHash(OPTypeRedemption).Hex(), OPTypeRedemption,
		))
	}

	switch dataFixed.OPCommand {
	case teeutils.ToHash(CommandAuthorizeRedemption):
		result := e.authorizeRedemption(action, dataFixed)
		encoded, _ := json.Marshal(result)
		return http.StatusOK, encoded

	case teeutils.ToHash(CommandHealthCheck):
		result := e.healthCheck(action, dataFixed)
		encoded, _ := json.Marshal(result)
		return http.StatusOK, encoded

	default:
		// No wildcard. An unregistered command is 501, never a decision.
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected one of [%s (%s), %s (%s)]",
			dataFixed.OPCommand.Hex(),
			teeutils.ToHash(CommandAuthorizeRedemption).Hex(), CommandAuthorizeRedemption,
			teeutils.ToHash(CommandHealthCheck).Hex(), CommandHealthCheck,
		))
	}
}

// authorizeRedemption is the whole point of the extension.
//
// `originalMessage` is the ABI-encoded canonical instruction that
// `SignetFccInstructionSender.authorizeRedemption(requestId, generation)` built from FAssets state.
// It is not a caller-authored snapshot, and there is no code path here that accepts one: an earlier
// version took JSON straight from the instruction sender, which meant whoever sent the instruction
// chose the destination, the amount, the reference, the tag and the window.
//
// Two things are supplied by this extension rather than by the instruction, and both are things a
// caller must not control and the chain cannot know:
//
//   - the XRPL allocation, which is operational and is bounded downstream by the fee cap and the
//     safety margin rather than by trust;
//   - the underlying observation, which this extension takes itself across independently hosted
//     endpoints that must agree.
func (e *extension) authorizeRedemption(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	canonical, err := fccinput.Decode(df.OriginalMessage)
	if err != nil {
		// A malformed instruction is a handler failure, not a refusal. A refusal is a statement
		// about a real obligation, and a payload that will not decode does not identify one.
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding canonical instruction: %w", err))
	}

	input, err := e.buildInput(canonical)
	if err != nil {
		return buildResult(action, df, nil, 0, err)
	}

	decision := policy.Decide(input)

	e.mu.Lock()
	e.st.Decisions++
	if decision.Kind == "authorize" {
		e.st.Authorized++
	} else {
		e.st.Refused++
		e.st.LastReason = decision.Reason
	}
	e.mu.Unlock()

	data, err := json.Marshal(decisionResult{
		Kind:                    decision.Kind,
		ObligationHash:          decision.ObligationHash,
		AuthorizationCommitment: decision.AuthorizationCommitment,
		Reason:                  decision.Reason,
		ErrorClass:              decision.ErrorClass,
		Payment:                 decision.Payment,
		SchemaVersion:           policy.SchemaVersion,
	})
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("encoding decision: %w", err))
	}

	// Status 1 for both authorize and refuse. A typed refusal is a successful decision, and reporting
	// it as a handler failure would erase the distinction between "the policy said no" and "the
	// extension broke", which is exactly the distinction FR-024 exists to preserve.
	return buildResult(action, df, data, 1, nil)
}

// allocationFor reads the operational XRPL state this payment needs: the source account's sequence,
// the current validated ledger, and the fee.
//
// None of these can change the destination, the amount, the reference, the tag or the window, which
// is why they are safe to take from the network at signing time. They are still bounded downstream:
// the fee against the cap, the ledger position against the safety margin.
//
// In this build the extension is a local process, so it reads them over public XRPL endpoints. In a
// Confidential Space deployment the same code runs inside the measured image.
func (e *extension) allocationFor(c *fccinput.CanonicalInstruction) (*policy.XrplAllocation, error) {
	account, err := e.observer.AccountState(context.Background(), c.XrplSourceAddress)
	if err != nil {
		return nil, fmt.Errorf("reading xrpl account state: %w", err)
	}
	return &policy.XrplAllocation{
		SequenceMode:           "SEQUENCE",
		SequenceOrTicket:       account.Sequence,
		CurrentValidatedLedger: account.ValidatedLedger,
		CurrentLedgerCloseTime: account.CloseTime,
		LastLedgerSequence:     account.ValidatedLedger + 40,
		FeeDrops:               account.FeeDrops,
		MaxFeeDrops:            big.NewInt(50_000),
		BaseFeeDrops:           account.BaseFeeDrops,
	}, nil
}

// buildInput turns the canonical instruction into a decision input.
//
// Every obligation field is copied from the instruction and none is computed, defaulted or repaired.
// The allocation and the observation come from this extension. If the two were ever allowed to
// arrive from the same place, the gate would be back where it started.
func (e *extension) buildInput(c *fccinput.CanonicalInstruction) (policy.Input, error) {
	allocation, err := e.allocationFor(c)
	if err != nil {
		return policy.Input{}, err
	}

	observation := e.observer.Observe(
		context.Background(),
		c.PaymentAddress,
		"0x"+hex.EncodeToString(c.PaymentReference[:]),
		allocation.CurrentValidatedLedger,
	)

	codeHash := "0x" + hex.EncodeToString(c.ApprovedCodeHash[:])
	return policy.Input{
		Domain: policy.Domain{
			SchemaVersion:     policy.SchemaVersion,
			FlareChainID:      c.FlareChainID,
			InstructionSender: c.InstructionSender.Hex(),
			AssetManager:      c.AssetManager.Hex(),
			XrplNetworkID:     int(c.XrplNetworkID),
		},
		Binding: &policy.Binding{
			AgentVault:        c.AgentVault.Hex(),
			AssetManager:      c.AssetManager.Hex(),
			FlareChainID:      c.FlareChainID,
			InstructionSender: c.InstructionSender.Hex(),
			XrplNetworkID:     int(c.XrplNetworkID),
			XrplSourceAddress: c.XrplSourceAddress,
			SigningMode:       "REGULAR_KEY",
			KeyState:          "ACTIVE",
			Status:            "ACTIVE",
			ExtensionID:       c.ExtensionID,
			ApprovedCodeHash:  codeHash,
			PolicyVersion:     int(c.PolicyVersion),
		},
		Redemption: &policy.Redemption{
			RequestID:         c.RequestID,
			RequestGeneration: int(c.RequestGeneration),
			// The sender only builds an instruction for a request FAssets reports as ACTIVE; the
			// adapter refuses otherwise before any payload exists.
			Status:                  "ACTIVE",
			AgentVault:              c.AgentVault.Hex(),
			PaymentAddress:          c.PaymentAddress,
			PaymentReference:        "0x" + hex.EncodeToString(c.PaymentReference[:]),
			ValueUBA:                c.ValueUBA,
			FeeUBA:                  c.FeeUBA,
			FirstUnderlyingBlock:    new(big.Int).SetUint64(c.FirstUnderlyingBlock),
			LastUnderlyingBlock:     new(big.Int).SetUint64(c.LastUnderlyingBlock),
			LastUnderlyingTimestamp: new(big.Int).SetUint64(c.LastUnderlyingTimestamp),
			RequiresDestinationTag:  c.RequiresDestinationTag,
			DestinationTag:          c.DestinationTag,
			AssetMintingDecimals:    int(c.AssetMintingDecimals),
		},
		Xrpl: allocation,
		Policy: policy.Policy{
			PolicyVersion:              int(c.PolicyVersion),
			ExtensionID:                c.ExtensionID,
			ExtensionCodeHash:          codeHash,
			SafetyMarginLedgers:        50,
			SafetyMarginSeconds:        big.NewInt(300),
			LedgerCloseIntervalSeconds: big.NewInt(4),
			MinimumUnderlyingSources:   e.minSources,
			MaxObservationAgeLedgers:   e.maxAge,
		},
		Prior:      nil,
		Underlying: observation,
	}, nil
}

func (e *extension) healthCheck(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	e.mu.RLock()
	snapshot := e.st
	e.mu.RUnlock()
	data, _ := json.Marshal(snapshot)
	return buildResult(action, df, data, 1, nil)
}

// buildResult mirrors the scaffold's own helper. The log strings are wire contract, not prose.
func buildResult(a teetypes.Action, df *instruction.DataFixed, data []byte, status uint8, err error) teetypes.ActionResult {
	result := teetypes.ActionResult{
		ID:            a.Data.ID,
		SubmissionTag: a.Data.SubmissionTag,
		Version:       Version,
		OPType:        df.OPType,
		OPCommand:     df.OPCommand,
		Data:          data,
		Status:        status,
	}
	switch status {
	case 0:
		result.Log = fmt.Sprintf("error: %v", err)
	case 1:
		result.Log = "ok"
	default:
		result.Log = "pending"
	}
	return result
}

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
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/signet/extension/internal/policy"
	"github.com/signet/extension/internal/wire"
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
	flag.Parse()

	e := &extension{st: state{PolicyVersion: 1, SchemaVersion: policy.SchemaVersion}}

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
	dataFixed, err := parseFixed(action.Data.Message)
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
// `originalMessage` carries the decision input in the same wire format the CLI and the 76 frozen
// fixtures use, parsed by the same decoder. A separate FCC-only parser would be a separate thing to
// get wrong, and the fixtures would stop covering what actually runs.
func (e *extension) authorizeRedemption(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	input, err := wire.Decode(df.OriginalMessage)
	if err != nil {
		// A malformed input is a handler failure, not a refusal. A refusal is a statement about a
		// real obligation, and an input that will not parse does not identify one.
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding decision input: %w", err))
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

func (e *extension) healthCheck(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	e.mu.RLock()
	snapshot := e.st
	e.mu.RUnlock()
	data, _ := json.Marshal(snapshot)
	return buildResult(action, df, data, 1, nil)
}

// parseFixed hex-decodes the message and parses the result as a DataFixed. The double encoding is
// the contract's, not ours, and the scaffold documents it as a thing implementations get wrong.
func parseFixed(message []byte) (*instruction.DataFixed, error) {
	raw := bytes.TrimPrefix(message, []byte("0x"))
	decoded := make([]byte, len(raw)/2)
	if _, err := fmt.Sscanf(string(raw), "%x", &decoded); err != nil {
		// Some transports deliver the message already decoded.
		decoded = message
	}
	var fixed instruction.DataFixed
	if err := json.Unmarshal(decoded, &fixed); err != nil {
		return nil, err
	}
	return &fixed, nil
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

// Command signet-extension is the decision boundary as a process.
//
// It reads one decision input on stdin and writes one decision on stdout. There is deliberately no
// flag, environment variable or endpoint that accepts a payment field: the only way to influence
// the payment is to change the FAssets obligation carried in the input, which the caller does not
// control either. A build that grew such a flag would be a different product.
//
// It also never touches key material. The output is a decision and a canonical transaction; a
// separate boundary signs it. That split is what lets this binary be measured and its output
// checked without the measurement having to cover a signer.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/signet/extension/internal/policy"
	"github.com/signet/extension/internal/wire"
)

type output struct {
	Kind                    string          `json:"kind"`
	ObligationHash          string          `json:"obligationHash"`
	AuthorizationCommitment string          `json:"authorizationCommitment,omitempty"`
	Reason                  string          `json:"reason,omitempty"`
	ErrorClass              string          `json:"errorClass,omitempty"`
	Payment                 *policy.Payment `json:"payment,omitempty"`
}

func main() {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail("read stdin: %v", err)
	}
	in, err := wire.Decode(raw)
	if err != nil {
		// A malformed input is not a refusal. A refusal is a statement about a real obligation, and
		// an input that would not parse does not identify one, so emitting a signed refusal here
		// would attribute a decision to an obligation nobody named.
		fail("%v", err)
	}

	d := policy.Decide(in)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(output{
		Kind:                    d.Kind,
		ObligationHash:          d.ObligationHash,
		AuthorizationCommitment: d.AuthorizationCommitment,
		Reason:                  d.Reason,
		ErrorClass:              d.ErrorClass,
		Payment:                 d.Payment,
	}); err != nil {
		fail("write stdout: %v", err)
	}
	if d.Kind != "authorize" {
		// A refusal is a successful decision, but the exit code has to distinguish it, because a
		// caller that only checks the exit status must never read a refusal as an authorization.
		os.Exit(2)
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "signet-extension: "+format+"\n", args...)
	os.Exit(1)
}

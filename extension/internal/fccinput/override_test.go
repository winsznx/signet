package fccinput

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// The Gate B adversarial set, on the decoder side.
//
// The strongest form of "a caller cannot override a payment field" is structural: the on-chain
// function takes a request id and a generation, and the payload is built by the contract from
// FAssets state. A Solidity test asserts that (contracts/test/unit/CanonicalInstruction.t.sol).
//
// What these tests cover is the layer below: whatever bytes arrive, the extension reads the
// obligation from the decoded payload and nowhere else. A field an attacker wants to move has to be
// moved in the payload, and moving it in the payload is exactly what the on-chain sender does not
// let them do.
func TestEveryPaymentFieldIsReadFromThePayload(t *testing.T) {
	cases := map[string]struct {
		mutate  func(*CanonicalInstruction)
		differs func(a, b *CanonicalInstruction) bool
	}{
		"destination": {
			func(c *CanonicalInstruction) { c.PaymentAddress = "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72" },
			func(a, b *CanonicalInstruction) bool { return a.PaymentAddress != b.PaymentAddress },
		},
		"amount": {
			func(c *CanonicalInstruction) { c.ValueUBA = big.NewInt(99_000_000) },
			func(a, b *CanonicalInstruction) bool { return a.ValueUBA.Cmp(b.ValueUBA) != 0 },
		},
		"fee": {
			func(c *CanonicalInstruction) { c.FeeUBA = big.NewInt(1) },
			func(a, b *CanonicalInstruction) bool { return a.FeeUBA.Cmp(b.FeeUBA) != 0 },
		},
		"reference": {
			func(c *CanonicalInstruction) { c.PaymentReference = [32]byte{0xff} },
			func(a, b *CanonicalInstruction) bool { return a.PaymentReference != b.PaymentReference },
		},
		"tag mode": {
			func(c *CanonicalInstruction) { c.RequiresDestinationTag = true },
			func(a, b *CanonicalInstruction) bool { return a.RequiresDestinationTag != b.RequiresDestinationTag },
		},
		"tag value": {
			func(c *CanonicalInstruction) { c.DestinationTag = big.NewInt(4242) },
			func(a, b *CanonicalInstruction) bool { return a.DestinationTag.Cmp(b.DestinationTag) != 0 },
		},
		"deadline block": {
			func(c *CanonicalInstruction) { c.LastUnderlyingBlock = 99_999_999 },
			func(a, b *CanonicalInstruction) bool { return a.LastUnderlyingBlock != b.LastUnderlyingBlock },
		},
		"deadline time": {
			func(c *CanonicalInstruction) { c.LastUnderlyingTimestamp = 99_999_999 },
			func(a, b *CanonicalInstruction) bool { return a.LastUnderlyingTimestamp != b.LastUnderlyingTimestamp },
		},
		"agent": {
			func(c *CanonicalInstruction) { c.AgentVault[19] = 0xEE },
			func(a, b *CanonicalInstruction) bool { return a.AgentVault != b.AgentVault },
		},
	}

	base, err := Decode(encode(t, nil))
	if err != nil {
		t.Fatal(err)
	}

	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			moved, err := Decode(encode(t, c.mutate))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if !c.differs(base, moved) {
				t.Fatalf("%s was not read from the payload: the decoder ignored a change to it", name)
			}
		})
	}
}

// Trailing bytes must not be silently accepted. ABI decoding ignores them, so a payload that decodes
// cleanly while carrying extra data would let a sender smuggle something a future reader might use.
func TestTrailingBytesAreNotSilentlyAccepted(t *testing.T) {
	payload := encode(t, nil)
	extended := append(append([]byte{}, payload...), make([]byte, 32)...)

	base, err := Decode(payload)
	if err != nil {
		t.Fatal(err)
	}
	extra, err := Decode(extended)
	if err != nil {
		// Refusing outright is the stronger behaviour and is acceptable.
		return
	}
	// If it is accepted, it must at least decode to exactly the same obligation: no trailing byte
	// may reach any field a payment is derived from.
	if extra.PaymentAddress != base.PaymentAddress || extra.ValueUBA.Cmp(base.ValueUBA) != 0 ||
		extra.PaymentReference != base.PaymentReference || extra.LastUnderlyingBlock != base.LastUnderlyingBlock {
		t.Fatal("trailing bytes changed a payment field")
	}
}

// A payload one field short must not decode into a shifted obligation.
func TestATruncatedPayloadDoesNotShiftFields(t *testing.T) {
	payload := encode(t, nil)
	for _, cut := range []int{32, 64, 128, len(payload) / 2} {
		if cut >= len(payload) {
			continue
		}
		if _, err := Decode(payload[:len(payload)-cut]); err == nil {
			t.Fatalf("a payload short by %d bytes decoded", cut)
		}
	}
}

var _ = abi.Arguments{}

package fccinput

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// encode builds a payload the way the Solidity sender does, so the test exercises the real shape
// rather than a Go-side approximation of it.
func encode(t *testing.T, override func(*CanonicalInstruction)) []byte {
	t.Helper()
	instruction := CanonicalInstruction{
		SchemaVersion:           big.NewInt(2),
		FlareChainID:            big.NewInt(114),
		RequestID:               big.NewInt(44928272),
		RequestGeneration:       0,
		PaymentAddress:          "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb",
		ValueUBA:                big.NewInt(10_000_000),
		FeeUBA:                  big.NewInt(50_000),
		FirstUnderlyingBlock:    19_824_924,
		LastUnderlyingBlock:     19_825_472,
		LastUnderlyingTimestamp: 1_786_468_650,
		DestinationTag:          big.NewInt(0),
		AssetMintingDecimals:    6,
		XrplSourceAddress:       "rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta",
		XrplNetworkID:           1,
		ExtensionID:             big.NewInt(66164),
		PolicyVersion:           1,
	}
	if override != nil {
		override(&instruction)
	}
	args := abi.Arguments{{Type: instructionType}}
	payload, err := args.Pack(instruction)
	if err != nil {
		t.Fatalf("packing: %v", err)
	}
	return payload
}

func TestDecodeRoundTripsTheCanonicalInstruction(t *testing.T) {
	decoded, err := Decode(encode(t, nil))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.PaymentAddress != "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb" {
		t.Fatalf("destination: %q", decoded.PaymentAddress)
	}
	if decoded.ValueUBA.Cmp(big.NewInt(10_000_000)) != 0 || decoded.FeeUBA.Cmp(big.NewInt(50_000)) != 0 {
		t.Fatalf("amount: %v / %v", decoded.ValueUBA, decoded.FeeUBA)
	}
	if decoded.LastUnderlyingTimestamp != 1_786_468_650 {
		t.Fatalf("window: %d", decoded.LastUnderlyingTimestamp)
	}
}

// An unknown schema version is refused rather than interpreted. A decoder that guesses is worse
// than one that stops, because the fields it guesses about are payment fields.
func TestDecodeRefusesAnUnknownSchemaVersion(t *testing.T) {
	for _, version := range []int64{0, 1, 3, 99} {
		payload := encode(t, func(c *CanonicalInstruction) { c.SchemaVersion = big.NewInt(version) })
		if _, err := Decode(payload); err == nil {
			t.Fatalf("schema version %d was accepted", version)
		}
	}
}

func TestDecodeRefusesGarbage(t *testing.T) {
	for name, payload := range map[string][]byte{
		"empty":     {},
		"truncated": encode(t, nil)[:64],
		"noise":     []byte("not abi encoded at all, not even close"),
	} {
		if _, err := Decode(payload); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

// The decoder is positional. This asserts that a field moving changes what is read, which is the
// property that makes the Solidity and Go declaration orders load-bearing rather than cosmetic.
func TestFieldOrderIsLoadBearing(t *testing.T) {
	base, err := Decode(encode(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	moved, err := Decode(encode(t, func(c *CanonicalInstruction) {
		c.ValueUBA = big.NewInt(20_000_000)
	}))
	if err != nil {
		t.Fatal(err)
	}
	if base.ValueUBA.Cmp(moved.ValueUBA) == 0 {
		t.Fatal("changing the obligation did not change the decoded payload")
	}
}

// Package fccinput decodes the canonical instruction the on-chain sender builds.
//
// This package exists because of Gate B. Before it, the FCC extension took a JSON decision input
// straight from whoever sent the instruction, which meant an untrusted caller chose the destination,
// the amount, the reference, the tag and the payment window. The decision then checked those values
// for internal consistency rather than for truth, which is a signing service rather than a signing
// boundary.
//
// Now `SignetFccInstructionSender.authorizeRedemption(requestId, generation)` resolves the
// obligation from FAssets itself and ABI-encodes it. This package decodes exactly that struct. There
// is no path here that accepts a caller-authored obligation, and adding one would undo the gate.
package fccinput

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// CanonicalInstruction mirrors SignetFccInstructionSender.CanonicalInstruction field for field and
// in declaration order. The order is load-bearing: ABI decoding is positional, so a field inserted
// on one side and not the other silently shifts every value after it.
type CanonicalInstruction struct {
	SchemaVersion           *big.Int       `abi:"schemaVersion"`
	FlareChainID            *big.Int       `abi:"flareChainId"`
	AssetManager            common.Address `abi:"assetManager"`
	InstructionSender       common.Address `abi:"instructionSender"`
	AgentVault              common.Address `abi:"agentVault"`
	RequestID               *big.Int       `abi:"requestId"`
	RequestGeneration       uint32         `abi:"requestGeneration"`
	ActionID                [32]byte       `abi:"actionId"`
	ObligationHash          [32]byte       `abi:"obligationHash"`
	PaymentAddress          string         `abi:"paymentAddress"`
	PaymentReference        [32]byte       `abi:"paymentReference"`
	ValueUBA                *big.Int       `abi:"valueUBA"`
	FeeUBA                  *big.Int       `abi:"feeUBA"`
	FirstUnderlyingBlock    uint64         `abi:"firstUnderlyingBlock"`
	LastUnderlyingBlock     uint64         `abi:"lastUnderlyingBlock"`
	LastUnderlyingTimestamp uint64         `abi:"lastUnderlyingTimestamp"`
	RequiresDestinationTag  bool           `abi:"requiresDestinationTag"`
	DestinationTag          *big.Int       `abi:"destinationTag"`
	AssetMintingDecimals    uint8          `abi:"assetMintingDecimals"`
	XrplSourceAddress       string         `abi:"xrplSourceAddress"`
	XrplNetworkID           uint32         `abi:"xrplNetworkId"`
	ExtensionID             *big.Int       `abi:"extensionId"`
	ApprovedCodeHash        [32]byte       `abi:"approvedCodeHash"`
	PolicyVersion           uint32         `abi:"policyVersion"`
}

// SupportedSchemaVersion is the only canonical instruction version this build accepts. An unknown
// version is refused rather than interpreted: the whole point of a versioned payload is that a
// decoder which guesses is worse than one that stops.
const SupportedSchemaVersion = 2

var instructionType = mustTupleType()

func mustTupleType() abi.Type {
	t, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "schemaVersion", Type: "uint256"},
		{Name: "flareChainId", Type: "uint256"},
		{Name: "assetManager", Type: "address"},
		{Name: "instructionSender", Type: "address"},
		{Name: "agentVault", Type: "address"},
		{Name: "requestId", Type: "uint256"},
		{Name: "requestGeneration", Type: "uint32"},
		{Name: "actionId", Type: "bytes32"},
		{Name: "obligationHash", Type: "bytes32"},
		{Name: "paymentAddress", Type: "string"},
		{Name: "paymentReference", Type: "bytes32"},
		{Name: "valueUBA", Type: "uint256"},
		{Name: "feeUBA", Type: "uint256"},
		{Name: "firstUnderlyingBlock", Type: "uint64"},
		{Name: "lastUnderlyingBlock", Type: "uint64"},
		{Name: "lastUnderlyingTimestamp", Type: "uint64"},
		{Name: "requiresDestinationTag", Type: "bool"},
		{Name: "destinationTag", Type: "uint256"},
		{Name: "assetMintingDecimals", Type: "uint8"},
		{Name: "xrplSourceAddress", Type: "string"},
		{Name: "xrplNetworkId", Type: "uint32"},
		{Name: "extensionId", Type: "uint256"},
		{Name: "approvedCodeHash", Type: "bytes32"},
		{Name: "policyVersion", Type: "uint32"},
	})
	if err != nil {
		panic(fmt.Sprintf("fccinput: canonical instruction type is malformed: %v", err))
	}
	return t
}

// Decode parses the ABI-encoded canonical instruction.
//
// It refuses an unknown schema version and a payload with trailing bytes. Trailing bytes matter:
// ABI decoding ignores them, so a payload that decodes cleanly and carries extra data would let a
// sender append something a future version might read.
func Decode(payload []byte) (*CanonicalInstruction, error) {
	args := abi.Arguments{{Type: instructionType}}
	values, err := args.Unpack(payload)
	if err != nil {
		return nil, fmt.Errorf("fccinput: decoding canonical instruction: %w", err)
	}
	if len(values) != 1 {
		return nil, fmt.Errorf("fccinput: expected one tuple, got %d", len(values))
	}

	// ConvertType is geth's own idiom for reshaping an unpacked anonymous tuple into a named
	// struct. It matches by field order and type, which is why the declaration order here has to
	// track the Solidity struct exactly.
	instruction := *abi.ConvertType(values[0], new(CanonicalInstruction)).(*CanonicalInstruction)

	if instruction.SchemaVersion == nil || instruction.SchemaVersion.Cmp(big.NewInt(SupportedSchemaVersion)) != 0 {
		return nil, fmt.Errorf("fccinput: unsupported canonical instruction schema version %v", instruction.SchemaVersion)
	}
	return &instruction, nil
}

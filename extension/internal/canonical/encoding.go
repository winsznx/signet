// Package canonical implements the Signet commitment encoding frozen by
// docs/adr/0001-canonical-encoding.md.
//
// This is a deliberate second implementation of a scheme that already exists in TypeScript. That is
// the point: the reference model is the specification, and this package has to agree with it on
// every frozen fixture. It is written from the ADR rather than transliterated from the TypeScript,
// because a transliteration would reproduce a mistake as faithfully as it reproduces the design.
package canonical

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"

	"golang.org/x/crypto/sha3"
)

const (
	// ObligationPreimageLength and AuthorizationPreimageLength are asserted on every encode. A
	// field added or resized without updating them fails loudly rather than silently changing a
	// commitment.
	ObligationPreimageLength    = 141
	AuthorizationPreimageLength = 431

	ObligationDomainString    = "SIGNET_FASSETS_OBLIGATION_V1"
	AuthorizationDomainString = "SIGNET_FASSETS_REDEMPTION_V1"
)

var (
	ErrOverflow   = errors.New("canonical: value does not fit its fixed width")
	ErrFieldWidth = errors.New("canonical: fixed-width field has the wrong length")
	ErrTagMode    = errors.New("canonical: destinationTag must be 0 when destinationTagMode is NONE")
)

// Keccak256 is the hash the whole scheme is built on.
func Keccak256(data []byte) [32]byte {
	h := sha3.NewLegacyKeccak256()
	h.Write(data)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func domain(s string) [32]byte { return Keccak256([]byte(s)) }

// ObligationFields identifies which obligation and generation a decision concerns.
type ObligationFields struct {
	SchemaVersion     uint8
	FlareChainID      *big.Int
	AssetManager      [20]byte
	AgentVault        [20]byte
	RequestID         *big.Int
	RequestGeneration uint32
}

// AuthorizationFields covers the complete signed payment.
type AuthorizationFields struct {
	ObligationFields
	InstructionSender            [20]byte
	XrplNetworkID                uint32
	XrplSourceAccountID          [20]byte
	XrplSourceAddressStringHash  [32]byte
	DestinationAccountID         [20]byte
	DestinationAddressStringHash [32]byte
	DestinationTagMode           uint8
	DestinationTag               uint32
	AmountDrops                  uint64
	PaymentReference             [32]byte
	FirstUnderlyingBlock         uint64
	LastUnderlyingBlock          uint64
	LastUnderlyingTimestamp      uint64
	SequenceMode                 uint8
	SequenceOrTicket             uint32
	LastLedgerSequence           uint32
	FeeDrops                     uint64
	MaxFeeDrops                  uint64
	PolicyVersion                uint32
	ExtensionID                  *big.Int
	ExtensionCodeHash            [32]byte
}

// uint256BE renders a big.Int as exactly 32 big-endian bytes, refusing anything that does not fit
// rather than truncating it.
func uint256BE(v *big.Int) ([32]byte, error) {
	var out [32]byte
	if v == nil {
		return out, fmt.Errorf("%w: nil big.Int", ErrOverflow)
	}
	if v.Sign() < 0 {
		return out, fmt.Errorf("%w: negative value", ErrOverflow)
	}
	b := v.Bytes()
	if len(b) > 32 {
		return out, fmt.Errorf("%w: %d bytes", ErrOverflow, len(b))
	}
	copy(out[32-len(b):], b)
	return out, nil
}

// EncodeObligation produces the 141-byte obligation preimage.
func EncodeObligation(f ObligationFields) ([]byte, error) {
	chainID, err := uint256BE(f.FlareChainID)
	if err != nil {
		return nil, err
	}
	requestID, err := uint256BE(f.RequestID)
	if err != nil {
		return nil, err
	}

	buf := make([]byte, 0, ObligationPreimageLength)
	d := domain(ObligationDomainString)
	buf = append(buf, d[:]...)
	buf = append(buf, f.SchemaVersion)
	buf = append(buf, chainID[:]...)
	buf = append(buf, f.AssetManager[:]...)
	buf = append(buf, f.AgentVault[:]...)
	buf = append(buf, requestID[:]...)
	buf = binary.BigEndian.AppendUint32(buf, f.RequestGeneration)

	if len(buf) != ObligationPreimageLength {
		return nil, fmt.Errorf("%w: obligation preimage is %d bytes", ErrFieldWidth, len(buf))
	}
	return buf, nil
}

// ObligationHash is keccak256 over the obligation preimage.
func ObligationHash(f ObligationFields) ([32]byte, error) {
	preimage, err := EncodeObligation(f)
	if err != nil {
		return [32]byte{}, err
	}
	return Keccak256(preimage), nil
}

// EncodeAuthorization produces the 431-byte authorization preimage.
func EncodeAuthorization(f AuthorizationFields) ([]byte, error) {
	// "No tag" must have exactly one encoding, so it can never collide with "tag 0".
	if f.DestinationTagMode == 0 && f.DestinationTag != 0 {
		return nil, ErrTagMode
	}

	chainID, err := uint256BE(f.FlareChainID)
	if err != nil {
		return nil, err
	}
	requestID, err := uint256BE(f.RequestID)
	if err != nil {
		return nil, err
	}
	extensionID, err := uint256BE(f.ExtensionID)
	if err != nil {
		return nil, err
	}

	buf := make([]byte, 0, AuthorizationPreimageLength)
	d := domain(AuthorizationDomainString)
	buf = append(buf, d[:]...)
	buf = append(buf, f.SchemaVersion)
	buf = append(buf, chainID[:]...)
	buf = append(buf, f.InstructionSender[:]...)
	buf = append(buf, f.AssetManager[:]...)
	buf = append(buf, f.AgentVault[:]...)
	buf = append(buf, requestID[:]...)
	buf = binary.BigEndian.AppendUint32(buf, f.RequestGeneration)
	buf = binary.BigEndian.AppendUint32(buf, f.XrplNetworkID)
	buf = append(buf, f.XrplSourceAccountID[:]...)
	buf = append(buf, f.XrplSourceAddressStringHash[:]...)
	buf = append(buf, f.DestinationAccountID[:]...)
	buf = append(buf, f.DestinationAddressStringHash[:]...)
	buf = append(buf, f.DestinationTagMode)
	buf = binary.BigEndian.AppendUint32(buf, f.DestinationTag)
	buf = binary.BigEndian.AppendUint64(buf, f.AmountDrops)
	buf = append(buf, f.PaymentReference[:]...)
	buf = binary.BigEndian.AppendUint64(buf, f.FirstUnderlyingBlock)
	buf = binary.BigEndian.AppendUint64(buf, f.LastUnderlyingBlock)
	buf = binary.BigEndian.AppendUint64(buf, f.LastUnderlyingTimestamp)
	buf = append(buf, f.SequenceMode)
	buf = binary.BigEndian.AppendUint32(buf, f.SequenceOrTicket)
	buf = binary.BigEndian.AppendUint32(buf, f.LastLedgerSequence)
	buf = binary.BigEndian.AppendUint64(buf, f.FeeDrops)
	buf = binary.BigEndian.AppendUint64(buf, f.MaxFeeDrops)
	buf = binary.BigEndian.AppendUint32(buf, f.PolicyVersion)
	buf = append(buf, extensionID[:]...)
	buf = append(buf, f.ExtensionCodeHash[:]...)

	if len(buf) != AuthorizationPreimageLength {
		return nil, fmt.Errorf("%w: authorization preimage is %d bytes", ErrFieldWidth, len(buf))
	}
	return buf, nil
}

// AuthorizationCommitment is keccak256 over the authorization preimage.
func AuthorizationCommitment(f AuthorizationFields) ([32]byte, error) {
	preimage, err := EncodeAuthorization(f)
	if err != nil {
		return [32]byte{}, err
	}
	return Keccak256(preimage), nil
}

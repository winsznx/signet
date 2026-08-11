// Package canonical implements the Signet commitment encoding frozen by
// docs/adr/0001-canonical-encoding.md.
//
// This is a deliberate second implementation of a scheme that already exists in TypeScript. That is
// the point: the reference model is the specification, and this package has to agree with it on
// every frozen fixture. It is written from the ADR rather than transliterated from the TypeScript,
// because a transliteration would reproduce a mistake as faithfully as it reproduces the design.
package canonical

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"sort"

	"golang.org/x/crypto/sha3"
)

const (
	// ObligationPreimageLength and AuthorizationPreimageLength are asserted on every encode. A
	// field added or resized without updating them fails loudly rather than silently changing a
	// commitment.
	ObligationPreimageLength    = 141
	AuthorizationPreimageLength = 468

	ObligationDomainString    = "SIGNET_FASSETS_OBLIGATION_V1"
	AuthorizationDomainString = "SIGNET_FASSETS_REDEMPTION_V1"
	ObservationDomainString   = "SIGNET_UNDERLYING_OBSERVATION_V1"

	// ObligationEncodingVersion is frozen at 1 and is not the input schema version. The obligation
	// encoding identifies which obligation a decision concerns and did not change in V2, and it is
	// what SignetInstructionSender computes on Coston2, whose deployed bytecode writes a literal 1.
	ObligationEncodingVersion = 1
	// AuthorizationEncodingVersion moved to 2 when the underlying observation was bound into it.
	AuthorizationEncodingVersion = 2
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
	ObservedAtLedger             uint32
	ObservedSourceCount          uint8
	ObservationRoot              [32]byte
}

// ObservedPayment is one payment the signing boundary saw carrying an obligation's reference.
type ObservedPayment struct {
	TransactionHash [32]byte
	AmountDrops     uint64
}

// ObservationRoot commits to what the underlying observation found.
//
// The match list is the only variable-length part of the scheme, so it is hashed to a fixed 32
// bytes rather than inlined. Matches are sorted by transaction hash so two observers who saw the
// same payments in a different order agree, and the count is bound so a truncated list cannot pass
// as a shorter one. Availability and agreement are inside the root because a decision that was
// allowed to proceed on an unavailable or contradictory observation must not be indistinguishable,
// afterwards, from one that had a clean look at the ledger.
func ObservationRoot(available, agreed bool, observedAtLedger uint32, observedAtTime uint64, sourceCount uint8, payments []ObservedPayment) [32]byte {
	// A total order, not merely a sort key. Ordering by transaction hash alone leaves ties, and a
	// tie is resolved by whatever the sort happens to do: Go's sort.Slice is explicitly not stable
	// while JavaScript's Array.prototype.sort is, so two entries sharing a hash produced different
	// roots in the two languages. A security review demonstrated it. Comparing the amount as well
	// makes the remaining ties genuinely indistinguishable, so the root no longer depends on the
	// order the observer happened to report.
	sorted := make([]ObservedPayment, len(payments))
	copy(sorted, payments)
	sort.SliceStable(sorted, func(i, j int) bool {
		if c := bytes.Compare(sorted[i].TransactionHash[:], sorted[j].TransactionHash[:]); c != 0 {
			return c < 0
		}
		return sorted[i].AmountDrops < sorted[j].AmountDrops
	})

	d := domain(ObservationDomainString)
	buf := make([]byte, 0, 32+1+1+4+8+1+4+len(sorted)*40)
	buf = append(buf, d[:]...)
	buf = append(buf, boolByte(available), boolByte(agreed))
	buf = binary.BigEndian.AppendUint32(buf, observedAtLedger)
	buf = binary.BigEndian.AppendUint64(buf, observedAtTime)
	buf = append(buf, sourceCount)
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(sorted)))
	for _, p := range sorted {
		buf = append(buf, p.TransactionHash[:]...)
		buf = binary.BigEndian.AppendUint64(buf, p.AmountDrops)
	}
	return Keccak256(buf)
}

func boolByte(v bool) byte {
	if v {
		return 1
	}
	return 0
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
	buf = append(buf, byte(ObligationEncodingVersion))
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

// EncodeAuthorization produces the authorization preimage, AuthorizationPreimageLength bytes.
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
	buf = append(buf, byte(AuthorizationEncodingVersion))
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
	buf = binary.BigEndian.AppendUint32(buf, f.ObservedAtLedger)
	buf = append(buf, f.ObservedSourceCount)
	buf = append(buf, f.ObservationRoot[:]...)

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

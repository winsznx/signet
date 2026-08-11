// Package policy is the Go implementation of the Signet authorization decision.
//
// It exists to be checked against reference/test-vectors/decision-fixtures.json, not to be trusted
// on its own. The evaluation order is fixed by docs/adr/0002-policy-semantics.md and is reproduced
// here in the same order, because the reason code a bad input produces is protocol surface.
//
// There is no arbitrary signing path in this package. The only exported decision function takes a
// complete obligation and returns either an authorization or a typed refusal.
package policy

import (
	"math/big"
	"strings"

	"github.com/signet/extension/internal/canonical"
)

const SchemaVersion = 1

// Reason codes, frozen by PRD section 20.4. Strings, not integers, because they appear in signed
// refusal receipts and in public evidence.
const (
	ReasonUnknownSchema            = "S001_UNKNOWN_SCHEMA"
	ReasonWrongDomain              = "S002_WRONG_DOMAIN"
	ReasonUnboundAgent             = "S003_UNBOUND_AGENT"
	ReasonInactiveRedemption       = "S004_INACTIVE_REDEMPTION"
	ReasonWrongAgent               = "S005_WRONG_AGENT"
	ReasonAlreadyConsumed          = "S006_ALREADY_CONSUMED"
	ReasonExpiredWindow            = "S007_EXPIRED_WINDOW"
	ReasonInsufficientSafetyMargin = "S008_INSUFFICIENT_SAFETY_MARGIN"
	ReasonDestinationInvalid       = "S009_DESTINATION_INVALID"
	ReasonAmountInvalid            = "S010_AMOUNT_INVALID"
	ReasonReferenceInvalid         = "S011_REFERENCE_INVALID"
	ReasonTagInvalid               = "S012_TAG_INVALID"
	ReasonFeeCapExceeded           = "S013_FEE_CAP_EXCEEDED"
	ReasonSequenceConflict         = "S014_SEQUENCE_CONFLICT"
	ReasonCodeVersionRevoked       = "S015_CODE_VERSION_REVOKED"
	ReasonPaused                   = "S016_PAUSED"
	ReasonStateUnavailable         = "S017_STATE_UNAVAILABLE"
	ReasonReplacementNotAuthorized = "S018_REPLACEMENT_NOT_AUTHORIZED"
	ReasonKeyNotActive             = "S019_KEY_NOT_ACTIVE"
	ReasonInternalFailClosed       = "S020_INTERNAL_FAIL_CLOSED"
)

const uint32Max = 0xffffffff

// networkIDRequiredFrom mirrors the XRPL rule: the NetworkID field belongs only on networks whose
// id is 1025 or greater.
const networkIDRequiredFrom = 1025

type Domain struct {
	SchemaVersion     int
	FlareChainID      *big.Int
	InstructionSender string
	AssetManager      string
	XrplNetworkID     int
}

type Binding struct {
	AgentVault        string
	AssetManager      string
	FlareChainID      *big.Int
	InstructionSender string
	XrplNetworkID     int
	XrplSourceAddress string
	SigningMode       string
	SignerCount       int
	KeyState          string
	Status            string
	ExtensionID       *big.Int
	ApprovedCodeHash  string
	PolicyVersion     int
}

type Redemption struct {
	RequestID               *big.Int
	RequestGeneration       int
	Status                  string
	AgentVault              string
	PaymentAddress          string
	PaymentReference        string
	ValueUBA                *big.Int
	FeeUBA                  *big.Int
	FirstUnderlyingBlock    *big.Int
	LastUnderlyingBlock     *big.Int
	LastUnderlyingTimestamp *big.Int
	RequiresDestinationTag  bool
	DestinationTag          *big.Int
	AssetMintingDecimals    int
}

type XrplAllocation struct {
	SequenceMode           string
	SequenceOrTicket       int
	CurrentValidatedLedger int
	CurrentLedgerCloseTime *big.Int
	LastLedgerSequence     int
	FeeDrops               *big.Int
	MaxFeeDrops            *big.Int
	BaseFeeDrops           *big.Int
}

type Policy struct {
	PolicyVersion              int
	ExtensionID                *big.Int
	ExtensionCodeHash          string
	RevokedCodeHashes          []string
	Paused                     bool
	SafetyMarginLedgers        int
	SafetyMarginSeconds        *big.Int
	LedgerCloseIntervalSeconds *big.Int
}

type PriorGeneration struct {
	RequestGeneration int
	SequenceMode      string
	SequenceOrTicket  int
	Outcome           string
}

// Input carries the same trust caveats as the reference model: Prior must come from the extension's
// own durable state and the registry's on-chain action state, never from a coordinator request, and
// CurrentValidatedLedger must be observed by the signing boundary rather than accepted from a
// caller. See docs/adr/0002-policy-semantics.md, "Trust sources".
type Input struct {
	Domain     Domain
	Binding    *Binding
	Redemption *Redemption
	Xrpl       *XrplAllocation
	Policy     Policy
	Prior      []PriorGeneration
}

type Memo struct {
	MemoData string `json:"MemoData"`
}

type MemoWrapper struct {
	Memo Memo `json:"Memo"`
}

// Payment is the canonical XRPL transaction. Field names match the ledger's.
type Payment struct {
	TransactionType    string        `json:"TransactionType"`
	Account            string        `json:"Account"`
	Destination        string        `json:"Destination"`
	Amount             string        `json:"Amount"`
	Fee                string        `json:"Fee"`
	Flags              int           `json:"Flags"`
	LastLedgerSequence int           `json:"LastLedgerSequence"`
	Memos              []MemoWrapper `json:"Memos"`
	Sequence           *int          `json:"Sequence,omitempty"`
	TicketSequence     *int          `json:"TicketSequence,omitempty"`
	DestinationTag     *int          `json:"DestinationTag,omitempty"`
	NetworkID          *int          `json:"NetworkID,omitempty"`
}

type Decision struct {
	Kind                    string
	ObligationHash          string
	AuthorizationCommitment string
	Reason                  string
	ErrorClass              string
	Payment                 *Payment
}

func errorClassOf(reason string) string {
	if reason == ReasonStateUnavailable {
		return "TRANSIENT_INFRA"
	}
	return "POLICY_DENIAL"
}

func sameAddress(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(a, b)
}

// Decide is total: it never panics and always returns either an authorization or a typed refusal.
func Decide(in Input) (d Decision) {
	defer func() {
		if r := recover(); r != nil {
			d = refuse(in, ReasonInternalFailClosed)
		}
	}()
	return evaluate(in)
}

func refuse(in Input, reason string) Decision {
	return Decision{
		Kind:           "refuse",
		ObligationHash: refusalObligationHash(in),
		Reason:         reason,
		ErrorClass:     errorClassOf(reason),
	}
}

func refusalObligationHash(in Input) string {
	agent := "0x0000000000000000000000000000000000000000"
	requestID := big.NewInt(0)
	generation := 0
	if in.Redemption != nil {
		agent = in.Redemption.AgentVault
		if in.Redemption.RequestID != nil {
			requestID = in.Redemption.RequestID
		}
		generation = in.Redemption.RequestGeneration
	}
	// A negative generation cannot be encoded in a fixed-width unsigned field. The reference model
	// lets the encode fail and falls back to an unattributable hash rather than clamping, because
	// clamping would attribute the refusal to generation 0, which is a real and different
	// obligation. Go must do the same or the two disagree on exactly the input that is already
	// malformed.
	if generation < 0 {
		u := canonical.Keccak256([]byte("SIGNET_UNATTRIBUTABLE_REFUSAL_V1"))
		return "0x" + hexOf(u[:])
	}
	h, err := canonical.ObligationHash(canonical.ObligationFields{
		SchemaVersion:     uint8(in.Domain.SchemaVersion),
		FlareChainID:      in.Domain.FlareChainID,
		AssetManager:      mustAddress(in.Domain.AssetManager),
		AgentVault:        mustAddress(agent),
		RequestID:         requestID,
		RequestGeneration: uint32(generation),
	})
	if err != nil {
		u := canonical.Keccak256([]byte("SIGNET_UNATTRIBUTABLE_REFUSAL_V1"))
		return "0x" + hexOf(u[:])
	}
	return "0x" + hexOf(h[:])
}

func evaluate(in Input) Decision {
	// 1. schema
	if in.Domain.SchemaVersion != SchemaVersion {
		return refuse(in, ReasonUnknownSchema)
	}
	// 2. emergency pause
	if in.Policy.Paused {
		return refuse(in, ReasonPaused)
	}
	// 3. availability, which is transient and never a policy denial
	if in.Binding == nil || in.Redemption == nil || in.Xrpl == nil {
		return refuse(in, ReasonStateUnavailable)
	}
	b, r, x, p := in.Binding, in.Redemption, in.Xrpl, in.Policy

	// 4. domain, compared against the binding rather than merely checked for shape
	if in.Domain.FlareChainID == nil || in.Domain.FlareChainID.Sign() <= 0 {
		return refuse(in, ReasonWrongDomain)
	}
	if !isAddress(in.Domain.InstructionSender) {
		return refuse(in, ReasonWrongDomain)
	}
	if in.Domain.XrplNetworkID < 0 {
		return refuse(in, ReasonWrongDomain)
	}
	if !sameAddress(b.AssetManager, in.Domain.AssetManager) {
		return refuse(in, ReasonWrongDomain)
	}
	if b.FlareChainID == nil || b.FlareChainID.Cmp(in.Domain.FlareChainID) != 0 {
		return refuse(in, ReasonWrongDomain)
	}
	if !sameAddress(b.InstructionSender, in.Domain.InstructionSender) {
		return refuse(in, ReasonWrongDomain)
	}
	if b.XrplNetworkID != in.Domain.XrplNetworkID {
		return refuse(in, ReasonWrongDomain)
	}

	// 5. binding lifecycle
	if b.Status == "RETIRED" {
		return refuse(in, ReasonUnboundAgent)
	}
	if b.Status == "PAUSED" {
		return refuse(in, ReasonPaused)
	}
	// 6. the obligation must be ours
	if !sameAddress(b.AgentVault, r.AgentVault) {
		return refuse(in, ReasonWrongAgent)
	}
	// 7. code and policy version
	if b.ExtensionID == nil || p.ExtensionID == nil || b.ExtensionID.Cmp(p.ExtensionID) != 0 {
		return refuse(in, ReasonCodeVersionRevoked)
	}
	if b.PolicyVersion != p.PolicyVersion {
		return refuse(in, ReasonCodeVersionRevoked)
	}
	if !strings.EqualFold(b.ApprovedCodeHash, p.ExtensionCodeHash) {
		return refuse(in, ReasonCodeVersionRevoked)
	}
	for _, revoked := range p.RevokedCodeHashes {
		if strings.EqualFold(revoked, p.ExtensionCodeHash) {
			return refuse(in, ReasonCodeVersionRevoked)
		}
	}
	// 8. signing authority
	if b.KeyState != "ACTIVE" {
		return refuse(in, ReasonKeyNotActive)
	}
	// 9. the obligation must be open
	if r.Status != "ACTIVE" {
		return refuse(in, ReasonInactiveRedemption)
	}
	// 10. one obligation, at most one successful payment
	for _, prior := range in.Prior {
		if prior.Outcome == "SUCCESSFUL" {
			return refuse(in, ReasonAlreadyConsumed)
		}
		if prior.RequestGeneration == r.RequestGeneration {
			return refuse(in, ReasonAlreadyConsumed)
		}
	}
	// 11. the history must describe generations 0..n-1 exactly once each
	if r.RequestGeneration < 0 {
		return refuse(in, ReasonReplacementNotAuthorized)
	}
	if len(in.Prior) != r.RequestGeneration {
		return refuse(in, ReasonReplacementNotAuthorized)
	}
	seen := make(map[int]bool, len(in.Prior))
	for _, prior := range in.Prior {
		if prior.RequestGeneration < 0 || prior.RequestGeneration >= r.RequestGeneration {
			return refuse(in, ReasonReplacementNotAuthorized)
		}
		if seen[prior.RequestGeneration] {
			return refuse(in, ReasonReplacementNotAuthorized)
		}
		seen[prior.RequestGeneration] = true
	}
	// 12. every earlier generation must be proven not successful
	if r.RequestGeneration > 0 {
		for _, prior := range in.Prior {
			if prior.Outcome != "PROVEN_NOT_SUCCESSFUL" {
				return refuse(in, ReasonReplacementNotAuthorized)
			}
		}
	}
	// 13. sequence or ticket collision
	for _, prior := range in.Prior {
		if prior.SequenceMode == x.SequenceMode && prior.SequenceOrTicket == x.SequenceOrTicket {
			return refuse(in, ReasonSequenceConflict)
		}
	}
	if x.SequenceOrTicket <= 0 || x.SequenceOrTicket > uint32Max {
		return refuse(in, ReasonSequenceConflict)
	}
	// 14. payment reference
	referenceBytes, ok := hexTo32(r.PaymentReference)
	if !ok {
		return refuse(in, ReasonReferenceInvalid)
	}
	expected, err := canonical.RedemptionPaymentReference(r.RequestID)
	if err != nil || expected != referenceBytes {
		return refuse(in, ReasonReferenceInvalid)
	}
	// 15. destination
	if !canonical.IsCanonicalClassicAddress(r.PaymentAddress) {
		return refuse(in, ReasonDestinationInvalid)
	}
	destinationAccountID, err := canonical.DecodeClassicAddress(r.PaymentAddress)
	if err != nil {
		return refuse(in, ReasonDestinationInvalid)
	}
	// 16. destination tag
	if r.RequiresDestinationTag {
		if r.DestinationTag == nil || r.DestinationTag.Sign() < 0 || r.DestinationTag.Cmp(big.NewInt(uint32Max)) > 0 {
			return refuse(in, ReasonTagInvalid)
		}
	} else if r.DestinationTag != nil && r.DestinationTag.Sign() != 0 {
		return refuse(in, ReasonTagInvalid)
	}
	// 17. amount
	amountDrops, ok := obligationAmountDrops(r.ValueUBA, r.FeeUBA, r.AssetMintingDecimals)
	if !ok {
		return refuse(in, ReasonAmountInvalid)
	}
	// 18. fee ceiling and signing-mode floor
	if x.FeeDrops == nil || x.FeeDrops.Sign() <= 0 || x.MaxFeeDrops == nil || x.MaxFeeDrops.Sign() <= 0 {
		return refuse(in, ReasonFeeCapExceeded)
	}
	if x.BaseFeeDrops == nil || x.BaseFeeDrops.Sign() <= 0 {
		return refuse(in, ReasonFeeCapExceeded)
	}
	if x.FeeDrops.Cmp(x.MaxFeeDrops) > 0 {
		return refuse(in, ReasonFeeCapExceeded)
	}
	if b.SigningMode == "SIGNER_LIST" && b.SignerCount < 1 {
		return refuse(in, ReasonInternalFailClosed)
	}
	multiplier := big.NewInt(1)
	if b.SigningMode == "SIGNER_LIST" {
		multiplier = big.NewInt(int64(1 + b.SignerCount))
	}
	if x.FeeDrops.Cmp(new(big.Int).Mul(x.BaseFeeDrops, multiplier)) < 0 {
		return refuse(in, ReasonFeeCapExceeded)
	}
	// 19. the obligation must still be payable: FAssets defaults only once BOTH limits have passed
	ledgerPassed := big.NewInt(int64(x.CurrentValidatedLedger)).Cmp(r.LastUnderlyingBlock) > 0
	timePassed := x.CurrentLedgerCloseTime.Cmp(r.LastUnderlyingTimestamp) > 0
	if ledgerPassed && timePassed {
		return refuse(in, ReasonExpiredWindow)
	}
	// 20. safety margin, deliberately stricter than the protocol minimum
	if x.LastLedgerSequence <= x.CurrentValidatedLedger || x.LastLedgerSequence > uint32Max {
		return refuse(in, ReasonInsufficientSafetyMargin)
	}
	if p.SafetyMarginLedgers < 0 || p.SafetyMarginSeconds == nil || p.SafetyMarginSeconds.Sign() < 0 {
		return refuse(in, ReasonInternalFailClosed)
	}
	if p.LedgerCloseIntervalSeconds == nil || p.LedgerCloseIntervalSeconds.Sign() <= 0 {
		return refuse(in, ReasonInternalFailClosed)
	}
	lastPlusMargin := new(big.Int).Add(big.NewInt(int64(x.LastLedgerSequence)), big.NewInt(int64(p.SafetyMarginLedgers)))
	if lastPlusMargin.Cmp(r.LastUnderlyingBlock) > 0 {
		return refuse(in, ReasonInsufficientSafetyMargin)
	}
	ledgersAhead := big.NewInt(int64(x.LastLedgerSequence - x.CurrentValidatedLedger))
	projected := new(big.Int).Add(x.CurrentLedgerCloseTime, new(big.Int).Mul(ledgersAhead, p.LedgerCloseIntervalSeconds))
	if new(big.Int).Add(projected, p.SafetyMarginSeconds).Cmp(r.LastUnderlyingTimestamp) > 0 {
		return refuse(in, ReasonInsufficientSafetyMargin)
	}
	// 21. the source must be the bound account
	if !canonical.IsCanonicalClassicAddress(b.XrplSourceAddress) {
		return refuse(in, ReasonInternalFailClosed)
	}
	sourceAccountID, err := canonical.DecodeClassicAddress(b.XrplSourceAddress)
	if err != nil {
		return refuse(in, ReasonInternalFailClosed)
	}
	if r.PaymentAddress == b.XrplSourceAddress {
		return refuse(in, ReasonDestinationInvalid)
	}

	tagMode := uint8(0)
	tagValue := uint32(0)
	if r.RequiresDestinationTag {
		tagMode = 1
		tagValue = uint32(r.DestinationTag.Uint64())
	}
	sequenceMode := uint8(0)
	if x.SequenceMode == "TICKET" {
		sequenceMode = 1
	}

	commitment, err := canonical.AuthorizationCommitment(canonical.AuthorizationFields{
		ObligationFields: canonical.ObligationFields{
			SchemaVersion:     uint8(in.Domain.SchemaVersion),
			FlareChainID:      in.Domain.FlareChainID,
			AssetManager:      mustAddress(in.Domain.AssetManager),
			AgentVault:        mustAddress(b.AgentVault),
			RequestID:         r.RequestID,
			RequestGeneration: uint32(r.RequestGeneration),
		},
		InstructionSender:            mustAddress(in.Domain.InstructionSender),
		XrplNetworkID:                uint32(in.Domain.XrplNetworkID),
		XrplSourceAccountID:          sourceAccountID,
		XrplSourceAddressStringHash:  canonical.Keccak256([]byte(b.XrplSourceAddress)),
		DestinationAccountID:         destinationAccountID,
		DestinationAddressStringHash: canonical.Keccak256([]byte(r.PaymentAddress)),
		DestinationTagMode:           tagMode,
		DestinationTag:               tagValue,
		AmountDrops:                  amountDrops,
		PaymentReference:             referenceBytes,
		FirstUnderlyingBlock:         r.FirstUnderlyingBlock.Uint64(),
		LastUnderlyingBlock:          r.LastUnderlyingBlock.Uint64(),
		LastUnderlyingTimestamp:      r.LastUnderlyingTimestamp.Uint64(),
		SequenceMode:                 sequenceMode,
		SequenceOrTicket:             uint32(x.SequenceOrTicket),
		LastLedgerSequence:           uint32(x.LastLedgerSequence),
		FeeDrops:                     x.FeeDrops.Uint64(),
		MaxFeeDrops:                  x.MaxFeeDrops.Uint64(),
		PolicyVersion:                uint32(p.PolicyVersion),
		ExtensionID:                  p.ExtensionID,
		ExtensionCodeHash:            mustBytes32(p.ExtensionCodeHash),
	})
	if err != nil {
		return refuse(in, ReasonInternalFailClosed)
	}

	obligation, err := canonical.ObligationHash(canonical.ObligationFields{
		SchemaVersion:     uint8(in.Domain.SchemaVersion),
		FlareChainID:      in.Domain.FlareChainID,
		AssetManager:      mustAddress(in.Domain.AssetManager),
		AgentVault:        mustAddress(b.AgentVault),
		RequestID:         r.RequestID,
		RequestGeneration: uint32(r.RequestGeneration),
	})
	if err != nil {
		return refuse(in, ReasonInternalFailClosed)
	}

	payment := &Payment{
		TransactionType:    "Payment",
		Account:            b.XrplSourceAddress,
		Destination:        r.PaymentAddress,
		Amount:             bigFromUint64(amountDrops),
		Fee:                x.FeeDrops.String(),
		Flags:              0,
		LastLedgerSequence: x.LastLedgerSequence,
		Memos:              []MemoWrapper{{Memo: Memo{MemoData: strings.ToUpper(hexOf(referenceBytes[:]))}}},
	}
	if x.SequenceMode == "TICKET" {
		ticket := x.SequenceOrTicket
		zero := 0
		payment.TicketSequence = &ticket
		payment.Sequence = &zero
	} else {
		seq := x.SequenceOrTicket
		payment.Sequence = &seq
	}
	if tagMode == 1 {
		tag := int(tagValue)
		payment.DestinationTag = &tag
	}
	if in.Domain.XrplNetworkID >= networkIDRequiredFrom {
		network := in.Domain.XrplNetworkID
		payment.NetworkID = &network
	}

	return Decision{
		Kind:                    "authorize",
		ObligationHash:          "0x" + hexOf(obligation[:]),
		AuthorizationCommitment: "0x" + hexOf(commitment[:]),
		Payment:                 payment,
	}
}

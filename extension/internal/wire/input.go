// Package wire is the single decoder for a Signet decision input.
//
// It exists so the extension binary and the conformance test cannot drift: if the binary parsed
// operator-supplied JSON through one decoder and the fixtures through another, the 62 frozen cases
// would stop being evidence about the thing that actually runs. Unknown fields are rejected,
// because a field the decoder silently drops is a field an operator believes they set.
package wire

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/signet/extension/internal/policy"
)

func bigOf(s string) *big.Int {
	if s == "" {
		return nil
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return nil
	}
	return v
}

// The fixture file serialises every bigint as a decimal string, which is what lets Go read it
// losslessly.
// InputJSON is the wire shape.
type inputJSON struct {
	Domain struct {
		SchemaVersion     int    `json:"schemaVersion"`
		FlareChainID      string `json:"flareChainId"`
		InstructionSender string `json:"instructionSender"`
		AssetManager      string `json:"assetManager"`
		XrplNetworkID     int    `json:"xrplNetworkId"`
	} `json:"domain"`
	Binding *struct {
		AgentVault        string `json:"agentVault"`
		AssetManager      string `json:"assetManager"`
		FlareChainID      string `json:"flareChainId"`
		InstructionSender string `json:"instructionSender"`
		XrplNetworkID     int    `json:"xrplNetworkId"`
		XrplSourceAddress string `json:"xrplSourceAddress"`
		SigningMode       string `json:"signingMode"`
		SignerCount       int    `json:"signerCount"`
		KeyState          string `json:"keyState"`
		Status            string `json:"status"`
		ExtensionID       string `json:"extensionId"`
		ApprovedCodeHash  string `json:"approvedCodeHash"`
		PolicyVersion     int    `json:"policyVersion"`
	} `json:"binding"`
	Redemption *struct {
		RequestID               string `json:"requestId"`
		RequestGeneration       int    `json:"requestGeneration"`
		Status                  string `json:"status"`
		AgentVault              string `json:"agentVault"`
		PaymentAddress          string `json:"paymentAddress"`
		PaymentReference        string `json:"paymentReference"`
		ValueUBA                string `json:"valueUBA"`
		FeeUBA                  string `json:"feeUBA"`
		FirstUnderlyingBlock    string `json:"firstUnderlyingBlock"`
		LastUnderlyingBlock     string `json:"lastUnderlyingBlock"`
		LastUnderlyingTimestamp string `json:"lastUnderlyingTimestamp"`
		RequiresDestinationTag  bool   `json:"requiresDestinationTag"`
		DestinationTag          string `json:"destinationTag"`
		AssetMintingDecimals    int    `json:"assetMintingDecimals"`
	} `json:"redemption"`
	Xrpl *struct {
		SequenceMode           string `json:"sequenceMode"`
		SequenceOrTicket       int    `json:"sequenceOrTicket"`
		CurrentValidatedLedger int    `json:"currentValidatedLedger"`
		CurrentLedgerCloseTime string `json:"currentLedgerCloseTime"`
		LastLedgerSequence     int    `json:"lastLedgerSequence"`
		FeeDrops               string `json:"feeDrops"`
		MaxFeeDrops            string `json:"maxFeeDrops"`
		BaseFeeDrops           string `json:"baseFeeDrops"`
	} `json:"xrpl"`
	Policy struct {
		PolicyVersion              int      `json:"policyVersion"`
		ExtensionID                string   `json:"extensionId"`
		ExtensionCodeHash          string   `json:"extensionCodeHash"`
		RevokedCodeHashes          []string `json:"revokedCodeHashes"`
		Paused                     bool     `json:"paused"`
		MinimumUnderlyingSources   int      `json:"minimumUnderlyingSources"`
		MaxObservationAgeLedgers   int      `json:"maxObservationAgeLedgers"`
		SafetyMarginLedgers        int      `json:"safetyMarginLedgers"`
		SafetyMarginSeconds        string   `json:"safetyMarginSeconds"`
		LedgerCloseIntervalSeconds string   `json:"ledgerCloseIntervalSeconds"`
	} `json:"policy"`
	Prior []struct {
		RequestGeneration int    `json:"requestGeneration"`
		SequenceMode      string `json:"sequenceMode"`
		SequenceOrTicket  int    `json:"sequenceOrTicket"`
		Outcome           string `json:"outcome"`
	} `json:"prior"`
	Underlying *struct {
		Available        bool   `json:"available"`
		Agreed           bool   `json:"agreed"`
		SourceCount      int    `json:"sourceCount"`
		ObservedAtLedger int    `json:"observedAtLedger"`
		ObservedAtTime   string `json:"observedAtTime"`
		Payments         []struct {
			TransactionHash    string `json:"transactionHash"`
			DestinationAddress string `json:"destinationAddress"`
			AmountDrops        string `json:"amountDrops"`
			PaymentReference   string `json:"paymentReference"`
			Validated          bool   `json:"validated"`
		} `json:"payments"`
	} `json:"underlying"`
}

func Decode(raw []byte) (policy.Input, error) {
	var j inputJSON
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&j); err != nil {
		return policy.Input{}, fmt.Errorf("wire: %w", err)
	}

	in := policy.Input{
		Domain: policy.Domain{
			SchemaVersion:     j.Domain.SchemaVersion,
			FlareChainID:      bigOf(j.Domain.FlareChainID),
			InstructionSender: j.Domain.InstructionSender,
			AssetManager:      j.Domain.AssetManager,
			XrplNetworkID:     j.Domain.XrplNetworkID,
		},
		Policy: policy.Policy{
			PolicyVersion:              j.Policy.PolicyVersion,
			ExtensionID:                bigOf(j.Policy.ExtensionID),
			ExtensionCodeHash:          j.Policy.ExtensionCodeHash,
			RevokedCodeHashes:          j.Policy.RevokedCodeHashes,
			Paused:                     j.Policy.Paused,
			SafetyMarginLedgers:        j.Policy.SafetyMarginLedgers,
			SafetyMarginSeconds:        bigOf(j.Policy.SafetyMarginSeconds),
			LedgerCloseIntervalSeconds: bigOf(j.Policy.LedgerCloseIntervalSeconds),
			MinimumUnderlyingSources:   j.Policy.MinimumUnderlyingSources,
			MaxObservationAgeLedgers:   j.Policy.MaxObservationAgeLedgers,
		},
	}
	if j.Binding != nil {
		in.Binding = &policy.Binding{
			AgentVault:        j.Binding.AgentVault,
			AssetManager:      j.Binding.AssetManager,
			FlareChainID:      bigOf(j.Binding.FlareChainID),
			InstructionSender: j.Binding.InstructionSender,
			XrplNetworkID:     j.Binding.XrplNetworkID,
			XrplSourceAddress: j.Binding.XrplSourceAddress,
			SigningMode:       j.Binding.SigningMode,
			SignerCount:       j.Binding.SignerCount,
			KeyState:          j.Binding.KeyState,
			Status:            j.Binding.Status,
			ExtensionID:       bigOf(j.Binding.ExtensionID),
			ApprovedCodeHash:  j.Binding.ApprovedCodeHash,
			PolicyVersion:     j.Binding.PolicyVersion,
		}
	}
	if j.Redemption != nil {
		in.Redemption = &policy.Redemption{
			RequestID:               bigOf(j.Redemption.RequestID),
			RequestGeneration:       j.Redemption.RequestGeneration,
			Status:                  j.Redemption.Status,
			AgentVault:              j.Redemption.AgentVault,
			PaymentAddress:          j.Redemption.PaymentAddress,
			PaymentReference:        j.Redemption.PaymentReference,
			ValueUBA:                bigOf(j.Redemption.ValueUBA),
			FeeUBA:                  bigOf(j.Redemption.FeeUBA),
			FirstUnderlyingBlock:    bigOf(j.Redemption.FirstUnderlyingBlock),
			LastUnderlyingBlock:     bigOf(j.Redemption.LastUnderlyingBlock),
			LastUnderlyingTimestamp: bigOf(j.Redemption.LastUnderlyingTimestamp),
			RequiresDestinationTag:  j.Redemption.RequiresDestinationTag,
			DestinationTag:          bigOf(j.Redemption.DestinationTag),
			AssetMintingDecimals:    j.Redemption.AssetMintingDecimals,
		}
	}
	if j.Xrpl != nil {
		in.Xrpl = &policy.XrplAllocation{
			SequenceMode:           j.Xrpl.SequenceMode,
			SequenceOrTicket:       j.Xrpl.SequenceOrTicket,
			CurrentValidatedLedger: j.Xrpl.CurrentValidatedLedger,
			CurrentLedgerCloseTime: bigOf(j.Xrpl.CurrentLedgerCloseTime),
			LastLedgerSequence:     j.Xrpl.LastLedgerSequence,
			FeeDrops:               bigOf(j.Xrpl.FeeDrops),
			MaxFeeDrops:            bigOf(j.Xrpl.MaxFeeDrops),
			BaseFeeDrops:           bigOf(j.Xrpl.BaseFeeDrops),
		}
	}
	for _, p := range j.Prior {
		in.Prior = append(in.Prior, policy.PriorGeneration{
			RequestGeneration: p.RequestGeneration,
			SequenceMode:      p.SequenceMode,
			SequenceOrTicket:  p.SequenceOrTicket,
			Outcome:           p.Outcome,
		})
	}
	if j.Underlying != nil {
		observation := &policy.UnderlyingObservation{
			Available:        j.Underlying.Available,
			Agreed:           j.Underlying.Agreed,
			SourceCount:      j.Underlying.SourceCount,
			ObservedAtLedger: j.Underlying.ObservedAtLedger,
			ObservedAtTime:   bigOf(j.Underlying.ObservedAtTime),
		}
		for _, p := range j.Underlying.Payments {
			observation.Payments = append(observation.Payments, policy.ObservedUnderlyingPayment{
				TransactionHash:    p.TransactionHash,
				DestinationAddress: p.DestinationAddress,
				AmountDrops:        bigOf(p.AmountDrops),
				PaymentReference:   p.PaymentReference,
				Validated:          p.Validated,
			})
		}
		in.Underlying = observation
	}
	return in, nil
}

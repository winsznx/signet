// Package conformance holds the Go extension to the reference model's frozen fixtures.
//
// This is the test that makes I-016 real. The reference model is the specification; if Go and
// TypeScript disagree on any of the 62 cases, one of them is wrong and the extension must not ship
// until it is known which. Nothing here reimplements the expected values: they are read from
// reference/test-vectors/decision-fixtures.json, which is itself byte-compared against a fresh
// build by the TypeScript suite.
package conformance

import (
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	"github.com/signet/extension/internal/policy"
)

type fixtureFile struct {
	FormatVersion               int       `json:"formatVersion"`
	SchemaVersion               int       `json:"schemaVersion"`
	ObligationDomain            string    `json:"obligationDomain"`
	AuthorizationDomain         string    `json:"authorizationDomain"`
	ObligationPreimageLength    int       `json:"obligationPreimageLength"`
	AuthorizationPreimageLength int       `json:"authorizationPreimageLength"`
	FixtureSetHash              string    `json:"fixtureSetHash"`
	Fixtures                    []fixture `json:"fixtures"`
}

type fixture struct {
	ID       string          `json:"id"`
	Intent   string          `json:"intent"`
	Input    json.RawMessage `json:"input"`
	Expected expectedJSON    `json:"expected"`
}

type expectedJSON struct {
	Kind                    string          `json:"kind"`
	ObligationHash          string          `json:"obligationHash"`
	AuthorizationCommitment string          `json:"authorizationCommitment"`
	Reason                  string          `json:"reason"`
	ErrorClass              string          `json:"errorClass"`
	TxTemplate              json.RawMessage `json:"txTemplate"`
}

// The fixture file serialises every bigint as a decimal string, which is what lets Go read it
// losslessly.
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
}

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

func toInput(t *testing.T, raw json.RawMessage) policy.Input {
	t.Helper()
	var j inputJSON
	if err := json.Unmarshal(raw, &j); err != nil {
		t.Fatalf("decode fixture input: %v", err)
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
	return in
}

func loadFixtures(t *testing.T) fixtureFile {
	t.Helper()
	path := filepath.Join("..", "..", "..", "reference", "test-vectors", "decision-fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var file fixtureFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("decode fixtures: %v", err)
	}
	if len(file.Fixtures) == 0 {
		t.Fatal("fixture file is empty")
	}
	return file
}

func TestGoAgreesWithTheReferenceModelOnEveryFixture(t *testing.T) {
	file := loadFixtures(t)
	t.Logf("checking %d fixtures against fixtureSetHash %s", len(file.Fixtures), file.FixtureSetHash)

	for _, f := range file.Fixtures {
		t.Run(f.ID, func(t *testing.T) {
			got := policy.Decide(toInput(t, f.Input))

			if got.Kind != f.Expected.Kind {
				t.Fatalf("kind: go=%s reference=%s (%s)", got.Kind, f.Expected.Kind, f.Intent)
			}
			if got.ObligationHash != f.Expected.ObligationHash {
				t.Errorf("obligationHash:\n  go        %s\n  reference %s", got.ObligationHash, f.Expected.ObligationHash)
			}

			switch f.Expected.Kind {
			case "refuse":
				if got.Reason != f.Expected.Reason {
					t.Errorf("reason: go=%s reference=%s", got.Reason, f.Expected.Reason)
				}
				if got.ErrorClass != f.Expected.ErrorClass {
					t.Errorf("errorClass: go=%s reference=%s", got.ErrorClass, f.Expected.ErrorClass)
				}
				if got.AuthorizationCommitment != "" {
					t.Error("a refusal must carry no authorization commitment")
				}
				if got.Payment != nil {
					t.Error("a refusal must carry no transaction template")
				}
			case "authorize":
				if got.AuthorizationCommitment != f.Expected.AuthorizationCommitment {
					t.Errorf("commitment:\n  go        %s\n  reference %s",
						got.AuthorizationCommitment, f.Expected.AuthorizationCommitment)
				}
				assertTemplateMatches(t, got.Payment, f.Expected.TxTemplate)
			}
		})
	}
}

// assertTemplateMatches compares the Go transaction against the reference model's, field by field,
// through JSON so that an omitted optional field on one side and a zero value on the other is a
// difference rather than a match.
func assertTemplateMatches(t *testing.T, got *policy.Payment, expectedRaw json.RawMessage) {
	t.Helper()
	if got == nil {
		t.Fatal("authorization produced no transaction template")
	}
	gotRaw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal go template: %v", err)
	}
	var gotMap, expectedMap map[string]any
	if err := json.Unmarshal(gotRaw, &gotMap); err != nil {
		t.Fatalf("decode go template: %v", err)
	}
	if err := json.Unmarshal(expectedRaw, &expectedMap); err != nil {
		t.Fatalf("decode reference template: %v", err)
	}

	for key, want := range expectedMap {
		have, present := gotMap[key]
		if !present {
			t.Errorf("template field %s missing in go output (reference has %v)", key, want)
			continue
		}
		if normalise(have) != normalise(want) {
			t.Errorf("template field %s: go=%v reference=%v", key, have, want)
		}
	}
	for key := range gotMap {
		if _, present := expectedMap[key]; !present {
			t.Errorf("template field %s present in go output but not in the reference", key)
		}
	}
}

func normalise(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestEncodingConstantsMatchTheFixtureFile(t *testing.T) {
	file := loadFixtures(t)
	if file.ObligationPreimageLength != 141 || file.AuthorizationPreimageLength != 431 {
		t.Fatalf("preimage lengths drifted: obligation=%d authorization=%d",
			file.ObligationPreimageLength, file.AuthorizationPreimageLength)
	}
	if file.ObligationDomain != "SIGNET_FASSETS_OBLIGATION_V1" ||
		file.AuthorizationDomain != "SIGNET_FASSETS_REDEMPTION_V1" {
		t.Fatal("domain strings drifted")
	}
	if file.SchemaVersion != policy.SchemaVersion {
		t.Fatalf("schema version: fixtures=%d go=%d", file.SchemaVersion, policy.SchemaVersion)
	}
}

func TestEveryReasonCodeInTheFixturesIsProducibleByGo(t *testing.T) {
	file := loadFixtures(t)
	seen := map[string]bool{}
	for _, f := range file.Fixtures {
		if f.Expected.Kind != "refuse" {
			continue
		}
		got := policy.Decide(toInput(t, f.Input))
		if got.Kind == "refuse" {
			seen[got.Reason] = true
		}
	}
	if len(seen) < 15 {
		t.Fatalf("go produced only %d distinct reason codes across the fixtures", len(seen))
	}
}

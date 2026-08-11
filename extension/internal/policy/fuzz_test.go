package policy

import (
	"math/big"
	"testing"
)

// FuzzDecideIsTotal is the fail-closed guarantee under fuzzing.
//
// Decide promises to return either an authorization or a typed refusal for every input, never a
// panic and never an empty answer. That promise is what lets the extension be a trust boundary: a
// caller that can crash the decider can stop payments, and a caller that can make it return nothing
// can make a coordinator guess.
//
// The fields fuzzed are the ones an attacker most plausibly controls through a compromised
// coordinator: amounts, generations, ledger positions and status strings.
func FuzzDecideIsTotal(f *testing.F) {
	f.Add(int64(10_000_000), int64(50_000), 0, 100, "ACTIVE", 2, 100, true)
	f.Add(int64(0), int64(0), -1, 0, "", 0, 0, false)
	f.Add(int64(-1), int64(-1), 2147483647, -2147483648, "SUCCESSFUL", -1, -1, true)
	f.Add(int64(1), int64(1), 1, 1, "\x00\xff", 255, 2147483647, false)
	f.Add(int64(10_000_000), int64(50_000), 0, 100, "ACTIVE", 2, 100, false)

	f.Fuzz(func(t *testing.T, value, fee int64, generation, ledger int, status string, sourceCount, observedAt int, observedPayment bool) {
		in := Input{
			Domain: Domain{
				SchemaVersion:     SchemaVersion,
				FlareChainID:      big.NewInt(114),
				InstructionSender: "0x00000000000000000000000000000000000000c1",
				AssetManager:      "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA",
				XrplNetworkID:     1,
			},
			Redemption: &Redemption{
				RequestID:               big.NewInt(1),
				RequestGeneration:       generation,
				Status:                  status,
				AgentVault:              "0x000000000000000000000000000000000000dEaD",
				PaymentAddress:          "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb",
				ValueUBA:                big.NewInt(value),
				FeeUBA:                  big.NewInt(fee),
				FirstUnderlyingBlock:    big.NewInt(int64(ledger)),
				LastUnderlyingBlock:     big.NewInt(int64(ledger) + 100),
				LastUnderlyingTimestamp: big.NewInt(int64(ledger)),
				AssetMintingDecimals:    6,
			},
			Policy: Policy{
				PolicyVersion:              1,
				ExtensionID:                big.NewInt(1),
				ExtensionCodeHash:          "0x1111111111111111111111111111111111111111111111111111111111111111",
				SafetyMarginLedgers:        50,
				SafetyMarginSeconds:        big.NewInt(300),
				LedgerCloseIntervalSeconds: big.NewInt(4),
			},
		}

		// The V2 observation is fuzzed too: source counts, observed ledgers and the presence of a
		// matching payment are all attacker-influenced through a compromised coordinator, and the
		// decision must stay total across every combination of them.
		observation := &UnderlyingObservation{
			Available:        true,
			Agreed:           true,
			SourceCount:      sourceCount,
			ObservedAtLedger: observedAt,
			ObservedAtTime:   big.NewInt(int64(observedAt)),
		}
		if observedPayment {
			observation.Payments = []ObservedUnderlyingPayment{{
				TransactionHash:    "0x" + "ab",
				DestinationAddress: "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb",
				AmountDrops:        big.NewInt(value),
				PaymentReference:   "0x4642505266410002000000000000000000000000000000000000000000000001",
				Validated:          true,
			}}
		}
		in.Underlying = observation
		in.Policy.MinimumUnderlyingSources = 1
		in.Policy.MaxObservationAgeLedgers = 100

		d := Decide(in)
		if d.Kind != "authorize" && d.Kind != "refuse" {
			t.Fatalf("Decide returned neither an authorization nor a refusal: %q", d.Kind)
		}
		if d.Kind == "refuse" && d.Reason == "" {
			t.Fatal("a refusal must carry a reason code; an unexplained denial is not a typed refusal")
		}
		if d.ObligationHash == "" {
			t.Fatal("every decision must name an obligation, even a refusal")
		}
	})
}

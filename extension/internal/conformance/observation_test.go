package conformance

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/signet/extension/internal/canonical"
)

// TestObservationRootMatchesTheReferenceModel is a differential test over the one part of the V2
// encoding that is not fixed-width.
//
// The two implementations sort the match list differently by construction: TypeScript compares
// lowercased hex strings, Go compares the decoded 32 bytes. For well-formed hashes those orders are
// identical, which is exactly the kind of "obviously fine" that is worth proving rather than
// assuming. The cases below include the ones where a string sort and a byte sort could diverge:
// mixed case, a hash beginning with 0x00, and hashes differing only in the last byte.
func TestObservationRootMatchesTheReferenceModel(t *testing.T) {
	type payment struct {
		TransactionHash string `json:"transactionHash"`
		AmountDrops     string `json:"amountDrops"`
	}
	type input struct {
		Available        bool      `json:"available"`
		Agreed           bool      `json:"agreed"`
		ObservedAtLedger int       `json:"observedAtLedger"`
		ObservedAtTime   string    `json:"observedAtTime"`
		SourceCount      int       `json:"sourceCount"`
		Payments         []payment `json:"payments"`
	}

	hash := func(s string) string { return "0x" + s }
	cases := []input{
		{true, true, 19_800_010, "1800000020", 2, nil},
		{true, true, 19_800_010, "1800000020", 2, []payment{}},
		{false, true, 1, "0", 0, nil},
		{true, false, 1, "0", 0, nil},
		{false, false, 4294967295, "18446744073709551615", 255, nil},
		{true, true, 5, "7", 2, []payment{{hash(repeat("ab", 32)), "9950000"}}},
		// Mixed case: a string sort on unlowered hex would order these differently from a byte sort.
		{true, true, 5, "7", 2, []payment{
			{"0x" + repeat("AB", 32), "1"},
			{"0x" + repeat("ac", 32), "2"},
		}},
		// A leading zero byte sorts first either way, but only if the string sort is on the hex.
		{true, true, 5, "7", 2, []payment{
			{"0x" + repeat("ff", 32), "1"},
			{"0x00" + repeat("ff", 31), "2"},
		}},
		// Differing only in the final byte.
		{true, true, 5, "7", 3, []payment{
			{"0x" + repeat("11", 31) + "ff", "1"},
			{"0x" + repeat("11", 31) + "00", "2"},
			{"0x" + repeat("11", 31) + "80", "3"},
		}},
		// Reversed input order must produce the same root as the sorted one above.
		{true, true, 5, "7", 3, []payment{
			{"0x" + repeat("11", 31) + "80", "3"},
			{"0x" + repeat("11", 31) + "00", "2"},
			{"0x" + repeat("11", 31) + "ff", "1"},
		}},
	}

	script := filepath.Join("..", "..", "..", "reference", "src", "observation-root.ts")
	if _, err := os.Stat(script); err != nil {
		t.Skipf("reference helper not present: %v", err)
	}

	for i, c := range cases {
		raw, err := json.Marshal(c)
		if err != nil {
			t.Fatalf("case %d: marshal: %v", i, err)
		}

		cmd := exec.Command("node", "--experimental-strip-types", script)
		cmd.Stdin = bytesReader(raw)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("case %d: reference helper: %v", i, err)
		}
		var expected struct {
			Root string `json:"root"`
		}
		if err := json.Unmarshal(out, &expected); err != nil {
			t.Fatalf("case %d: decode: %v", i, err)
		}

		converted := make([]canonical.ObservedPayment, 0, len(c.Payments))
		for _, p := range c.Payments {
			converted = append(converted, canonical.ObservedPayment{
				TransactionHash: mustHash(t, p.TransactionHash),
				AmountDrops:     mustUint(t, p.AmountDrops),
			})
		}
		got := canonical.ObservationRoot(
			c.Available, c.Agreed, uint32(c.ObservedAtLedger), mustUint(t, c.ObservedAtTime), uint8(c.SourceCount), converted,
		)
		if "0x"+hexOf(got[:]) != expected.Root {
			t.Fatalf("case %d: go=%s reference=%s", i, "0x"+hexOf(got[:]), expected.Root)
		}
	}
}

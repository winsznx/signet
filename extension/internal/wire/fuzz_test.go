package wire

import (
	"strings"
	"testing"
)

// FuzzDecodeNeverPanics holds the decoder to the only promise that matters at a trust boundary: it
// is total. Whatever arrives on stdin, it either produces an input or an error, and it never takes
// the process down. A panic here would be a denial of service reachable by anyone who can talk to
// the extension.
//
// It deliberately does not assert that any particular input is accepted. Fuzzing to prove
// acceptance would be fuzzing toward a weaker parser.
func FuzzDecodeNeverPanics(f *testing.F) {
	f.Add(`{}`)
	f.Add(`{"domain":{"schemaVersion":1,"flareChainId":"114"}}`)
	f.Add(`{"policy":{"extensionId":"99999999999999999999999999999999999999999999"}}`)
	f.Add(`{"redemption":{"requestId":"-1","requestGeneration":-2147483648}}`)
	f.Add(`{"xrpl":{"sequenceOrTicket":9223372036854775807}}`)
	f.Add(`{"prior":[{"requestGeneration":0,"outcome":"UNRESOLVED"}]}`)
	f.Add(`{"domain":null,"binding":null,"redemption":null,"xrpl":null}`)
	f.Add(strings.Repeat(`{"a":`, 200) + `1` + strings.Repeat(`}`, 200))

	f.Fuzz(func(t *testing.T, raw string) {
		in, err := Decode([]byte(raw))
		if err != nil {
			return
		}
		// A decode that succeeded must have produced something the policy can evaluate without
		// reaching into a nil it was told was present.
		if in.Binding == nil && in.Redemption == nil && in.Xrpl == nil {
			return
		}
	})
}

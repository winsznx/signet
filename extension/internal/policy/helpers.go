package policy

import (
	"encoding/hex"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

var addressPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

func isAddress(s string) bool { return addressPattern.MatchString(s) }

func hexOf(b []byte) string { return hex.EncodeToString(b) }

func mustAddress(s string) [20]byte {
	var out [20]byte
	clean := strings.TrimPrefix(strings.ToLower(s), "0x")
	if len(clean) != 40 {
		return out
	}
	b, err := hex.DecodeString(clean)
	if err != nil {
		return out
	}
	copy(out[:], b)
	return out
}

// mustBytes32 returns the zero value for a malformed input.
//
// That is safe only where the caller has already validated the string, or where the zero value
// cannot change a decision. It is NOT safe for anything that feeds a commitment: a security review
// found that a malformed observation hash was silently becoming 32 zero bytes here while the
// reference model threw and refused S020_INTERNAL_FAIL_CLOSED, so Go authorized a payment the
// specification rejects. Anything that reaches an encoder must use bytes32 and handle the error.
func mustBytes32(s string) [32]byte {
	out, _ := bytes32(s)
	return out
}

// bytes32 parses a 32-byte hex string, reporting failure rather than absorbing it.
func bytes32(s string) ([32]byte, bool) {
	var out [32]byte
	clean := strings.TrimPrefix(strings.ToLower(s), "0x")
	if len(clean) != 64 {
		return out, false
	}
	b, err := hex.DecodeString(clean)
	if err != nil {
		return out, false
	}
	copy(out[:], b)
	return out, true
}

func hexTo32(s string) ([32]byte, bool) {
	var out [32]byte
	clean := strings.TrimPrefix(strings.ToLower(s), "0x")
	if len(clean) != 64 {
		return out, false
	}
	b, err := hex.DecodeString(clean)
	if err != nil {
		return out, false
	}
	copy(out[:], b)
	return out, true
}

func bigFromUint64(v uint64) string { return strconv.FormatUint(v, 10) }

// xrpDropDecimals is fixed by the ledger: a drop is 1e-6 XRP.
const xrpDropDecimals = 6

// maxXrpDrops bounds any lawful payment.
var maxXrpDrops = new(big.Int).Mul(big.NewInt(100_000_000_000), big.NewInt(1_000_000))

// obligationAmountDrops converts value less fee into drops, exactly or not at all.
//
// Rounding is never acceptable here. FAssets requires at least value minus fee, so rounding down
// underpays and fails confirmation, while rounding up spends more of the agent's XRP than the
// obligation requires.
func obligationAmountDrops(valueUBA, feeUBA *big.Int, decimals int) (uint64, bool) {
	if valueUBA == nil || feeUBA == nil {
		return 0, false
	}
	if valueUBA.Sign() <= 0 || feeUBA.Sign() < 0 || feeUBA.Cmp(valueUBA) >= 0 {
		return 0, false
	}
	if decimals < 0 || decimals > 30 {
		return 0, false
	}
	payable := new(big.Int).Sub(valueUBA, feeUBA)

	var drops *big.Int
	if decimals >= xrpDropDecimals {
		divisor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals-xrpDropDecimals)), nil)
		quotient, remainder := new(big.Int).QuoRem(payable, divisor, new(big.Int))
		if remainder.Sign() != 0 {
			return 0, false
		}
		drops = quotient
	} else {
		multiplier := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(xrpDropDecimals-decimals)), nil)
		drops = new(big.Int).Mul(payable, multiplier)
	}
	if drops.Sign() <= 0 || drops.Cmp(maxXrpDrops) > 0 || !drops.IsUint64() {
		return 0, false
	}
	return drops.Uint64(), true
}

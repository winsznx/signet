package canonical

import (
	"crypto/sha256"
	"errors"
	"math/big"
)

// XrplAlphabet is XRPL's base58 dictionary, which is not Bitcoin's.
const XrplAlphabet = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"

var ErrXrplAddress = errors.New("canonical: not a canonical XRPL classic address")

const (
	accountIDPrefix = 0x00
	accountIDLength = 20
)

func base58Decode(s string) ([]byte, bool) {
	if len(s) == 0 {
		return nil, false
	}
	value := big.NewInt(0)
	base := big.NewInt(58)
	for _, ch := range s {
		idx := -1
		for i, a := range XrplAlphabet {
			if a == ch {
				idx = i
				break
			}
		}
		if idx < 0 {
			return nil, false
		}
		value.Mul(value, base)
		value.Add(value, big.NewInt(int64(idx)))
	}
	body := value.Bytes()

	leading := 0
	for _, ch := range s {
		if ch != rune(XrplAlphabet[0]) {
			break
		}
		leading++
	}
	out := make([]byte, leading+len(body))
	copy(out[leading:], body)
	return out, true
}

func base58Encode(b []byte) string {
	value := new(big.Int).SetBytes(b)
	base := big.NewInt(58)
	zero := big.NewInt(0)
	mod := new(big.Int)
	out := make([]byte, 0, len(b)*2)
	for value.Cmp(zero) > 0 {
		value.DivMod(value, base, mod)
		out = append([]byte{XrplAlphabet[mod.Int64()]}, out...)
	}
	for _, c := range b {
		if c != 0 {
			break
		}
		out = append([]byte{XrplAlphabet[0]}, out...)
	}
	return string(out)
}

func doubleSha256(b []byte) []byte {
	first := sha256.Sum256(b)
	second := sha256.Sum256(first[:])
	return second[:]
}

// DecodeClassicAddress returns the 20-byte AccountID for a classic r-address.
// It validates the base58check checksum and the type prefix, and never repairs its input.
func DecodeClassicAddress(address string) ([20]byte, error) {
	var out [20]byte
	raw, ok := base58Decode(address)
	if !ok || len(raw) != 1+accountIDLength+4 {
		return out, ErrXrplAddress
	}
	body := raw[:1+accountIDLength]
	provided := raw[1+accountIDLength:]
	if body[0] != accountIDPrefix {
		return out, ErrXrplAddress
	}
	expected := doubleSha256(body)[:4]
	for i := range provided {
		if provided[i] != expected[i] {
			return out, ErrXrplAddress
		}
	}
	copy(out[:], body[1:])
	return out, nil
}

// EncodeClassicAddress is the inverse, used to prove a decode round-trips.
func EncodeClassicAddress(accountID [20]byte) string {
	body := make([]byte, 0, 1+accountIDLength)
	body = append(body, accountIDPrefix)
	body = append(body, accountID[:]...)
	full := append(body, doubleSha256(body)[:4]...)
	return base58Encode(full)
}

// IsCanonicalClassicAddress requires an exact round-trip, which rejects non-canonical encodings
// that would otherwise decode successfully.
func IsCanonicalClassicAddress(address string) bool {
	id, err := DecodeClassicAddress(address)
	if err != nil {
		return false
	}
	return EncodeClassicAddress(id) == address
}

// RedemptionPaymentReference mirrors the pinned FAssets derivation:
// redemption(id) = bytes32(id | (0x4642505266410002 << 192)).
func RedemptionPaymentReference(requestID *big.Int) ([32]byte, error) {
	var out [32]byte
	if requestID == nil || requestID.Sign() <= 0 {
		return out, errors.New("canonical: request id must be positive")
	}
	maxID := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 64), big.NewInt(1))
	if requestID.Cmp(maxID) > 0 {
		return out, errors.New("canonical: request id exceeds uint64")
	}
	typeBits := new(big.Int).Lsh(big.NewInt(0x4642505266410002), 192)
	value := new(big.Int).Or(new(big.Int).Set(requestID), typeBits)
	b := value.Bytes()
	copy(out[32-len(b):], b)
	return out, nil
}

package conformance

import (
	"bytes"
	"encoding/hex"
	"io"
	"strconv"
	"strings"
	"testing"
)

func repeat(s string, n int) string { return strings.Repeat(s, n) }

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

func hexOf(b []byte) string { return hex.EncodeToString(b) }

func mustHash(t *testing.T, s string) [32]byte {
	t.Helper()
	var out [32]byte
	raw, err := hex.DecodeString(strings.TrimPrefix(strings.ToLower(s), "0x"))
	if err != nil || len(raw) != 32 {
		t.Fatalf("not a 32-byte hash: %q", s)
	}
	copy(out[:], raw)
	return out
}

func mustUint(t *testing.T, s string) uint64 {
	t.Helper()
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		t.Fatalf("not a uint64: %q", s)
	}
	return v
}

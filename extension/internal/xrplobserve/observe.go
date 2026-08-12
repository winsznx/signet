// Package xrplobserve is the extension's own view of the XRP ledger.
//
// It is a second implementation of `scripts/xrpl/observe.mjs`, and that duplication is the point.
// The script's observation is taken by the coordinator, which is untrusted; this one is taken inside
// the extension, which is the boundary that signs. An observation supplied by the party that wants
// the signature is worth nothing, because an empty list is exactly what it would send.
//
// The three rules are the script's, restated because they are what make the check worth having:
// every endpoint is asked and they must agree, absence is only reported by a source whose history
// covers the window, and failure is reported as failure rather than degrading to an empty result.
package xrplobserve

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/signet/extension/internal/policy"
)

const (
	defaultLookback = 400
	maxPages        = 25
	requestTimeout  = 30 * time.Second
)

type Observer struct {
	Endpoints []string
	Client    *http.Client
}

func New(endpoints []string) *Observer {
	return &Observer{Endpoints: endpoints, Client: &http.Client{Timeout: requestTimeout}}
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
}

func (o *Observer) call(ctx context.Context, endpoint, method string, params any) (json.RawMessage, error) {
	body, err := json.Marshal(map[string]any{"method": method, "params": []any{params}})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")

	response, err := o.Client.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", endpoint, response.StatusCode)
	}
	var decoded rpcResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return nil, err
	}
	var probe struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(decoded.Result, &probe); err == nil && probe.Error != "" {
		return nil, fmt.Errorf("%s: %s", endpoint, probe.Error)
	}
	return decoded.Result, nil
}

// coversSpan parses rippled's `complete_ledgers` and reports whether one range covers the window.
// An endpoint that never held these ledgers cannot testify that nothing happened in them.
func coversSpan(completeLedgers string, from, to int64) bool {
	if completeLedgers == "" || completeLedgers == "empty" {
		return false
	}
	for _, part := range strings.Split(completeLedgers, ",") {
		bounds := strings.SplitN(strings.TrimSpace(part), "-", 2)
		low, err := strconv.ParseInt(strings.TrimSpace(bounds[0]), 10, 64)
		if err != nil {
			continue
		}
		high := low
		if len(bounds) == 2 {
			if parsed, err := strconv.ParseInt(strings.TrimSpace(bounds[1]), 10, 64); err == nil {
				high = parsed
			}
		}
		if low <= from && high >= to {
			return true
		}
	}
	return false
}

type answer struct {
	payments    []policy.ObservedUnderlyingPayment
	ledgerIndex int
}

func (o *Observer) observeFrom(ctx context.Context, endpoint, destination, reference string, from, to int64) *answer {
	info, err := o.call(ctx, endpoint, "server_info", map[string]any{})
	if err != nil {
		return nil
	}
	var serverInfo struct {
		Info struct {
			CompleteLedgers string `json:"complete_ledgers"`
		} `json:"info"`
	}
	if err := json.Unmarshal(info, &serverInfo); err != nil {
		return nil
	}
	if !coversSpan(serverInfo.Info.CompleteLedgers, from, to) {
		return nil
	}

	wanted := strings.ToLower(strings.TrimPrefix(reference, "0x"))
	found := make([]policy.ObservedUnderlyingPayment, 0, 2)
	ledgerIndex := int(to)
	var marker json.RawMessage

	for page := 0; page < maxPages; page++ {
		params := map[string]any{
			"account": destination, "ledger_index_min": from, "ledger_index_max": to,
			"limit": 400, "binary": false,
		}
		if marker != nil {
			params["marker"] = marker
		}
		raw, err := o.call(ctx, endpoint, "account_tx", params)
		if err != nil {
			return nil
		}
		var page1 struct {
			Transactions []struct {
				Hash      string          `json:"hash"`
				Validated bool            `json:"validated"`
				Meta      json.RawMessage `json:"meta"`
				TxJSON    json.RawMessage `json:"tx_json"`
				Tx        json.RawMessage `json:"tx"`
			} `json:"transactions"`
			LedgerIndexMax int             `json:"ledger_index_max"`
			Marker         json.RawMessage `json:"marker"`
		}
		if err := json.Unmarshal(raw, &page1); err != nil {
			return nil
		}
		if page1.LedgerIndexMax != 0 {
			ledgerIndex = page1.LedgerIndexMax
		}

		for _, entry := range page1.Transactions {
			body := entry.TxJSON
			if len(body) == 0 {
				body = entry.Tx
			}
			if len(body) == 0 {
				continue
			}
			var tx struct {
				TransactionType string `json:"TransactionType"`
				Destination     string `json:"Destination"`
				Amount          string `json:"Amount"`
				Memos           []struct {
					Memo struct {
						MemoData string `json:"MemoData"`
					} `json:"Memo"`
				} `json:"Memos"`
			}
			if err := json.Unmarshal(body, &tx); err != nil {
				continue
			}
			if tx.TransactionType != "Payment" || tx.Destination != destination {
				continue
			}
			if len(tx.Memos) == 0 || strings.ToLower(tx.Memos[0].Memo.MemoData) != wanted {
				continue
			}
			amount, ok := new(big.Int).SetString(tx.Amount, 10)
			if !ok {
				amount = big.NewInt(0)
			}
			found = append(found, policy.ObservedUnderlyingPayment{
				TransactionHash:    "0x" + strings.ToLower(entry.Hash),
				DestinationAddress: tx.Destination,
				AmountDrops:        amount,
				PaymentReference:   "0x" + wanted,
				// Only a validated payment counts. A provisional one is not a result.
				Validated: entry.Validated,
			})
		}

		if page1.Marker == nil {
			break
		}
		marker = page1.Marker
		if page == maxPages-1 {
			// Ran out of pages rather than out of data. A partial answer is the false empty this
			// package exists to never produce.
			return nil
		}
	}

	sort.Slice(found, func(i, j int) bool { return found[i].TransactionHash < found[j].TransactionHash })
	return &answer{payments: found, ledgerIndex: ledgerIndex}
}

func fingerprint(payments []policy.ObservedUnderlyingPayment) string {
	parts := make([]string, 0, len(payments))
	for _, p := range payments {
		parts = append(parts, fmt.Sprintf("%s|%s|%t", p.TransactionHash, p.AmountDrops, p.Validated))
	}
	return strings.Join(parts, ",")
}

// AccountState is the operational XRPL state a payment needs: sequence, ledger position and fee.
//
// It is read from the first endpoint that answers rather than requiring agreement, and that is a
// deliberate asymmetry. These values cannot change what is paid or to whom; a wrong one produces a
// transaction that fails to validate, which is a liveness problem. The observation, which can change
// whether a payment happens at all, requires agreement.
type AccountState struct {
	Sequence        int
	ValidatedLedger int
	CloseTime       *big.Int
	FeeDrops        *big.Int
	BaseFeeDrops    *big.Int
}

func (o *Observer) AccountState(ctx context.Context, account string) (*AccountState, error) {
	for _, endpoint := range o.Endpoints {
		infoRaw, err := o.call(ctx, endpoint, "account_info", map[string]any{"account": account, "ledger_index": "validated"})
		if err != nil {
			continue
		}
		var info struct {
			AccountData struct {
				Sequence int `json:"Sequence"`
			} `json:"account_data"`
			LedgerIndex int `json:"ledger_index"`
		}
		if err := json.Unmarshal(infoRaw, &info); err != nil {
			continue
		}

		feeRaw, err := o.call(ctx, endpoint, "fee", map[string]any{})
		if err != nil {
			continue
		}
		var fee struct {
			Drops struct {
				BaseFee       string `json:"base_fee"`
				OpenLedgerFee string `json:"open_ledger_fee"`
			} `json:"drops"`
		}
		if err := json.Unmarshal(feeRaw, &fee); err != nil {
			continue
		}
		base, _ := new(big.Int).SetString(fee.Drops.BaseFee, 10)
		open, _ := new(big.Int).SetString(fee.Drops.OpenLedgerFee, 10)
		if base == nil {
			base = big.NewInt(10)
		}
		if open == nil || open.Cmp(base) < 0 {
			open = base
		}

		ledgerRaw, err := o.call(ctx, endpoint, "ledger", map[string]any{"ledger_index": "validated"})
		closeTime := big.NewInt(time.Now().Unix())
		if err == nil {
			var ledger struct {
				Ledger struct {
					CloseTime int64 `json:"close_time"`
				} `json:"ledger"`
			}
			if json.Unmarshal(ledgerRaw, &ledger) == nil && ledger.Ledger.CloseTime > 0 {
				// XRPL close times are seconds since the Ripple epoch, 2000-01-01.
				closeTime = big.NewInt(ledger.Ledger.CloseTime + 946684800)
			}
		}

		return &AccountState{
			Sequence:        info.AccountData.Sequence,
			ValidatedLedger: info.LedgerIndex,
			CloseTime:       closeTime,
			FeeDrops:        open,
			BaseFeeDrops:    base,
		}, nil
	}
	return nil, fmt.Errorf("xrplobserve: no endpoint answered for account %s", account)
}

// Observe builds the snapshot the decision requires.
//
// `ObservedAtLedger` is the LOWEST index any agreeing source reported. A decision must not be told
// the ledger has been seen further than its weakest witness saw, because the staleness check
// downstream is only meaningful if this number is a floor.
func (o *Observer) Observe(ctx context.Context, destination, reference string, currentValidatedLedger int) *policy.UnderlyingObservation {
	to := int64(currentValidatedLedger)
	from := to - defaultLookback
	if from < 1 {
		from = 1
	}

	answers := make([]*answer, 0, len(o.Endpoints))
	for _, endpoint := range o.Endpoints {
		if a := o.observeFrom(ctx, endpoint, destination, reference, from, to); a != nil {
			answers = append(answers, a)
		}
	}

	if len(answers) == 0 {
		return &policy.UnderlyingObservation{Available: false, Agreed: false, ObservedAtTime: big.NewInt(0)}
	}

	first := fingerprint(answers[0].payments)
	agreed := true
	lowest := answers[0].ledgerIndex
	for _, a := range answers {
		if fingerprint(a.payments) != first {
			agreed = false
		}
		if a.ledgerIndex < lowest {
			lowest = a.ledgerIndex
		}
	}

	merged := answers[0].payments
	if !agreed {
		seen := map[string]policy.ObservedUnderlyingPayment{}
		for _, a := range answers {
			for _, p := range a.payments {
				seen[p.TransactionHash] = p
			}
		}
		merged = merged[:0]
		for _, p := range seen {
			merged = append(merged, p)
		}
		sort.Slice(merged, func(i, j int) bool { return merged[i].TransactionHash < merged[j].TransactionHash })
	}

	return &policy.UnderlyingObservation{
		Available:        true,
		Agreed:           agreed,
		SourceCount:      len(answers),
		ObservedAtLedger: lowest,
		ObservedAtTime:   big.NewInt(time.Now().Unix()),
		Payments:         merged,
	}
}

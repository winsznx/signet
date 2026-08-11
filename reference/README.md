# Signet reference model

The executable specification of the Signet authorization decision.

This package answers exactly one question: given an obligation, a binding, a proposed XRPL
allocation and a policy, may Signet sign a payment, and if so which payment. It is the
specification until real protocol execution disproves it. The Go extension and the Solidity
contracts must agree with it, and they must do so by consuming its fixtures rather than by
reimplementing the logic.

## Constraints

- No network, no filesystem, no clock, no randomness, no wallet, no database.
- `decide` is pure and total: the same input always yields the same decision, and no input causes
  it to throw.
- Default deny. Every path either authorizes or refuses with a stable reason code.

## Layout

| Path | Purpose |
|---|---|
| `src/decide.ts` | the decision function; evaluation order is frozen by ADR 0002 |
| `src/encoding.ts` | the canonical commitment encoding, frozen by ADR 0001 |
| `src/types.ts` | canonical input and output types |
| `src/xrpl-address.ts` | base58check classic-address handling; validates, never repairs |
| `src/payment-reference.ts` | FAssets `PaymentReference.redemption`, from pinned source |
| `src/amount.ts` | UBA to drops; exact conversion only, never rounds |
| `src/reason-codes.ts` | the frozen `S0xx` codes and their error classes |
| `src/scenarios.ts` | the canonical case set every fixture is generated from |
| `test-vectors/decision-fixtures.json` | the frozen cross-language contract |
| `test-vectors/xrpl-addresses.json` | real testnet addresses, so the decoder is checked against data this repo did not construct |

## Commands

```bash
pnpm vitest run reference          # all tests
pnpm --filter @signet/reference typecheck
node --experimental-strip-types reference/src/generate-fixtures.ts   # regenerate fixtures
```

Regenerating fixtures is a deliberate act. The test suite compares the committed file against a
fresh build byte for byte, so drift fails the phase gate instead of being discovered later by
another language's test suite.

## Reading it

Start with `docs/adr/0002-policy-semantics.md` for what the rules are and why they are in that
order, then `docs/adr/0001-canonical-encoding.md` for the byte layout, then `src/decide.ts`, which
is short enough to read in one sitting and is annotated with the invariant each check protects.

## What this model does not decide

It does not submit, reconcile, prove or complete anything. It does not know whether an XRPL
transaction was validated, whether an FDC proof exists, or what FAssets finally recorded. Those are
the coordinator's and the verifier's jobs, and keeping them out of here is what makes this file
small enough to audit.

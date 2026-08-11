/**
 * UBA to XRP drops conversion.
 *
 * FAssets denominates the obligation in UBA, the underlying base amount, whose scale is
 * `assetMintingDecimals`. XRP is denominated in drops, which are fixed at 1e-6 XRP. For FXRP on
 * Coston2 `assetMintingDecimals` is 6, so one UBA is one drop, but the reference model refuses to
 * hard-code that: the decimals are an input, and a scale that cannot convert exactly is a refusal
 * rather than a rounding.
 *
 * Rounding is never acceptable here. FAssets requires the payment to be at least
 * `valueUBA - feeUBA`, so rounding down underpays and fails confirmation, while rounding up
 * silently spends more of the agent's XRP than the obligation requires. Only an exact conversion
 * is authorized.
 */

export const XRP_DROP_DECIMALS = 6;
/** Total XRP supply in drops. No lawful payment can exceed this, and it bounds the uint64 field. */
export const MAX_XRP_DROPS = 100_000_000_000n * 1_000_000n;

export type AmountResult =
  | { readonly ok: true; readonly drops: bigint }
  | { readonly ok: false; readonly problem: string };

/** The amount the agent must pay: the redeemed value less the redemption fee (FAssets `_validatePayment`). */
export function paymentValueUBA(valueUBA: bigint, feeUBA: bigint): AmountResult {
  if (valueUBA <= 0n) return { ok: false, problem: "valueUBA must be positive" };
  if (feeUBA < 0n) return { ok: false, problem: "feeUBA must not be negative" };
  if (feeUBA >= valueUBA) return { ok: false, problem: "feeUBA must be less than valueUBA" };
  return { ok: true, drops: valueUBA - feeUBA };
}

export function ubaToDrops(uba: bigint, assetMintingDecimals: number): AmountResult {
  if (!Number.isInteger(assetMintingDecimals) || assetMintingDecimals < 0 || assetMintingDecimals > 30) {
    return { ok: false, problem: `implausible assetMintingDecimals ${assetMintingDecimals}` };
  }
  if (uba <= 0n) return { ok: false, problem: "amount must be positive" };

  if (assetMintingDecimals >= XRP_DROP_DECIMALS) {
    const divisor = 10n ** BigInt(assetMintingDecimals - XRP_DROP_DECIMALS);
    if (uba % divisor !== 0n) {
      return { ok: false, problem: `amount ${uba} UBA is not an exact number of drops at ${assetMintingDecimals} decimals` };
    }
    const drops = uba / divisor;
    return drops > MAX_XRP_DROPS ? { ok: false, problem: "amount exceeds total XRP supply" } : { ok: true, drops };
  }

  const multiplier = 10n ** BigInt(XRP_DROP_DECIMALS - assetMintingDecimals);
  const drops = uba * multiplier;
  return drops > MAX_XRP_DROPS ? { ok: false, problem: "amount exceeds total XRP supply" } : { ok: true, drops };
}

/** The exact drop amount for an obligation, or the reason it cannot be represented. */
export function obligationAmountDrops(valueUBA: bigint, feeUBA: bigint, assetMintingDecimals: number): AmountResult {
  const value = paymentValueUBA(valueUBA, feeUBA);
  if (!value.ok) return value;
  return ubaToDrops(value.drops, assetMintingDecimals);
}

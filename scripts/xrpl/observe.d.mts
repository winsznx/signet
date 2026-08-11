/**
 * Types for the observer, so the verifier can consume it without weakening its own strictness.
 *
 * The observer is plain JavaScript because it is a script the repository runs, but the verifier is
 * the part an outsider audits and it compiles with `strict` and `noImplicitAny`. Declaring the
 * surface here keeps both true.
 */
export interface ObservedPayment {
  readonly transactionHash: string;
  readonly destinationAddress: string;
  readonly amountDrops: string;
  readonly paymentReference: string;
  readonly validated: boolean;
}

export interface UnderlyingObservation {
  readonly available: boolean;
  readonly agreed: boolean;
  readonly sourceCount: number;
  readonly observedAtLedger: number;
  readonly observedAtTime: string;
  readonly payments: readonly ObservedPayment[];
}

export declare const XRPL_ENDPOINTS: readonly string[];

export declare function observeUnderlying(args: {
  destination: string;
  reference: string;
  currentValidatedLedger: number;
  lookback?: number;
  endpoints?: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<UnderlyingObservation>;

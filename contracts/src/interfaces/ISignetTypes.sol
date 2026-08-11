// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Signet canonical types
/// @notice The obligation as Signet understands it, derived only from authoritative FAssets state.
/// @dev This is the on-chain read of an obligation. It is deliberately NOT the same shape as the
///      reference model's `RedemptionSnapshot` in `reference/src/types.ts`, and claiming parity
///      would be false. The overlap that must agree field for field is:
///
///        requestId, agentVault, paymentAddress, paymentReference, valueUBA, feeUBA,
///        firstUnderlyingBlock, lastUnderlyingBlock, lastUnderlyingTimestamp, destinationTag
///
///      Solidity-only, because they come from the chain read and the reference model has no use
///      for them: `redeemer`, `executor`, `paymentValueUBA` (precomputed here), and `mode`
///      (pre-resolved from `requiresDestinationTag`).
///
///      Reference-model-only, because they are decision inputs rather than obligation facts:
///      `requestGeneration`, `status` as a typed union, `assetMintingDecimals`, and the raw
///      `requiresDestinationTag` boolean this type resolves into `mode`.
///
///      Reconciling the two into one shared shape is owned by the phase that first composes the
///      on-chain read with the decision. Nothing here is ever supplied by a caller.
interface ISignetTypes {
    /// @notice Which redemption mode the obligation uses. Modes are separate adapters, never a flag
    ///         on a shared path, because a tagged payment confirmed through the untagged entry point
    ///         would be rejected by FAssets and a mode mix-up must fail closed rather than degrade.
    enum RedemptionMode {
        /// @dev Memo carries the payment reference. Confirmed with `confirmRedemptionPayment`.
        STANDARD_MEMO,
        /// @dev Memo plus an exact XRPL destination tag. Confirmed with `confirmXRPRedemptionPayment`.
        DESTINATION_TAG
    }

    /// @notice The canonical obligation. Every field is read from the FAssets AssetManager.
    struct CanonicalRedemption {
        uint256 requestId;
        RedemptionMode mode;
        address agentVault;
        address redeemer;
        /// @dev The underlying destination exactly as FAssets recorded it. Never normalised here.
        string paymentAddress;
        bytes32 paymentReference;
        /// @dev What the agent must actually pay: value less the redemption fee.
        uint256 paymentValueUBA;
        uint256 valueUBA;
        uint256 feeUBA;
        uint64 firstUnderlyingBlock;
        uint64 lastUnderlyingBlock;
        uint64 lastUnderlyingTimestamp;
        /// @dev Meaningful only when `mode` is DESTINATION_TAG; zero otherwise.
        uint32 destinationTag;
        address executor;
    }

    /// @notice Why an obligation could not be turned into a canonical redemption.
    /// @dev Mirrors the reference model's stable reason codes for the subset the adapter can reach.
    enum AdapterFailure {
        NONE,
        NOT_ACTIVE,
        WRONG_AGENT,
        REFERENCE_MISMATCH,
        AMOUNT_INVALID,
        DESTINATION_EMPTY,
        TAG_OUT_OF_RANGE,
        MODE_UNSUPPORTED
    }
}

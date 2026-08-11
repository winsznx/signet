// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAssetManager} from "@flare-periphery/coston2/IAssetManager.sol";
import {IRedeemExtended} from "@flare-periphery/coston2/IRedeemExtended.sol";
import {RedemptionRequestInfo} from "@flare-periphery/coston2/data/RedemptionRequestInfo.sol";
import {ISignetTypes} from "../interfaces/ISignetTypes.sol";

/// @title FAssetsAdapter
/// @notice Reads an obligation from the FAssets AssetManager and turns it into Signet's canonical
///         form, or fails closed with a reason.
/// @dev The whole point of this library is that the caller supplies a `requestId` and nothing else.
///      Destination, amount, reference, tag and window are all read from the AssetManager, so there
///      is no path by which a compromised host can influence what gets paid (FR-010, FR-011).
///
///      It is a library of view functions with no storage and no external calls other than reads of
///      the asset manager address it is given.
library FAssetsAdapter {
    /// @dev FAssets `PaymentReference.redemption`, from the pinned implementation:
    ///      `redemption(id) = bytes32(id | (0x4642505266410002 << 192))`.
    ///      The prefix is ASCII "FBPRfA" and 0x0002 is the redemption type.
    uint256 private constant REFERENCE_TYPE_SHIFT = 192;
    // forge-lint: disable-next-line(incorrect-shift)
    uint256 private constant REDEMPTION_TYPE = 0x4642505266410002 << REFERENCE_TYPE_SHIFT;
    // forge-lint: disable-next-line(incorrect-shift)
    uint256 private constant REFERENCE_LOW_BITS_MASK = (1 << REFERENCE_TYPE_SHIFT) - 1;
    uint256 private constant MAX_REQUEST_ID = type(uint64).max;

    /// @dev XRPL destination tags are 32-bit. FAssets stores them in a uint256, so the range must be
    ///      checked here rather than assumed from the type.
    uint256 private constant MAX_DESTINATION_TAG = type(uint32).max;

    /// @notice The payment reference FAssets will require when confirming this request.
    /// @dev Reachable directly, and as a defence in depth from `readCanonicalRedemption`. On that
    ///      path a zero id has already reverted inside the AssetManager's own
    ///      `Redemptions.getRedemptionRequest`, so a caller passing zero gets a revert rather than
    ///      an `AdapterFailure`. That is the same behaviour as any other unknown id.
    function expectedPaymentReference(uint256 _requestId) internal pure returns (bytes32) {
        require(_requestId != 0 && _requestId <= MAX_REQUEST_ID, "reference: request id out of range");
        return bytes32(_requestId | REDEMPTION_TYPE);
    }

    /// @notice True when `_reference` is a well-formed FAssets redemption reference.
    /// @dev Mirrors `PaymentReference.isValid`: the type bits must match and the low bits, which
    ///      carry the request id, may never be zero.
    function isValidRedemptionReference(bytes32 _reference) internal pure returns (bool) {
        uint256 value = uint256(_reference);
        return (value & ~REFERENCE_LOW_BITS_MASK) == REDEMPTION_TYPE && (value & REFERENCE_LOW_BITS_MASK) != 0;
    }

    /// @notice Reads the obligation and returns it in canonical form.
    /// @param _assetManager the FAssets asset manager, resolved from ContractRegistry by the caller
    /// @param _requestId the FAssets redemption request id, the only caller-supplied value
    /// @param _expectedAgentVault the agent Signet is bound to
    /// @return failure NONE when `redemption` is usable, otherwise the reason it is not
    /// @return redemption the canonical obligation, zeroed when `failure` is not NONE
    function readCanonicalRedemption(address _assetManager, uint256 _requestId, address _expectedAgentVault)
        internal
        view
        returns (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory redemption)
    {
        // The extended view is a superset of the base view and is the only one that reports whether
        // a destination tag is required. Reading the base view instead would silently treat a tagged
        // obligation as untagged, which is the single most dangerous mode confusion available here:
        // the payment would omit the tag, FAssets would reject it as invalid, and the agent would
        // have spent real XRP for nothing.
        RedemptionRequestInfo.DataExt memory info = IRedeemExtended(_assetManager).redemptionRequestInfoExt(_requestId);

        // Identity before content, matching the evaluation order fixed by
        // docs/adr/0002-policy-semantics.md. An obligation that is not ours is answered as such
        // before anything about its contents is considered, so the two implementations of this
        // decision cannot disagree about which reason code a doubly-bad input produces.
        if (info.agentVault != _expectedAgentVault) {
            return (ISignetTypes.AdapterFailure.WRONG_AGENT, redemption);
        }
        if (info.status != RedemptionRequestInfo.Status.ACTIVE) {
            return (ISignetTypes.AdapterFailure.NOT_ACTIVE, redemption);
        }
        if (
            info.paymentReference != expectedPaymentReference(_requestId)
                || !isValidRedemptionReference(info.paymentReference)
        ) {
            return (ISignetTypes.AdapterFailure.REFERENCE_MISMATCH, redemption);
        }
        if (bytes(info.paymentAddress).length == 0) {
            return (ISignetTypes.AdapterFailure.DESTINATION_EMPTY, redemption);
        }
        // The agent owes value less the fee. FAssets accepts an overpayment but Signet pays exactly
        // this, so a fee that consumes the whole value leaves nothing lawful to pay.
        if (info.feeUBA >= info.valueUBA) {
            return (ISignetTypes.AdapterFailure.AMOUNT_INVALID, redemption);
        }

        ISignetTypes.RedemptionMode mode = info.requiresDestinationTag
            ? ISignetTypes.RedemptionMode.DESTINATION_TAG
            : ISignetTypes.RedemptionMode.STANDARD_MEMO;

        // FR-014: reject an unsupported mode rather than degrade it. A tagged obligation on a
        // deployment that cannot confirm tagged payments has no lawful completion path, so signing
        // one would spend the agent's XRP against an obligation that can never close. The flag is
        // set by a single-shot diamond initializer today, but a later facet cut could change it
        // while tagged obligations already exist in storage, so this is checked rather than assumed.
        if (info.requiresDestinationTag && !supportsDestinationTag(_assetManager)) {
            return (ISignetTypes.AdapterFailure.MODE_UNSUPPORTED, redemption);
        }

        if (info.requiresDestinationTag && info.destinationTag > MAX_DESTINATION_TAG) {
            return (ISignetTypes.AdapterFailure.TAG_OUT_OF_RANGE, redemption);
        }
        // An untagged obligation carrying a tag value is a field the agent must not add.
        if (!info.requiresDestinationTag && info.destinationTag != 0) {
            return (ISignetTypes.AdapterFailure.TAG_OUT_OF_RANGE, redemption);
        }

        redemption = ISignetTypes.CanonicalRedemption({
            requestId: _requestId,
            mode: mode,
            agentVault: info.agentVault,
            redeemer: info.redeemer,
            paymentAddress: info.paymentAddress,
            paymentReference: info.paymentReference,
            paymentValueUBA: info.valueUBA - info.feeUBA,
            valueUBA: info.valueUBA,
            feeUBA: info.feeUBA,
            firstUnderlyingBlock: info.firstUnderlyingBlock,
            lastUnderlyingBlock: info.lastUnderlyingBlock,
            lastUnderlyingTimestamp: info.lastUnderlyingTimestamp,
            // casting to 'uint32' is safe because an out-of-range tag returned TAG_OUT_OF_RANGE above
            // forge-lint: disable-next-line(unsafe-typecast)
            destinationTag: info.requiresDestinationTag ? uint32(info.destinationTag) : 0,
            executor: info.executor
        });
        return (ISignetTypes.AdapterFailure.NONE, redemption);
    }

    /// @notice Whether this deployment supports tagged redemption at all.
    /// @dev A deployment without it cannot serve a DESTINATION_TAG obligation, and Signet must
    ///      refuse rather than fall back to the untagged path (FR-014).
    function supportsDestinationTag(address _assetManager) internal view returns (bool) {
        return IRedeemExtended(_assetManager).redeemWithTagSupported();
    }

    /// @notice The minting decimals the underlying asset is denominated in, needed to convert UBA
    ///         to drops exactly.
    /// @dev The pinned interface returns uint256; the value is narrowed here with a bound check so a
    ///      nonsensical scale fails closed rather than wrapping.
    function assetMintingDecimals(address _assetManager) internal view returns (uint8) {
        uint256 decimals = IAssetManager(_assetManager).assetMintingDecimals();
        require(decimals <= 30, "adapter: implausible minting decimals");
        // casting to 'uint8' is safe because the require above bounds it to 30
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(decimals);
    }
}

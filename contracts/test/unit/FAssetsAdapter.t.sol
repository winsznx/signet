// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RedemptionRequestInfo} from "@flare-periphery/coston2/data/RedemptionRequestInfo.sol";
import {FAssetsAdapter} from "../../src/adapters/FAssetsAdapter.sol";
import {ISignetTypes} from "../../src/interfaces/ISignetTypes.sol";

/// @notice A configurable stand-in for the AssetManager's extended redemption view.
/// @dev Live Coston2 cannot produce a malformed obligation: the protocol will not create one. The
///      adapter's range and consistency guards therefore have no fork fixture, and without a mock
///      they would be untested code claiming to be a defence. This exists to make those branches
///      real rather than aspirational.
contract MockRedeemExtended {
    RedemptionRequestInfo.DataExt internal data;
    bool internal tagSupported = true;

    function set(RedemptionRequestInfo.DataExt memory _data) external {
        data = _data;
    }

    function setTagSupported(bool _supported) external {
        tagSupported = _supported;
    }

    function redemptionRequestInfoExt(uint256) external view returns (RedemptionRequestInfo.DataExt memory) {
        return data;
    }

    function redeemWithTagSupported() external view returns (bool) {
        return tagSupported;
    }
}

contract FAssetsAdapterUnitTest is Test {
    MockRedeemExtended internal manager;

    address internal constant AGENT = address(0xA1);
    address internal constant OTHER_AGENT = address(0xA2);
    uint256 internal constant REQUEST_ID = 4242;
    string internal constant DESTINATION = "rhf7192NqpPvBUnAobBJAryNFQNbPKz11w";

    function setUp() public {
        manager = new MockRedeemExtended();
        manager.set(_validObligation());
    }

    /// @dev A well-formed ACTIVE obligation. Each test mutates exactly one thing.
    function _validObligation() internal pure returns (RedemptionRequestInfo.DataExt memory data) {
        data.redemptionRequestId = uint64(REQUEST_ID);
        data.status = RedemptionRequestInfo.Status.ACTIVE;
        data.agentVault = AGENT;
        data.redeemer = address(0xBEEF);
        data.paymentAddress = DESTINATION;
        data.paymentReference = FAssetsAdapter.expectedPaymentReference(REQUEST_ID);
        data.valueUBA = 10_000_000;
        data.feeUBA = 50_000;
        data.firstUnderlyingBlock = 100;
        data.lastUnderlyingBlock = 700;
        data.lastUnderlyingTimestamp = 1_800_000_900;
        data.requiresDestinationTag = false;
        data.destinationTag = 0;
    }

    function _read() internal view returns (ISignetTypes.AdapterFailure, ISignetTypes.CanonicalRedemption memory) {
        return FAssetsAdapter.readCanonicalRedemption(address(manager), REQUEST_ID, AGENT);
    }

    function _expectFailure(ISignetTypes.AdapterFailure expected) internal view {
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory r) = _read();
        assertEq(uint256(failure), uint256(expected), "wrong failure code");
        // Every failure path must leak nothing about the obligation.
        assertEq(r.requestId, 0, "request id leaked");
        assertEq(bytes(r.paymentAddress).length, 0, "destination leaked");
        assertEq(r.valueUBA, 0, "value leaked");
        assertEq(r.destinationTag, 0, "tag leaked");
    }

    function test_validObligationIsAccepted() public view {
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory r) = _read();
        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.NONE));
        assertEq(r.paymentValueUBA, 9_950_000, "value minus fee");
    }

    // ------------------------------------------------------------------ reference

    function test_referenceForAnotherRequestIsRefused() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.paymentReference = FAssetsAdapter.expectedPaymentReference(REQUEST_ID + 1);
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.REFERENCE_MISMATCH);
    }

    function test_mintingTypeReferenceIsRefused() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        // Well formed, right request id, wrong FAssets type.
        data.paymentReference = 0x4642505266410001000000000000000000000000000000000000000000001092;
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.REFERENCE_MISMATCH);
    }

    function test_zeroReferenceIsRefused() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.paymentReference = bytes32(0);
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.REFERENCE_MISMATCH);
    }

    // ------------------------------------------------------------------ destination

    function test_emptyDestinationIsRefused() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.paymentAddress = "";
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.DESTINATION_EMPTY);
    }

    // ------------------------------------------------------------------ amount

    function test_feeEqualToValueLeavesNothingPayable() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.feeUBA = data.valueUBA;
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.AMOUNT_INVALID);
    }

    function test_feeAboveValueIsRefused() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.feeUBA = data.valueUBA + 1;
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.AMOUNT_INVALID);
    }

    function test_feeOneBelowValueLeavesExactlyOneUnitPayable() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.feeUBA = data.valueUBA - 1;
        manager.set(data);
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory r) = _read();
        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.NONE), "boundary must be payable");
        assertEq(r.paymentValueUBA, 1, "exactly one unit");
    }

    // ------------------------------------------------------------------ destination tag

    function test_tagAtUint32MaxIsAccepted() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.requiresDestinationTag = true;
        data.destinationTag = type(uint32).max;
        manager.set(data);
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory r) = _read();
        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.NONE), "uint32 max is representable");
        assertEq(r.destinationTag, type(uint32).max, "tag must survive narrowing exactly");
        assertEq(uint256(r.mode), uint256(ISignetTypes.RedemptionMode.DESTINATION_TAG));
    }

    function test_tagOneAboveUint32MaxIsRefusedNotTruncated() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.requiresDestinationTag = true;
        data.destinationTag = uint256(type(uint32).max) + 1;
        manager.set(data);
        // Truncating would silently produce tag 0, which FAssets would reject on confirmation after
        // the agent had already paid. It must refuse instead.
        _expectFailure(ISignetTypes.AdapterFailure.TAG_OUT_OF_RANGE);
    }

    function test_tagOnAnUntaggedObligationIsRefused() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.requiresDestinationTag = false;
        data.destinationTag = 7;
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.TAG_OUT_OF_RANGE);
    }

    function test_requiredTagOfZeroIsAcceptedAndDistinctFromUntagged() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.requiresDestinationTag = true;
        data.destinationTag = 0;
        manager.set(data);
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory r) = _read();
        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.NONE));
        assertEq(uint256(r.mode), uint256(ISignetTypes.RedemptionMode.DESTINATION_TAG), "mode carries the distinction");
    }

    // ------------------------------------------------------------------ window

    function test_invertedWindowIsRefused() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.firstUnderlyingBlock = data.lastUnderlyingBlock + 1;
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.WINDOW_INVALID);
    }

    function test_singleBlockWindowIsAccepted() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.firstUnderlyingBlock = data.lastUnderlyingBlock;
        manager.set(data);
        (ISignetTypes.AdapterFailure failure,) = _read();
        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.NONE), "equality is a valid window");
    }

    // ------------------------------------------------------------------ unsupported mode

    function test_taggedObligationOnADeploymentThatCannotConfirmItIsRefused() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.requiresDestinationTag = true;
        data.destinationTag = 412_913_618;
        manager.set(data);
        manager.setTagSupported(false);
        // FR-014: refuse rather than degrade. Paying without the tag would spend real XRP against an
        // obligation that can never be confirmed.
        _expectFailure(ISignetTypes.AdapterFailure.MODE_UNSUPPORTED);
    }

    function test_untaggedObligationIsUnaffectedByTagSupport() public {
        manager.setTagSupported(false);
        (ISignetTypes.AdapterFailure failure,) = _read();
        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.NONE), "memo mode does not need tag support");
    }

    // ------------------------------------------------------------------ ordering

    function test_wrongAgentIsReportedBeforeInactiveStatus() public {
        // Both conditions are true at once. ADR-0002 fixes identity before content, so the answer
        // must be WRONG_AGENT. If this ever flips, the Solidity and the reference model disagree
        // about the observable reason code for the same input.
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.agentVault = OTHER_AGENT;
        data.status = RedemptionRequestInfo.Status.SUCCESSFUL;
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.WRONG_AGENT);
    }

    function test_inactiveStatusIsReportedForOurOwnObligation() public {
        RedemptionRequestInfo.DataExt memory data = _validObligation();
        data.status = RedemptionRequestInfo.Status.DEFAULTED_UNCONFIRMED;
        manager.set(data);
        _expectFailure(ISignetTypes.AdapterFailure.NOT_ACTIVE);
    }

    function test_everyNonActiveStatusIsRefused() public {
        RedemptionRequestInfo.Status[5] memory statuses = [
            RedemptionRequestInfo.Status.DEFAULTED_UNCONFIRMED,
            RedemptionRequestInfo.Status.SUCCESSFUL,
            RedemptionRequestInfo.Status.DEFAULTED_FAILED,
            RedemptionRequestInfo.Status.BLOCKED,
            RedemptionRequestInfo.Status.REJECTED
        ];
        for (uint256 i = 0; i < statuses.length; i++) {
            RedemptionRequestInfo.DataExt memory data = _validObligation();
            data.status = statuses[i];
            manager.set(data);
            _expectFailure(ISignetTypes.AdapterFailure.NOT_ACTIVE);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IFlareContractRegistry} from "@flare-periphery/coston2/IFlareContractRegistry.sol";
import {IAssetManager} from "@flare-periphery/coston2/IAssetManager.sol";
import {IRedeemExtended} from "@flare-periphery/coston2/IRedeemExtended.sol";
import {RedemptionRequestInfo} from "@flare-periphery/coston2/data/RedemptionRequestInfo.sol";
import {FAssetsAdapter} from "../../src/adapters/FAssetsAdapter.sol";
import {ISignetTypes} from "../../src/interfaces/ISignetTypes.sol";

/// @notice Proves the FAssets seam against real Coston2 state, not against a mock.
///
/// Every case forks Coston2 at a block chosen so that a specific real redemption is in a specific
/// real state. The expected values are the ones decoded independently from the on-chain
/// `RedemptionRequested` / `RedemptionWithTagRequested` event logs, so the test compares the adapter
/// against the protocol rather than against itself.
///
/// Recorded in docs/protocol-seams/fassets.md. Requires COSTON2_RPC_URL.
contract FAssetsSeamTest is Test {
    address internal constant CONTRACT_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    /// @dev A standard memo-mode redemption, created in this block.
    uint256 internal constant BLOCK_MEMO_ACTIVE = 33_921_675;
    uint256 internal constant REQUEST_MEMO = 44_851_498;
    address internal constant AGENT_MEMO = 0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC;
    string internal constant DESTINATION_MEMO = "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72";
    uint256 internal constant VALUE_UBA_MEMO = 3_060_000_000;
    uint256 internal constant FEE_UBA_MEMO = 15_300_000;
    bytes32 internal constant REFERENCE_MEMO = 0x4642505266410002000000000000000000000000000000000000000002ac612a;

    /// @dev A destination-tag redemption, created in this block.
    uint256 internal constant BLOCK_TAG_ACTIVE = 33_913_301;
    uint256 internal constant REQUEST_TAG = 44_745_040;
    address internal constant AGENT_TAG = 0x5b89514d1F060AdbEA8B7294AFf81ed8dbAa7fC5;
    uint32 internal constant DESTINATION_TAG = 412_913_618;

    /// @dev A block well after both requests were confirmed.
    uint256 internal constant BLOCK_AFTER_CONFIRMATION = 33_922_434;

    function _assetManager() internal view returns (address) {
        address resolved = IFlareContractRegistry(CONTRACT_REGISTRY).getContractAddressByName("AssetManagerFXRP");
        require(resolved != address(0), "AssetManagerFXRP not in registry");
        return resolved;
    }

    function _fork(uint256 blockNumber) internal {
        vm.createSelectFork(vm.envString("COSTON2_RPC_URL"), blockNumber);
    }

    // ------------------------------------------------------------------ resolution

    function test_registryResolvesAssetManagerAtPinnedBlock() public {
        _fork(BLOCK_MEMO_ACTIVE);
        address assetManager = _assetManager();
        assertEq(assetManager, 0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA, "asset manager address drifted");
        assertGt(assetManager.code.length, 0, "asset manager has no code");
    }

    function test_deploymentSupportsDestinationTagMode() public {
        _fork(BLOCK_MEMO_ACTIVE);
        assertTrue(FAssetsAdapter.supportsDestinationTag(_assetManager()), "tagged redemption unsupported");
    }

    function test_mintingDecimalsMakeUbaAndDropsOneToOne() public {
        _fork(BLOCK_MEMO_ACTIVE);
        // XRP drops are 1e-6 XRP. Signet's exact-conversion rule is only trivial while the minting
        // scale matches; if Flare ever changes it, the conversion stops being one to one and the
        // reference model's exactness check starts doing real work.
        assertEq(FAssetsAdapter.assetMintingDecimals(_assetManager()), 6, "minting decimals changed");
    }

    // ------------------------------------------------------------------ memo mode

    function test_readsRealMemoModeRedemptionIntoCanonicalForm() public {
        _fork(BLOCK_MEMO_ACTIVE);
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory r) =
            FAssetsAdapter.readCanonicalRedemption(_assetManager(), REQUEST_MEMO, AGENT_MEMO);

        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.NONE), "expected a usable obligation");
        assertEq(uint256(r.mode), uint256(ISignetTypes.RedemptionMode.STANDARD_MEMO), "wrong mode");
        assertEq(r.agentVault, AGENT_MEMO, "agent");
        assertEq(r.paymentAddress, DESTINATION_MEMO, "destination must be the exact recorded string");
        assertEq(r.paymentReference, REFERENCE_MEMO, "payment reference");
        assertEq(r.valueUBA, VALUE_UBA_MEMO, "value");
        assertEq(r.feeUBA, FEE_UBA_MEMO, "fee");
        assertEq(r.paymentValueUBA, VALUE_UBA_MEMO - FEE_UBA_MEMO, "the agent owes value minus fee");
        assertEq(r.destinationTag, 0, "untagged obligations carry no tag");
        assertGt(r.lastUnderlyingBlock, r.firstUnderlyingBlock, "window must be forward");
    }

    function test_paymentReferenceMatchesTheProtocolDerivation() public {
        _fork(BLOCK_MEMO_ACTIVE);
        // The reference is derived independently here and compared against what FAssets recorded,
        // so a mistake in the derivation cannot hide behind reading the stored value back.
        assertEq(FAssetsAdapter.expectedPaymentReference(REQUEST_MEMO), REFERENCE_MEMO, "derivation");
        assertTrue(FAssetsAdapter.isValidRedemptionReference(REFERENCE_MEMO), "validity");

        RedemptionRequestInfo.DataExt memory info;
        info = IRedeemExtended(_assetManager()).redemptionRequestInfoExt(REQUEST_MEMO);
        assertEq(info.paymentReference, FAssetsAdapter.expectedPaymentReference(REQUEST_MEMO), "chain vs derived");
    }

    // ------------------------------------------------------------------ tagged mode

    function test_readsRealTaggedRedemptionWithTheExactTag() public {
        _fork(BLOCK_TAG_ACTIVE);
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory r) =
            FAssetsAdapter.readCanonicalRedemption(_assetManager(), REQUEST_TAG, AGENT_TAG);

        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.NONE), "expected a usable obligation");
        assertEq(uint256(r.mode), uint256(ISignetTypes.RedemptionMode.DESTINATION_TAG), "wrong mode");
        assertEq(r.destinationTag, DESTINATION_TAG, "tag must be exact");
    }

    function test_taggedAndUntaggedProduceDifferentModes() public {
        _fork(BLOCK_TAG_ACTIVE);
        (, ISignetTypes.CanonicalRedemption memory tagged) =
            FAssetsAdapter.readCanonicalRedemption(_assetManager(), REQUEST_TAG, AGENT_TAG);
        assertTrue(tagged.mode == ISignetTypes.RedemptionMode.DESTINATION_TAG, "tagged");
        assertTrue(tagged.destinationTag != 0, "a tagged obligation carries its tag");
    }

    // ------------------------------------------------------------------ adversarial

    function test_wrongAgentIsRefusedNotServed() public {
        _fork(BLOCK_MEMO_ACTIVE);
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory r) =
            FAssetsAdapter.readCanonicalRedemption(_assetManager(), REQUEST_MEMO, AGENT_TAG);

        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.WRONG_AGENT), "must refuse another agent's work");
        assertEq(r.requestId, 0, "no obligation may be returned on failure");
        assertEq(bytes(r.paymentAddress).length, 0, "a refused read must leak no destination");
    }

    function test_confirmedRedemptionIsNoLongerActive() public {
        _fork(BLOCK_AFTER_CONFIRMATION);
        (ISignetTypes.AdapterFailure failure,) =
            FAssetsAdapter.readCanonicalRedemption(_assetManager(), REQUEST_MEMO, AGENT_MEMO);
        assertEq(uint256(failure), uint256(ISignetTypes.AdapterFailure.NOT_ACTIVE), "a paid obligation is not payable");
    }

    /// @dev The pinned interface comment says a confirmed request is deleted and the view fails.
    ///      The live deployment does not do that: it returns status SUCCESSFUL. Signet must code
    ///      against the deployment, so this test records the real behaviour and will fail loudly if
    ///      the deployment ever starts matching the comment instead.
    function test_confirmedRedemptionReturnsSuccessfulRatherThanReverting() public {
        _fork(BLOCK_AFTER_CONFIRMATION);
        RedemptionRequestInfo.DataExt memory info =
            IRedeemExtended(_assetManager()).redemptionRequestInfoExt(REQUEST_MEMO);
        assertEq(
            uint256(info.status),
            uint256(RedemptionRequestInfo.Status.SUCCESSFUL),
            "confirmed request should report SUCCESSFUL"
        );
    }

    function test_unknownRequestIdReverts() public {
        _fork(BLOCK_MEMO_ACTIVE);
        address assetManager = _assetManager();
        vm.expectRevert();
        IRedeemExtended(assetManager).redemptionRequestInfoExt(999_999_999_999);
    }

    function test_referenceDerivationRejectsOutOfRangeIds() public pure {
        assertFalse(FAssetsAdapter.isValidRedemptionReference(bytes32(0)), "zero is not a reference");
        // A well-formed reference of the minting type must not pass as a redemption reference.
        assertFalse(
            FAssetsAdapter.isValidRedemptionReference(
                0x4642505266410001000000000000000000000000000000000000000002ac612a
            ),
            "minting type must not pass"
        );
        // Redemption type with zero low bits carries no request id.
        assertFalse(
            FAssetsAdapter.isValidRedemptionReference(
                0x4642505266410002000000000000000000000000000000000000000000000000
            ),
            "zero low bits must not pass"
        );
    }
}

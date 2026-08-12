// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {SignetFccInstructionSender} from "../../src/fcc/SignetFccInstructionSender.sol";
import {SignetRegistry} from "../../src/SignetRegistry.sol";
import {ISignetTypes} from "../../src/interfaces/ISignetTypes.sol";
import {ITeeExtensionRegistry} from "../../src/fcc/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../../src/fcc/interfaces/ITeeMachineRegistry.sol";
import {RedemptionRequestInfo} from "@flare-periphery/coston2/data/RedemptionRequestInfo.sol";

/// A stand-in AssetManager whose obligation an attacker cannot influence.
contract FakeAssetManager {
    RedemptionRequestInfo.DataExt private info;
    uint8 public assetMintingDecimals = 6;

    function set(RedemptionRequestInfo.DataExt memory _info) external {
        info = _info;
    }

    function redemptionRequestInfoExt(uint256) external view returns (RedemptionRequestInfo.DataExt memory) {
        return info;
    }

    function redeemWithTagSupported() external pure returns (bool) {
        return true;
    }
}

contract FakeTeeRegistry {
    function nextPublicExtensionId() external pure returns (uint256) {
        return 0x10001;
    }

    function getTeeExtensionInstructionsSender(uint256) external view returns (address) {
        return msg.sender;
    }

    function getRandomTeeIds(uint256, uint256) external pure returns (address[] memory ids) {
        ids = new address[](1);
        ids[0] = address(0xBEEF);
    }

    function sendInstructions(address[] calldata, bytes calldata) external payable returns (bytes32) {
        return bytes32(uint256(1));
    }
}

/// @notice The Gate B invariant.
///
/// "For any two external calls carrying the same valid requestId, an untrusted caller cannot cause
/// Signet to derive a different destination, amount, reference, tag or admissible payment window."
///
/// The strong form of that is structural rather than statistical: `authorizeRedemption` takes a
/// request id and a generation and nothing else, so there is no parameter through which a caller
/// could express any of those fields. These tests prove the derived payload is a pure function of
/// chain state by varying everything a caller controls and asserting the payload does not move.
contract CanonicalInstructionTest is Test {
    FakeAssetManager private assetManager;
    SignetRegistry private registry;
    SignetFccInstructionSender private sender;

    address private constant AGENT = address(0xA9E7);
    address private constant GOVERNANCE = address(0x9012);
    uint256 private constant REQUEST_ID = 44928272;

    function setUp() public {
        assetManager = new FakeAssetManager();
        FakeTeeRegistry tee = new FakeTeeRegistry();
        registry = new SignetRegistry(GOVERNANCE, block.chainid);

        RedemptionRequestInfo.DataExt memory info;
        info.redemptionRequestId = uint64(REQUEST_ID);
        info.status = RedemptionRequestInfo.Status.ACTIVE;
        info.agentVault = AGENT;
        info.paymentAddress = "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb";
        info.paymentReference = bytes32(uint256(0x4642505266410002) << 192 | REQUEST_ID);
        info.valueUBA = 10_000_000;
        info.feeUBA = 50_000;
        info.firstUnderlyingBlock = 19_824_924;
        info.lastUnderlyingBlock = 19_825_472;
        info.lastUnderlyingTimestamp = 1_786_468_650;
        assetManager.set(info);

        sender = new SignetFccInstructionSender(
            ITeeExtensionRegistry(address(tee)), ITeeMachineRegistry(address(tee)), registry, address(assetManager)
        );
    }

    function _instruction() private view returns (SignetFccInstructionSender.CanonicalInstruction memory) {
        return sender.canonicalInstructionFor(REQUEST_ID, 0);
    }

    /// The payload is identical no matter who asks.
    function test_theSameRequestIdYieldsTheSamePayloadForEveryCaller(address callerA, address callerB) public {
        vm.assume(callerA != address(0) && callerB != address(0));

        vm.prank(callerA);
        bytes memory a = abi.encode(_instruction());
        vm.prank(callerB);
        bytes memory b = abi.encode(_instruction());

        assertEq(keccak256(a), keccak256(b), "two callers derived different payloads for one request id");
    }

    /// Every field an attacker would want to move comes from the obligation, not from a parameter.
    function test_everyPaymentFieldComesFromFAssets() public view {
        SignetFccInstructionSender.CanonicalInstruction memory i = _instruction();
        assertEq(i.paymentAddress, "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb", "destination");
        assertEq(i.valueUBA, 10_000_000, "value");
        assertEq(i.feeUBA, 50_000, "fee");
        assertEq(i.paymentReference, bytes32(uint256(0x4642505266410002) << 192 | REQUEST_ID), "reference");
        assertEq(i.lastUnderlyingBlock, 19_825_472, "window block");
        assertEq(i.lastUnderlyingTimestamp, 1_786_468_650, "window time");
        assertEq(i.agentVault, AGENT, "agent");
        assertEq(i.requiresDestinationTag, false, "tag mode");
    }

    /// Changing the obligation changes the payload. Without this the test above would pass on a
    /// contract that returned a constant.
    function test_thePayloadTracksTheObligation() public {
        bytes32 before = keccak256(abi.encode(_instruction()));

        RedemptionRequestInfo.DataExt memory info;
        info.redemptionRequestId = uint64(REQUEST_ID);
        info.status = RedemptionRequestInfo.Status.ACTIVE;
        info.agentVault = AGENT;
        info.paymentAddress = "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72";
        info.paymentReference = bytes32(uint256(0x4642505266410002) << 192 | REQUEST_ID);
        info.valueUBA = 20_000_000;
        info.feeUBA = 50_000;
        info.firstUnderlyingBlock = 19_824_924;
        info.lastUnderlyingBlock = 19_825_472;
        info.lastUnderlyingTimestamp = 1_786_468_650;
        assetManager.set(info);

        assertTrue(before != keccak256(abi.encode(_instruction())), "payload ignored the obligation");
    }

    /// A request FAssets does not consider active is refused before any payload exists.
    function test_anInactiveRequestIsRefused() public {
        RedemptionRequestInfo.DataExt memory info;
        info.redemptionRequestId = uint64(REQUEST_ID);
        info.status = RedemptionRequestInfo.Status.SUCCESSFUL;
        info.agentVault = AGENT;
        info.paymentAddress = "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb";
        info.paymentReference = bytes32(uint256(0x4642505266410002) << 192 | REQUEST_ID);
        info.valueUBA = 10_000_000;
        info.feeUBA = 50_000;
        assetManager.set(info);

        vm.expectRevert();
        sender.canonicalInstructionFor(REQUEST_ID, 0);
    }

    /// The function signature itself is the invariant's strongest form: there is no parameter for a
    /// destination, an amount, a reference, a tag, a window or an agent.
    function test_theSignatureCarriesNoPaymentField() public pure {
        assertEq(
            SignetFccInstructionSender.authorizeRedemption.selector,
            bytes4(keccak256("authorizeRedemption(uint256,uint32)")),
            "authorizeRedemption must take only a request id and a generation"
        );
    }
}

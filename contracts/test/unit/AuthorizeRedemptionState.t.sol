// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {SignetFccInstructionSender} from "../../src/fcc/SignetFccInstructionSender.sol";
import {SignetRegistry} from "../../src/SignetRegistry.sol";
import {ITeeExtensionRegistry} from "../../src/fcc/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../../src/fcc/interfaces/ITeeMachineRegistry.sol";
import {RedemptionRequestInfo} from "@flare-periphery/coston2/data/RedemptionRequestInfo.sol";

contract FakeAssetManagerStateful {
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

/// Counts dispatches, so "at most one" is measured rather than argued.
///
/// `getRandomTeeIds` reverts unless a machine has been "registered". That models the live chain,
/// where no TEE machine exists for extension 66244 and the call reverts `0xd65ac61e`. It is what
/// makes the ordering assertion meaningful: a guard that ran *after* the TEE lookup would surface
/// as `NoTeeMachine`, not as `ActionNotRequested`.
contract CountingTeeRegistry {
    uint256 public dispatches;
    bool public machineRegistered;

    error NoTeeMachine();

    function setMachineRegistered(bool _on) external {
        machineRegistered = _on;
    }

    function nextPublicExtensionId() external pure returns (uint256) {
        return 0x10001;
    }

    function getTeeExtensionInstructionsSender(uint256) external view returns (address) {
        return msg.sender;
    }

    function getRandomTeeIds(uint256, uint256) external view returns (address[] memory ids) {
        if (!machineRegistered) revert NoTeeMachine();
        ids = new address[](1);
        ids[0] = address(0xBEEF);
    }

    function sendInstructions(address[] calldata, ITeeExtensionRegistry.TeeInstructionParams calldata)
        external
        payable
        returns (bytes32)
    {
        dispatches += 1;
        return bytes32(dispatches);
    }
}

/// @notice At most one authorization dispatch per (requestId, generation).
///
/// `authorizeRedemption` used to gate on `state != NONE`, which admitted `AUTHORIZED`, `REFUSED`
/// and `EVIDENCE_FINALIZED` alike. An already-decided action could be instructed a second time, and
/// because the extension keeps no memory of a prior authorization it would derive a fresh XRPL
/// sequence and produce a second independently valid payment for one obligation. `S021` only fires
/// once the first payment has *validated* on the XRP ledger, so the settlement-latency window was
/// wide open.
///
/// `REQUESTED` is the only admissible state, and it is the same one `SignetRegistry.recordDecision`
/// requires in order to move the action forward.
contract AuthorizeRedemptionStateTest is Test {
    FakeAssetManagerStateful private assetManager;
    CountingTeeRegistry private tee;
    SignetRegistry private registry;
    SignetFccInstructionSender private sender;

    address private constant AGENT = address(0xA9E7);
    address private constant GOVERNANCE = address(0x9012);
    uint256 private constant REQUEST_ID = 44928272;
    uint32 private constant GENERATION = 0;
    bytes32 private constant CODE_HASH = keccak256("signet-test-code-hash");

    uint256 private signerKey;
    bytes32 private bindingId;
    bytes32 private actionId;

    function setUp() public {
        assetManager = new FakeAssetManagerStateful();
        tee = new CountingTeeRegistry();
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
        sender.setExtensionId();

        signerKey = 0xA11CE;
        address resultSigner = vm.addr(signerKey);

        vm.startPrank(GOVERNANCE);
        registry.setInstructionSender(address(this));
        registry.approveCodeHash(CODE_HASH, 1, 1, true);
        registry.approveSigner(resultSigner, true);
        SignetRegistry.AgentBinding memory binding;
        binding.assetManager = address(assetManager);
        binding.agentVault = AGENT;
        binding.xrplNetworkId = 1;
        binding.extensionId = 1;
        binding.approvedCodeHash = CODE_HASH;
        binding.policyVersion = 1;
        binding.xrplSourceAddress = "rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta";
        registry.bindAgent(binding);
        vm.stopPrank();

        bindingId = registry.bindingIdFor(address(assetManager), AGENT);
        actionId = registry.recordActionRequested(bindingId, REQUEST_ID, GENERATION, keccak256("obligation"));
    }

    function _authorize() private {
        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");
        bytes32 digest = registry.decisionDigest(actionId, commitment, resultHash, CODE_HASH);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        registry.recordDecision(actionId, commitment, resultHash, CODE_HASH, abi.encodePacked(r, s, v));
    }

    function _refuse() private {
        bytes32 digest = registry.refusalDigest(actionId, "S021_PAYMENT_ALREADY_OBSERVED", CODE_HASH);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        registry.recordRefusal(actionId, "S021_PAYMENT_ALREADY_OBSERVED", CODE_HASH, abi.encodePacked(r, s, v));
    }

    // ------------------------------------------------------------------ the admissible state

    function test_dispatchIsAdmittedFromRequested() public {
        tee.setMachineRegistered(true);
        assertEq(uint8(registry.actionFor(actionId).state), uint8(SignetRegistry.ActionState.REQUESTED), "precondition");

        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(tee.dispatches(), 1, "the admissible state did not dispatch");
    }

    function test_anUnknownActionIsNoSuchAction() public {
        tee.setMachineRegistered(true);
        vm.expectRevert(SignetFccInstructionSender.NoSuchAction.selector);
        sender.authorizeRedemption(REQUEST_ID, GENERATION + 7);
    }

    // ------------------------------------------------------------------ every later state fails closed

    function test_aSecondDispatchAfterAuthorizedIsRefused() public {
        tee.setMachineRegistered(true);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        _authorize();

        vm.expectRevert(
            abi.encodeWithSelector(
                SignetFccInstructionSender.ActionNotRequested.selector, SignetRegistry.ActionState.AUTHORIZED
            )
        );
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(tee.dispatches(), 1, "a second payment could have been produced for one obligation");
    }

    function test_dispatchAfterRefusedIsRefused() public {
        tee.setMachineRegistered(true);
        _refuse();

        vm.expectRevert(
            abi.encodeWithSelector(
                SignetFccInstructionSender.ActionNotRequested.selector, SignetRegistry.ActionState.REFUSED
            )
        );
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(tee.dispatches(), 0, "a refused action was instructed");
    }

    function test_dispatchAfterEvidenceFinalizedIsRefused() public {
        tee.setMachineRegistered(true);
        _authorize();

        SignetRegistry.FinalEvidence memory evidence;
        evidence.xrplTxHash = keccak256("xrpl-tx");
        vm.prank(GOVERNANCE);
        registry.recordFinalEvidence(actionId, evidence);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignetFccInstructionSender.ActionNotRequested.selector, SignetRegistry.ActionState.EVIDENCE_FINALIZED
            )
        );
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(tee.dispatches(), 0, "a completed action was instructed again");
    }

    /// Pausing is the operational kill switch. It must stop a dispatch that was otherwise admissible.
    function test_aPausedBindingCannotDispatch() public {
        tee.setMachineRegistered(true);
        vm.prank(GOVERNANCE);
        registry.pauseAgent(bindingId, true);

        vm.expectRevert(SignetFccInstructionSender.BindingNotActive.selector);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(tee.dispatches(), 0, "a paused binding dispatched");
    }

    function test_aRetiredBindingCannotDispatch() public {
        tee.setMachineRegistered(true);
        vm.prank(GOVERNANCE);
        registry.retireBinding(bindingId);

        vm.expectRevert(SignetFccInstructionSender.BindingNotActive.selector);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(tee.dispatches(), 0, "a retired binding dispatched");
    }

    // ------------------------------------------------------------------ ordering

    /// @notice The guard must run before the TEE lookup.
    ///
    /// This is the regression for the live condition: no TEE machine is registered for extension
    /// 66244, so `getRandomTeeIds` reverts. If the state guard ran after it, a second authorization
    /// attempt would surface as `NoTeeMachine` and would start dispatching the day a machine was
    /// registered. Asserting the *specific* error proves the rejection happens first.
    function test_aSecondAttemptIsRejectedBeforeAnyTeeLookup() public {
        tee.setMachineRegistered(true);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        _authorize();
        tee.setMachineRegistered(false);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignetFccInstructionSender.ActionNotRequested.selector, SignetRegistry.ActionState.AUTHORIZED
            )
        );
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
    }

    // ------------------------------------------------------------------ the invariant, fuzzed

    /// @notice For one (requestId, generation), no sequence of calls from any callers dispatches twice.
    ///
    /// This is the property that matters, and the state guard alone does not provide it. An action
    /// stays `REQUESTED` until the extension's decision returns through `recordDecision`, so during
    /// that window the registry cannot tell a first dispatch from a tenth. An earlier version of
    /// this test found ten dispatches for one obligation. `instructionDispatched` closes it.
    function testFuzz_atMostOneDispatchPerAction(address[16] calldata callers, uint8 authorizeAfter) public {
        tee.setMachineRegistered(true);
        uint256 succeeded;

        for (uint256 i = 0; i < callers.length; ++i) {
            if (callers[i] == address(0)) continue;
            // A decision may land at any point, from any direction, exactly as it would on chain.
            if (
                i == authorizeAfter % callers.length
                    && registry.actionFor(actionId).state == SignetRegistry.ActionState.REQUESTED
            ) {
                _authorize();
            }
            vm.prank(callers[i]);
            try sender.authorizeRedemption(REQUEST_ID, GENERATION) {
                succeeded += 1;
            } catch {}
        }

        assertLe(succeeded, 1, "more than one authorization dispatch for one obligation");
        assertEq(tee.dispatches(), succeeded, "dispatch count disagrees with successful calls");
    }

    /// A repeat while the action is still REQUESTED, which is the window the state guard cannot see.
    function test_aSecondDispatchBeforeAnyDecisionIsRefused() public {
        tee.setMachineRegistered(true);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(
            uint8(registry.actionFor(actionId).state),
            uint8(SignetRegistry.ActionState.REQUESTED),
            "the action is still awaiting its decision, which is the point"
        );

        vm.expectRevert(
            abi.encodeWithSelector(SignetFccInstructionSender.InstructionAlreadyDispatched.selector, actionId)
        );
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(tee.dispatches(), 1, "a second instruction went out while the first was in flight");
    }

    /// @notice The dispatch marker is on chain, so it survives anything a process can do.
    ///
    /// The extension holds no memory of a prior authorization, and a restart gives it a new
    /// identity, so a marker kept in the extension or in a coordinator checkpoint would be lost
    /// exactly when it is needed. Simulating a full restart of every off-chain component is
    /// therefore a no-op against this guard, which is the strongest form the requirement can take.
    function test_theDispatchMarkerSurvivesAnyOffChainRestart() public {
        tee.setMachineRegistered(true);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);

        // Nothing off chain persists across this: new extension identity, new coordinator, new
        // caller, new block, new timestamp.
        vm.roll(block.number + 5_000);
        vm.warp(block.timestamp + 7 days);
        tee.setMachineRegistered(false);
        tee.setMachineRegistered(true);

        assertTrue(sender.instructionDispatched(actionId), "the marker did not survive");
        vm.prank(address(0xFEED));
        vm.expectRevert(
            abi.encodeWithSelector(SignetFccInstructionSender.InstructionAlreadyDispatched.selector, actionId)
        );
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(tee.dispatches(), 1, "a restart re-opened the dispatch window");
    }

    /// @notice A reverting TEE lookup must not burn the one allowed dispatch.
    ///
    /// The flag is written before the external call, so if `getRandomTeeIds` reverts the whole
    /// transaction reverts and the write rolls back with it. That is the behaviour we want: no
    /// instruction went out, so eligibility is still intact. Asserting it means a future refactor
    /// that moves the write outside the revert scope, or catches the failure, gets caught here.
    function test_aRevertingTeeLookupDoesNotConsumeDispatchEligibility() public {
        tee.setMachineRegistered(false);

        vm.expectRevert(CountingTeeRegistry.NoTeeMachine.selector);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);

        assertFalse(sender.instructionDispatched(actionId), "a failed dispatch consumed the allowance");
        assertEq(tee.dispatches(), 0, "nothing should have been dispatched");

        // And the obligation is still payable once a machine exists.
        tee.setMachineRegistered(true);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertEq(tee.dispatches(), 1, "a recoverable failure permanently blocked a legitimate payment");
    }

    /// @notice ...and the reverse: once consumed, a reverting lookup cannot reopen it.
    function test_aRevertingTeeLookupCannotReopenDispatchEligibility() public {
        tee.setMachineRegistered(true);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        assertTrue(sender.instructionDispatched(actionId), "precondition: the allowance is consumed");

        // Machine disappears, comes back, disappears again. None of it clears the marker.
        tee.setMachineRegistered(false);
        vm.expectRevert(
            abi.encodeWithSelector(SignetFccInstructionSender.InstructionAlreadyDispatched.selector, actionId)
        );
        sender.authorizeRedemption(REQUEST_ID, GENERATION);

        tee.setMachineRegistered(true);
        vm.expectRevert(
            abi.encodeWithSelector(SignetFccInstructionSender.InstructionAlreadyDispatched.selector, actionId)
        );
        sender.authorizeRedemption(REQUEST_ID, GENERATION);

        assertEq(tee.dispatches(), 1, "TEE availability churn reopened the dispatch window");
    }

    /// @notice A different generation is a different action, and must not be blocked by this one.
    function test_aLaterGenerationIsItsOwnAction() public {
        tee.setMachineRegistered(true);
        sender.authorizeRedemption(REQUEST_ID, GENERATION);
        _authorize();

        registry.recordActionRequested(bindingId, REQUEST_ID, GENERATION + 1, keccak256("obligation-g1"));

        sender.authorizeRedemption(REQUEST_ID, GENERATION + 1);
        assertEq(tee.dispatches(), 2, "a fresh generation must be dispatchable on its own merits");
    }
}

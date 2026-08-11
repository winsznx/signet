// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SignetRegistry} from "../../src/SignetRegistry.sol";

/// @notice The registry's job is to refuse things. These tests are mostly about what it will not do.
/// @dev The registry now requires the pinned instruction sender to be a contract.
contract MockSender {}

contract SignetRegistryTest is Test {
    SignetRegistry internal registry;

    address internal constant GOVERNANCE = address(0x6047);
    address internal sender;
    address internal constant AGENT = address(0xA1);
    address internal constant ASSET_MANAGER = address(0xB1);
    address internal constant STRANGER = address(0xDEAD);
    uint256 internal constant CHAIN_ID = 114;

    bytes32 internal constant CODE_HASH = keccak256("approved-extension-v1");
    bytes32 internal constant OTHER_CODE_HASH = keccak256("some-other-extension");

    uint256 internal signerKey = 0xA11CE;
    address internal signer;
    bytes32 internal bindingId;

    function setUp() public {
        signer = vm.addr(signerKey);
        vm.chainId(CHAIN_ID);
        registry = new SignetRegistry(GOVERNANCE, CHAIN_ID);
        sender = address(new MockSender());

        vm.startPrank(GOVERNANCE);
        registry.setInstructionSender(sender);
        registry.approveCodeHash(CODE_HASH, 7, 1, true);
        registry.approveSigner(signer, true);
        registry.bindAgent(_binding());
        vm.stopPrank();

        bindingId = registry.bindingIdFor(ASSET_MANAGER, AGENT);
    }

    function _binding() internal view returns (SignetRegistry.AgentBinding memory b) {
        b.assetManager = ASSET_MANAGER;
        b.agentVault = AGENT;
        b.flareChainId = CHAIN_ID;
        b.instructionSender = sender;
        b.xrplNetworkId = 1;
        b.extensionId = 7;
        b.approvedCodeHash = CODE_HASH;
        b.policyVersion = 1;
        b.xrplSourceAddress = "rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta";
    }

    function _request(uint256 requestId, uint32 generation) internal returns (bytes32 actionId) {
        vm.prank(sender);
        actionId = registry.recordActionRequested(bindingId, requestId, generation, keccak256("obligation"));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _authorize(bytes32 actionId, bytes32 commitment) internal {
        bytes32 resultHash = keccak256("result");
        bytes32 digest = registry.decisionDigest(actionId, commitment, resultHash, CODE_HASH);
        registry.recordDecision(actionId, commitment, resultHash, CODE_HASH, _sign(signerKey, digest));
    }

    // ------------------------------------------------------------------ access control

    function test_onlyGovernanceCanBind() public {
        vm.prank(STRANGER);
        vm.expectRevert(SignetRegistry.OnlyGovernance.selector);
        registry.bindAgent(_binding());
    }

    function test_onlyGovernanceCanPauseRetireOrApprove() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(SignetRegistry.OnlyGovernance.selector);
        registry.pauseAgent(bindingId, true);
        vm.expectRevert(SignetRegistry.OnlyGovernance.selector);
        registry.retireBinding(bindingId);
        vm.expectRevert(SignetRegistry.OnlyGovernance.selector);
        registry.approveSigner(STRANGER, true);
        vm.expectRevert(SignetRegistry.OnlyGovernance.selector);
        registry.setSystemPaused(true);
        vm.stopPrank();
    }

    function test_onlyTheBoundInstructionSenderCanRequestAnAction() public {
        vm.prank(STRANGER);
        vm.expectRevert(SignetRegistry.OnlyInstructionSender.selector);
        registry.recordActionRequested(bindingId, 1, 0, keccak256("obligation"));
    }

    function test_bindingCannotBeCreatedTwice() public {
        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.BindingExists.selector);
        registry.bindAgent(_binding());
    }

    function test_bindingRequiresAnApprovedCodeHash() public {
        SignetRegistry.AgentBinding memory b = _binding();
        b.agentVault = address(0xA2);
        b.approvedCodeHash = OTHER_CODE_HASH;
        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.CodeHashNotApproved.selector);
        registry.bindAgent(b);
    }

    // ------------------------------------------------------------------ replay

    function test_oneActionPerRequestGeneration() public {
        _request(42, 0);
        vm.prank(sender);
        vm.expectRevert(SignetRegistry.ActionExists.selector);
        registry.recordActionRequested(bindingId, 42, 0, keccak256("obligation"));
    }

    function test_aNewGenerationIsADistinctAction() public {
        bytes32 first = _request(42, 0);
        bytes32 second = _request(42, 1);
        assertTrue(first != second, "generations must not collide");
    }

    function test_actionIdBindsTheChainAndTheBinding() public view {
        bytes32 a = registry.actionIdFor(bindingId, 42, 0);
        bytes32 b = registry.actionIdFor(keccak256("other-binding"), 42, 0);
        assertTrue(a != b, "an action for another binding must be a different action");
    }

    // ------------------------------------------------------------------ pause and retirement

    function test_pausePreventsNewInstructions() public {
        vm.prank(GOVERNANCE);
        registry.pauseAgent(bindingId, true);
        vm.prank(sender);
        vm.expectRevert(SignetRegistry.BindingPaused.selector);
        registry.recordActionRequested(bindingId, 42, 0, keccak256("obligation"));
    }

    function test_systemPausePreventsNewInstructions() public {
        vm.prank(GOVERNANCE);
        registry.setSystemPaused(true);
        vm.prank(sender);
        vm.expectRevert(SignetRegistry.BindingPaused.selector);
        registry.recordActionRequested(bindingId, 42, 0, keccak256("obligation"));
    }

    function test_pauseIsReversible() public {
        vm.prank(GOVERNANCE);
        registry.pauseAgent(bindingId, true);
        vm.prank(GOVERNANCE);
        registry.pauseAgent(bindingId, false);
        bytes32 actionId = _request(42, 0);
        assertTrue(actionId != bytes32(0));
    }

    function test_retirementPreventsNewActionsAndIsTerminal() public {
        vm.prank(GOVERNANCE);
        registry.retireBinding(bindingId);

        vm.prank(sender);
        vm.expectRevert(SignetRegistry.BindingNotActive.selector);
        registry.recordActionRequested(bindingId, 42, 0, keccak256("obligation"));

        // Retirement cannot be undone by unpausing.
        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.BindingNotActive.selector);
        registry.pauseAgent(bindingId, false);
    }

    function test_pauseDoesNotBlockFinalisingWorkAlreadyAuthorized() public {
        bytes32 actionId = _request(42, 0);
        _authorize(actionId, keccak256("commitment"));

        vm.prank(GOVERNANCE);
        registry.pauseAgent(bindingId, true);

        // I-013: verification and reconciliation continue while signing is paused.
        vm.prank(GOVERNANCE);
        registry.recordFinalEvidence(actionId, _evidence());
        assertEq(uint256(registry.actionFor(actionId).state), uint256(SignetRegistry.ActionState.EVIDENCE_FINALIZED));
    }

    // ------------------------------------------------------------------ forged results

    function test_anUnapprovedSignerCannotRecordADecision() public {
        bytes32 actionId = _request(42, 0);
        uint256 rogueKey = 0xBAD;
        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");
        bytes32 digest = registry.decisionDigest(actionId, commitment, resultHash, CODE_HASH);

        vm.expectRevert(SignetRegistry.SignerNotApproved.selector);
        registry.recordDecision(actionId, commitment, resultHash, CODE_HASH, _sign(rogueKey, digest));
    }

    function test_aValidSignatureOverAnotherActionIsRejected() public {
        bytes32 actionA = _request(42, 0);
        bytes32 actionB = _request(43, 0);
        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");

        // Genuinely signed by an approved signer, but for a different action (I-018).
        bytes32 digestForA = registry.decisionDigest(actionA, commitment, resultHash, CODE_HASH);
        vm.expectRevert(SignetRegistry.SignerNotApproved.selector);
        registry.recordDecision(actionB, commitment, resultHash, CODE_HASH, _sign(signerKey, digestForA));
    }

    function test_aRevokedCodeHashCannotRecordADecision() public {
        bytes32 actionId = _request(42, 0);
        vm.prank(GOVERNANCE);
        registry.approveCodeHash(CODE_HASH, 7, 1, false);

        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");
        bytes32 digest = registry.decisionDigest(actionId, commitment, resultHash, CODE_HASH);
        vm.expectRevert(SignetRegistry.CodeHashNotApproved.selector);
        registry.recordDecision(actionId, commitment, resultHash, CODE_HASH, _sign(signerKey, digest));
    }

    function test_aCodeHashTheBindingDidNotApproveIsRejected() public {
        bytes32 actionId = _request(42, 0);
        vm.prank(GOVERNANCE);
        registry.approveCodeHash(OTHER_CODE_HASH, 7, 1, true);

        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");
        bytes32 digest = registry.decisionDigest(actionId, commitment, resultHash, OTHER_CODE_HASH);
        vm.expectRevert(SignetRegistry.CodeHashNotApproved.selector);
        registry.recordDecision(actionId, commitment, resultHash, OTHER_CODE_HASH, _sign(signerKey, digest));
    }

    function test_anEmptyCommitmentIsRejected() public {
        bytes32 actionId = _request(42, 0);
        bytes32 digest = registry.decisionDigest(actionId, bytes32(0), keccak256("result"), CODE_HASH);
        vm.expectRevert(SignetRegistry.EmptyCommitment.selector);
        registry.recordDecision(actionId, bytes32(0), keccak256("result"), CODE_HASH, _sign(signerKey, digest));
    }

    function test_aMalformedSignatureIsRejected() public {
        bytes32 actionId = _request(42, 0);
        bytes32 commitment = keccak256("commitment");
        vm.expectRevert(SignetRegistry.SignerNotApproved.selector);
        registry.recordDecision(actionId, commitment, keccak256("result"), CODE_HASH, hex"00");
    }

    // ------------------------------------------------------------------ lifecycle ordering

    function test_aDecisionCannotBeRecordedTwice() public {
        bytes32 actionId = _request(42, 0);
        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");
        _authorize(actionId, commitment);

        bytes memory signature = _sign(signerKey, registry.decisionDigest(actionId, commitment, resultHash, CODE_HASH));
        vm.expectRevert(SignetRegistry.ActionNotRequested.selector);
        registry.recordDecision(actionId, commitment, resultHash, CODE_HASH, signature);
    }

    function test_aRefusalIsTerminalForItsGeneration() public {
        bytes32 actionId = _request(42, 0);
        bytes32 reason = bytes32("S007_EXPIRED_WINDOW");
        bytes32 digest = registry.refusalDigest(actionId, reason, CODE_HASH);
        registry.recordRefusal(actionId, reason, CODE_HASH, _sign(signerKey, digest));

        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");
        bytes memory signature = _sign(signerKey, registry.decisionDigest(actionId, commitment, resultHash, CODE_HASH));
        vm.expectRevert(SignetRegistry.ActionNotRequested.selector);
        registry.recordDecision(actionId, commitment, resultHash, CODE_HASH, signature);
    }

    function test_evidenceRequiresAnAuthorizedAction() public {
        bytes32 actionId = _request(42, 0);
        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.ActionNotAuthorized.selector);
        registry.recordFinalEvidence(actionId, _evidence());
    }

    function test_evidenceCannotBeFinalizedTwice() public {
        bytes32 actionId = _request(42, 0);
        _authorize(actionId, keccak256("commitment"));
        vm.prank(GOVERNANCE);
        registry.recordFinalEvidence(actionId, _evidence());
        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.EvidenceAlreadyFinalized.selector);
        registry.recordFinalEvidence(actionId, _evidence());
    }

    function test_anUnknownActionCannotBeDecidedOrFinalized() public {
        bytes32 ghost = keccak256("never-requested");
        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");
        bytes memory signature = _sign(signerKey, registry.decisionDigest(ghost, commitment, resultHash, CODE_HASH));

        vm.expectRevert(SignetRegistry.ActionUnknown.selector);
        registry.recordDecision(ghost, commitment, resultHash, CODE_HASH, signature);

        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.ActionUnknown.selector);
        registry.recordFinalEvidence(ghost, _evidence());
    }

    // ------------------------------------------------------------------ objective history

    function test_historyEqualsFinalizedEvidenceAndNothingElse() public {
        assertEq(registry.finalizedEvidenceCount(), 0);

        bytes32 a = _request(1, 0);
        _authorize(a, keccak256("c1"));
        assertEq(registry.finalizedEvidenceCount(), 0, "authorizing must not increment history");

        vm.prank(GOVERNANCE);
        registry.recordFinalEvidence(a, _evidence());
        assertEq(registry.finalizedEvidenceCount(), 1);
        assertEq(registry.finalizedPerBinding(bindingId), 1);

        // A refusal is recorded separately and never inflates the finalized count.
        bytes32 b = _request(2, 0);
        bytes32 reason = bytes32("S004_INACTIVE_REDEMPTION");
        registry.recordRefusal(b, reason, CODE_HASH, _sign(signerKey, registry.refusalDigest(b, reason, CODE_HASH)));
        assertEq(registry.finalizedEvidenceCount(), 1, "a refusal is not a completion");
        assertEq(registry.refusalsPerBinding(bindingId), 1);
    }

    function _evidence() internal pure returns (SignetRegistry.FinalEvidence memory e) {
        e.xrplTxHash = keccak256("xrpl-tx");
        e.xrplValidatedLedger = 19_822_204;
        e.fdcProofHash = keccak256("fdc-proof");
        e.fassetsCompletionTx = keccak256("completion");
        e.finalFAssetsStatus = 2;
    }

    // ------------------------------------------------------------------ no payment authority

    function test_anUnregisteredKeyCannotAuthorizeEvenIfGovernanceSubmitsIt() public {
        bytes32 actionId = _request(42, 0);
        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");
        bytes32 digest = registry.decisionDigest(actionId, commitment, resultHash, CODE_HASH);
        uint256 unregisteredKey = 0x60;
        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.SignerNotApproved.selector);
        registry.recordDecision(actionId, commitment, resultHash, CODE_HASH, _sign(unregisteredKey, digest));
    }

    /// @dev This replaces a test that used to be named "governance cannot authorize anything". That
    ///      name was false: it only showed an *unregistered* key was rejected, and never exercised
    ///      governance calling approveSigner on itself first. An adversarial review demonstrated
    ///      the real path. Governance naming itself is now blocked outright.
    function test_governanceCannotApproveItselfAsASigner() public {
        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.SignerIsGovernance.selector);
        registry.approveSigner(GOVERNANCE, true);
    }

    /// @dev The residual risk, stated as a test so it cannot be forgotten: governance can approve
    ///      any OTHER key it controls, and nothing on chain distinguishes that from an enclave key.
    ///      Closing it needs attestation-bound registration, which is phase 03's blocked half.
    function test_governanceCanStillApproveAnotherKeyItControls_residualRisk() public {
        uint256 governanceControlledKey = 0xC0FFEE;
        address governanceControlled = vm.addr(governanceControlledKey);

        vm.prank(GOVERNANCE);
        registry.approveSigner(governanceControlled, true);

        bytes32 actionId = _request(42, 0);
        bytes32 commitment = keccak256("commitment");
        bytes32 resultHash = keccak256("result");
        bytes32 digest = registry.decisionDigest(actionId, commitment, resultHash, CODE_HASH);
        registry.recordDecision(actionId, commitment, resultHash, CODE_HASH, _sign(governanceControlledKey, digest));

        assertEq(
            uint256(registry.actionFor(actionId).state),
            uint256(SignetRegistry.ActionState.AUTHORIZED),
            "documented residual risk: a governance-controlled signer is indistinguishable from an enclave key on chain"
        );
    }

    // ------------------------------------------------------------------ pinned instruction sender

    function test_theInstructionSenderIsPinnedAndCannotBeChanged() public {
        address another = address(new MockSender());
        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.InstructionSenderAlreadySet.selector);
        registry.setInstructionSender(another);
    }

    function test_bindingIgnoresACallerSuppliedInstructionSender() public {
        // An adversarial review showed governance could bind an EOA it controls and then record
        // obligations FAssets was never asked about. The field is now ignored entirely.
        SignetRegistry.AgentBinding memory b = _binding();
        b.agentVault = address(0xA9);
        b.instructionSender = address(0xBADBAD);
        vm.prank(GOVERNANCE);
        registry.bindAgent(b);

        bytes32 id = registry.bindingIdFor(ASSET_MANAGER, address(0xA9));
        assertEq(registry.binding(id).instructionSender, sender, "the pinned sender must win");

        vm.prank(address(0xBADBAD));
        vm.expectRevert(SignetRegistry.OnlyInstructionSender.selector);
        registry.recordActionRequested(id, 7, 0, keccak256("fabricated"));
    }

    function test_theSenderMustBeAContract() public {
        vm.chainId(CHAIN_ID);
        SignetRegistry fresh = new SignetRegistry(GOVERNANCE, CHAIN_ID);
        vm.prank(GOVERNANCE);
        vm.expectRevert(SignetRegistry.InstructionSenderNotAContract.selector);
        fresh.setInstructionSender(address(0xE0A));
    }

    function test_bindingRequiresThePinnedSender() public {
        vm.chainId(CHAIN_ID);
        SignetRegistry fresh = new SignetRegistry(GOVERNANCE, CHAIN_ID);
        vm.startPrank(GOVERNANCE);
        fresh.approveCodeHash(CODE_HASH, 7, 1, true);
        vm.expectRevert(SignetRegistry.InstructionSenderNotPinned.selector);
        fresh.bindAgent(_binding());
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ chain id

    function test_deployingWithTheWrongChainIdReverts() public {
        vm.chainId(9999);
        vm.expectRevert(SignetRegistry.ChainIdMismatch.selector);
        new SignetRegistry(GOVERNANCE, CHAIN_ID);
    }

    function test_deployingWithTheRightChainIdSucceeds() public {
        vm.chainId(4242);
        SignetRegistry fresh = new SignetRegistry(GOVERNANCE, 4242);
        assertEq(fresh.flareChainId(), 4242);
    }
}

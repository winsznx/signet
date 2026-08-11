// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISignetTypes} from "./interfaces/ISignetTypes.sol";

/// @title SignetRegistry
/// @notice Binding, action lifecycle and evidence registry for Signet.
/// @dev This contract is an authorization and evidence registry. It is deliberately **not** the
///      authoritative FAssets ledger and it is not a payment authority: nothing it can be made to
///      do produces an XRP signature. Governance can bind, pause and retire; governance cannot
///      authorize a payment, and there is no function that accepts payment fields.
///
///      It is immutable. There is no proxy, no `delegatecall` and no arbitrary external call. A new
///      version is a new deployment, per NFR-003.
contract SignetRegistry {
    // ------------------------------------------------------------------ types

    enum BindingStatus {
        NONE,
        ACTIVE,
        PAUSED,
        RETIRED
    }

    /// @dev Lifecycle of one authorization attempt. A generation never moves backwards, and the
    ///      terminal states are final for that generation (PRD section 15.1).
    enum ActionState {
        NONE,
        REQUESTED,
        AUTHORIZED,
        REFUSED,
        EVIDENCE_FINALIZED
    }

    struct AgentBinding {
        address assetManager;
        address agentVault;
        uint256 flareChainId;
        address instructionSender;
        uint32 xrplNetworkId;
        uint256 extensionId;
        bytes32 approvedCodeHash;
        uint32 policyVersion;
        BindingStatus status;
        string xrplSourceAddress;
    }

    struct Action {
        bytes32 bindingId;
        uint256 requestId;
        uint32 requestGeneration;
        ActionState state;
        bytes32 obligationHash;
        bytes32 authorizationCommitment;
        bytes32 resultHash;
        bytes32 reasonCode;
        uint64 createdAt;
    }

    struct FinalEvidence {
        bytes32 xrplTxHash;
        uint64 xrplValidatedLedger;
        bytes32 fdcProofHash;
        bytes32 fassetsCompletionTx;
        uint8 finalFAssetsStatus;
    }

    // ------------------------------------------------------------------ errors

    error OnlyGovernance();
    error OnlyInstructionSender();
    error BindingExists();
    error BindingUnknown();
    error BindingNotActive();
    error BindingPaused();
    error ActionExists();
    error ActionUnknown();
    error ActionNotRequested();
    error ActionNotAuthorized();
    error EvidenceAlreadyFinalized();
    error SignerNotApproved();
    error CodeHashNotApproved();
    error EmptyCommitment();
    error ZeroAddress();
    error ChainIdMismatch();
    error InstructionSenderAlreadySet();
    error InstructionSenderNotAContract();
    error InstructionSenderNotPinned();
    error SignerIsGovernance();

    // ------------------------------------------------------------------ events

    event AgentBound(bytes32 indexed bindingId, address indexed agentVault, address indexed assetManager);
    event AgentPaused(bytes32 indexed bindingId, bool paused);
    event BindingRetired(bytes32 indexed bindingId);
    event ActionRequested(
        bytes32 indexed actionId, uint256 indexed requestId, address indexed agentVault, uint32 generation
    );
    event DecisionRecorded(bytes32 indexed actionId, bytes32 authorizationCommitment, bytes32 resultHash);
    event RefusalRecorded(bytes32 indexed actionId, bytes32 reasonCode);
    event EvidenceFinalized(bytes32 indexed actionId, bytes32 xrplTxHash);
    event PolicyVersionActivated(uint256 indexed extensionId, bytes32 codeHash, uint32 policyVersion);
    event SignerApproved(address indexed signer, bool approved);
    event SystemPaused(bool paused);
    event InstructionSenderPinned(address indexed sender);

    // ------------------------------------------------------------------ storage

    address public immutable governance;
    uint256 public immutable flareChainId;

    bool public systemPaused;

    /// @dev The single contract permitted to open actions. Set once, never changed.
    address public instructionSender;

    mapping(bytes32 => AgentBinding) private bindings;
    mapping(bytes32 => Action) private actions;
    mapping(bytes32 => FinalEvidence) private evidence;

    /// @dev Approved extension code hashes. An unapproved hash can never record a decision.
    mapping(bytes32 => bool) public approvedCodeHash;
    /// @dev Approved TEE result signers.
    mapping(address => bool) public approvedSigner;

    /// @dev Objective execution history, derived only from finalized evidence (I-015).
    uint256 public finalizedEvidenceCount;
    mapping(bytes32 => uint256) public finalizedPerBinding;
    mapping(bytes32 => uint256) public refusalsPerBinding;

    // ------------------------------------------------------------------ modifiers

    modifier onlyGovernance() {
        if (msg.sender != governance) revert OnlyGovernance();
        _;
    }

    /// @param _flareChainId must equal the chain this is being deployed on. Taking it as a
    ///        parameter and checking it, rather than reading block.chainid silently, means a
    ///        deployment script that believes it is on another chain fails at construction instead
    ///        of producing digests that verify on both.
    constructor(address _governance, uint256 _flareChainId) {
        if (_governance == address(0)) revert ZeroAddress();
        if (_flareChainId != block.chainid) revert ChainIdMismatch();
        governance = _governance;
        flareChainId = _flareChainId;
    }

    /// @notice Pins the one contract allowed to open actions. One-shot: governance cannot later
    ///         point the registry at an address it controls directly.
    /// @dev Without this, `recordActionRequested`'s only gate is `msg.sender == binding.instructionSender`,
    ///      and that field was free-form calldata. Governance could bind an EOA and record
    ///      obligations that FAssets was never asked about. An adversarial review demonstrated
    ///      exactly that, so the sender is now pinned once and checked on every bind.
    function setInstructionSender(address _sender) external onlyGovernance {
        if (_sender == address(0)) revert ZeroAddress();
        if (instructionSender != address(0)) revert InstructionSenderAlreadySet();
        if (_sender.code.length == 0) revert InstructionSenderNotAContract();
        instructionSender = _sender;
        emit InstructionSenderPinned(_sender);
    }

    // ------------------------------------------------------------------ identifiers

    /// @notice One binding per (assetManager, agentVault) on this chain.
    function bindingIdFor(address _assetManager, address _agentVault) public view returns (bytes32) {
        return keccak256(abi.encode("SIGNET_BINDING_V1", flareChainId, _assetManager, _agentVault));
    }

    /// @notice One action per (binding, requestId, generation). This is the replay guard: the id
    ///         itself carries the generation, so a repeat cannot be created (I-009).
    function actionIdFor(bytes32 _bindingId, uint256 _requestId, uint32 _generation) public view returns (bytes32) {
        return keccak256(abi.encode("SIGNET_ACTION_V1", flareChainId, _bindingId, _requestId, _generation));
    }

    // ------------------------------------------------------------------ governance

    function bindAgent(AgentBinding calldata _binding) external onlyGovernance {
        if (_binding.agentVault == address(0) || _binding.assetManager == address(0)) revert ZeroAddress();
        if (instructionSender == address(0)) revert InstructionSenderNotPinned();
        // The caller's value is ignored entirely; the pinned sender is authoritative.
        if (!approvedCodeHash[_binding.approvedCodeHash]) revert CodeHashNotApproved();

        bytes32 bindingId = bindingIdFor(_binding.assetManager, _binding.agentVault);
        if (bindings[bindingId].status != BindingStatus.NONE) revert BindingExists();

        AgentBinding storage stored = bindings[bindingId];
        stored.assetManager = _binding.assetManager;
        stored.agentVault = _binding.agentVault;
        // The binding is pinned to this contract's own chain id, so a binding cannot be replayed
        // from another chain's deployment (I-011).
        stored.flareChainId = flareChainId;
        stored.instructionSender = instructionSender;
        stored.xrplNetworkId = _binding.xrplNetworkId;
        stored.extensionId = _binding.extensionId;
        stored.approvedCodeHash = _binding.approvedCodeHash;
        stored.policyVersion = _binding.policyVersion;
        stored.status = BindingStatus.ACTIVE;
        stored.xrplSourceAddress = _binding.xrplSourceAddress;

        emit AgentBound(bindingId, _binding.agentVault, _binding.assetManager);
    }

    function pauseAgent(bytes32 _bindingId, bool _paused) external onlyGovernance {
        AgentBinding storage binding = bindings[_bindingId];
        if (binding.status == BindingStatus.NONE) revert BindingUnknown();
        // Retirement is terminal; pausing cannot revive it.
        if (binding.status == BindingStatus.RETIRED) revert BindingNotActive();
        binding.status = _paused ? BindingStatus.PAUSED : BindingStatus.ACTIVE;
        emit AgentPaused(_bindingId, _paused);
    }

    function retireBinding(bytes32 _bindingId) external onlyGovernance {
        AgentBinding storage binding = bindings[_bindingId];
        if (binding.status == BindingStatus.NONE) revert BindingUnknown();
        binding.status = BindingStatus.RETIRED;
        emit BindingRetired(_bindingId);
    }

    function setSystemPaused(bool _paused) external onlyGovernance {
        systemPaused = _paused;
        emit SystemPaused(_paused);
    }

    function approveCodeHash(bytes32 _codeHash, uint256 _extensionId, uint32 _policyVersion, bool _approved)
        external
        onlyGovernance
    {
        approvedCodeHash[_codeHash] = _approved;
        emit PolicyVersionActivated(_extensionId, _codeHash, _policyVersion);
    }

    /// @notice Approves a TEE result signer.
    /// @dev Blocks the one case that is detectable on chain: governance naming itself. It cannot
    ///      block governance naming another key it controls, because nothing on chain distinguishes
    ///      that from a genuine enclave key. Closing that gap needs attestation-bound signer
    ///      registration, which is phase 03's blocked half. Until then this is accepted residual
    ///      risk, recorded in docs/evidence/phase-06.md rather than papered over.
    function approveSigner(address _signer, bool _approved) external onlyGovernance {
        if (_signer == address(0)) revert ZeroAddress();
        if (_signer == governance) revert SignerIsGovernance();
        approvedSigner[_signer] = _approved;
        emit SignerApproved(_signer, _approved);
    }

    // ------------------------------------------------------------------ action lifecycle

    /// @notice Records that an action was requested for an obligation.
    /// @dev Callable only by the instruction sender named in the binding. Note what is absent: no
    ///      destination, no amount, no memo, no tag. The registry never learns a payment field from
    ///      a caller, so no caller can influence one (FR-010).
    function recordActionRequested(bytes32 _bindingId, uint256 _requestId, uint32 _generation, bytes32 _obligationHash)
        external
        returns (bytes32 actionId)
    {
        AgentBinding storage binding = bindings[_bindingId];
        if (binding.status == BindingStatus.NONE) revert BindingUnknown();
        if (msg.sender != binding.instructionSender) revert OnlyInstructionSender();
        if (systemPaused) revert BindingPaused();
        if (binding.status == BindingStatus.PAUSED) revert BindingPaused();
        if (binding.status == BindingStatus.RETIRED) revert BindingNotActive();

        actionId = actionIdFor(_bindingId, _requestId, _generation);
        if (actions[actionId].state != ActionState.NONE) revert ActionExists();

        actions[actionId] = Action({
            bindingId: _bindingId,
            requestId: _requestId,
            requestGeneration: _generation,
            state: ActionState.REQUESTED,
            obligationHash: _obligationHash,
            authorizationCommitment: bytes32(0),
            resultHash: bytes32(0),
            reasonCode: bytes32(0),
            createdAt: uint64(block.timestamp)
        });

        emit ActionRequested(actionId, _requestId, binding.agentVault, _generation);
    }

    /// @notice Records a signed authorization from an approved extension.
    /// @dev The signature must come from an approved signer over the exact action id, commitment
    ///      and result hash. A valid signature over a different action is rejected, which is I-018.
    function recordDecision(
        bytes32 _actionId,
        bytes32 _authorizationCommitment,
        bytes32 _resultHash,
        bytes32 _codeHash,
        bytes calldata _signature
    ) external {
        Action storage action = actions[_actionId];
        if (action.state == ActionState.NONE) revert ActionUnknown();
        if (action.state != ActionState.REQUESTED) revert ActionNotRequested();
        if (_authorizationCommitment == bytes32(0)) revert EmptyCommitment();
        if (!approvedCodeHash[_codeHash]) revert CodeHashNotApproved();

        AgentBinding storage binding = bindings[action.bindingId];
        if (binding.approvedCodeHash != _codeHash) revert CodeHashNotApproved();

        bytes32 digest = decisionDigest(_actionId, _authorizationCommitment, _resultHash, _codeHash);
        address signer = _recover(digest, _signature);
        if (!approvedSigner[signer]) revert SignerNotApproved();

        action.state = ActionState.AUTHORIZED;
        action.authorizationCommitment = _authorizationCommitment;
        action.resultHash = _resultHash;

        emit DecisionRecorded(_actionId, _authorizationCommitment, _resultHash);
    }

    /// @notice Records a typed refusal. A refusal is terminal for its generation.
    function recordRefusal(bytes32 _actionId, bytes32 _reasonCode, bytes32 _codeHash, bytes calldata _signature)
        external
    {
        Action storage action = actions[_actionId];
        if (action.state == ActionState.NONE) revert ActionUnknown();
        if (action.state != ActionState.REQUESTED) revert ActionNotRequested();
        if (!approvedCodeHash[_codeHash]) revert CodeHashNotApproved();

        bytes32 digest = refusalDigest(_actionId, _reasonCode, _codeHash);
        address signer = _recover(digest, _signature);
        if (!approvedSigner[signer]) revert SignerNotApproved();

        action.state = ActionState.REFUSED;
        action.reasonCode = _reasonCode;
        refusalsPerBinding[action.bindingId] += 1;

        emit RefusalRecorded(_actionId, _reasonCode);
    }

    /// @notice Records the final evidence for an authorized action.
    /// @dev Only an authorized action can be finalized, and only once. The objective history is
    ///      incremented here and nowhere else, so it can only ever equal the number of finalized
    ///      evidence records (I-015).
    function recordFinalEvidence(bytes32 _actionId, FinalEvidence calldata _evidence) external onlyGovernance {
        Action storage action = actions[_actionId];
        if (action.state == ActionState.NONE) revert ActionUnknown();
        if (action.state == ActionState.EVIDENCE_FINALIZED) revert EvidenceAlreadyFinalized();
        if (action.state != ActionState.AUTHORIZED) revert ActionNotAuthorized();
        if (_evidence.xrplTxHash == bytes32(0)) revert EmptyCommitment();

        action.state = ActionState.EVIDENCE_FINALIZED;
        evidence[_actionId] = _evidence;
        finalizedEvidenceCount += 1;
        finalizedPerBinding[action.bindingId] += 1;

        emit EvidenceFinalized(_actionId, _evidence.xrplTxHash);
    }

    // ------------------------------------------------------------------ digests

    function decisionDigest(bytes32 _actionId, bytes32 _commitment, bytes32 _resultHash, bytes32 _codeHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                "SIGNET_DECISION_V1", flareChainId, address(this), _actionId, _commitment, _resultHash, _codeHash
            )
        );
    }

    function refusalDigest(bytes32 _actionId, bytes32 _reasonCode, bytes32 _codeHash) public view returns (bytes32) {
        return
            keccak256(abi.encode("SIGNET_REFUSAL_V1", flareChainId, address(this), _actionId, _reasonCode, _codeHash));
    }

    // ------------------------------------------------------------------ views

    function bindingFor(address _assetManager, address _agentVault) external view returns (AgentBinding memory) {
        return bindings[bindingIdFor(_assetManager, _agentVault)];
    }

    function binding(bytes32 _bindingId) external view returns (AgentBinding memory) {
        return bindings[_bindingId];
    }

    function actionFor(bytes32 _actionId) external view returns (Action memory) {
        return actions[_actionId];
    }

    function finalEvidence(bytes32 _actionId) external view returns (FinalEvidence memory) {
        return evidence[_actionId];
    }

    // ------------------------------------------------------------------ internal

    /// @dev ECDSA recovery with the low-s and valid-v checks that prevent signature malleability.
    function _recover(bytes32 _digest, bytes calldata _signature) private pure returns (address) {
        if (_signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(_signature.offset)
            s := calldataload(add(_signature.offset, 32))
            v := byte(0, calldataload(add(_signature.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(_digest, v, r, s);
    }
}

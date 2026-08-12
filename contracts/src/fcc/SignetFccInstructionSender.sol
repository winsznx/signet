// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeeExtensionRegistry} from "./interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "./interfaces/ITeeMachineRegistry.sol";
import {SignetRegistry} from "../SignetRegistry.sol";
import {FAssetsAdapter} from "../adapters/FAssetsAdapter.sol";
import {ISignetTypes} from "../interfaces/ISignetTypes.sol";

/// @title SignetFccInstructionSender
/// @notice On-chain entry point for sending Signet redemption instructions to a Flare Confidential
///         Compute extension.
///
/// @dev This is distinct from `SignetInstructionSender`, and the two are not interchangeable.
///      `SignetInstructionSender` opens an action in Signet's own registry after reading the
///      obligation from FAssets. This contract carries that instruction into FCC. Keeping them
///      separate means the FAssets read and the FCC transport can be audited independently, and
///      neither can quietly acquire the other's authority.
///
///      The constructor, `setExtensionId()` and `_getExtensionId()` follow the pinned scaffold
///      exactly. The scaffold marks them DO NOT MODIFY, and the one-shot binding in particular has
///      no reset: bound to a stale value the contract must be redeployed, and reads keep working, so
///      a mistake here hides until someone sends an instruction.
contract SignetFccInstructionSender {
    using FAssetsAdapter for address;

    /// @notice The obligation as this contract resolved it from FAssets, ABI-encoded and sent to FCC.
    ///
    /// @dev Every field here comes from `redemptionRequestInfoExt` on the asset manager or from
    ///      Signet's own registry. None of it is reachable by a caller. This struct is the canonical
    ///      instruction payload: the extension decodes it and derives the payment from these values
    ///      and nothing else.
    struct CanonicalInstruction {
        uint256 schemaVersion;
        uint256 flareChainId;
        address assetManager;
        address instructionSender;
        address agentVault;
        uint256 requestId;
        uint32 requestGeneration;
        bytes32 actionId;
        bytes32 obligationHash;
        string paymentAddress;
        bytes32 paymentReference;
        uint256 valueUBA;
        uint256 feeUBA;
        uint64 firstUnderlyingBlock;
        uint64 lastUnderlyingBlock;
        uint64 lastUnderlyingTimestamp;
        bool requiresDestinationTag;
        uint256 destinationTag;
        uint8 assetMintingDecimals;
        string xrplSourceAddress;
        uint32 xrplNetworkId;
        uint256 extensionId;
        bytes32 approvedCodeHash;
        uint32 policyVersion;
    }
    /// @notice Signet's single op-type. There is no second one.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_SIGNET_REDEMPTION = bytes32("SIGNET_REDEMPTION");

    /// @notice The only command that can produce a payment authorization.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_AUTHORIZE_REDEMPTION = bytes32("AUTHORIZE_REDEMPTION");

    /// @notice A read-only liveness command. It cannot authorize anything.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_HEALTH_CHECK = bytes32("HEALTH_CHECK");

    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice Signet's own registry. An instruction may only concern an obligation it already knows.
    SignetRegistry public immutable SIGNET_REGISTRY;

    /// @notice The asset manager the bound obligations belong to.
    address public immutable ASSET_MANAGER;

    /// @dev The registry reserves ids below this for system extensions.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;

    uint256 private _extensionId;

    error ExtensionIdAlreadySet();
    error NoSuchAction();
    error ExtensionIdNotFound();
    error ExtensionIdNotSet();
    error ZeroAddress();
    error NotAContract();
    error AdapterRefused(ISignetTypes.AdapterFailure failure);
    error BindingNotActive();

    /// @notice Schema version of the canonical instruction payload.
    uint256 public constant SCHEMA_VERSION = 2;

    /// @notice Ties an FCC instruction to the Signet action it concerns, so the on-chain record
    ///         links the obligation to the instruction without anyone having to trust the message.
    event RedemptionInstructionSent(
        bytes32 indexed actionId, address indexed agentVault, uint256 indexed requestId, uint32 generation
    );

    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry,
        SignetRegistry _signetRegistry,
        address _assetManager
    ) {
        if (
            address(_teeExtensionRegistry) == address(0) || address(_teeMachineRegistry) == address(0)
                || address(_signetRegistry) == address(0) || _assetManager == address(0)
        ) {
            revert ZeroAddress();
        }
        if (
            address(_teeExtensionRegistry).code.length == 0 || address(_teeMachineRegistry).code.length == 0
                || address(_signetRegistry).code.length == 0
        ) {
            revert NotAContract();
        }
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
        SIGNET_REGISTRY = _signetRegistry;
        ASSET_MANAGER = _assetManager;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// @dev DO NOT MODIFY. Follows the pinned scaffold.
    function setExtensionId() external {
        if (_extensionId != 0) revert ExtensionIdAlreadySet();

        uint256 next = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < next; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert ExtensionIdNotFound();
    }

    function extensionId() external view returns (uint256) {
        return _extensionId;
    }

    /// @notice Authorizes one FAssets redemption. **The caller supplies only the request id.**
    ///
    /// @param _requestId the FAssets redemption request id
    /// @param _generation the request generation, which the registry's action state constrains
    ///
    /// @dev This function is the whole point of Gate B, and its history is worth stating.
    ///
    ///      The first version took the entire decision input as a caller-supplied blob and relayed
    ///      it. The second checked that the named obligation existed but still relayed the blob. In
    ///      both, an untrusted caller chose the destination, the amount, the reference, the tag and
    ///      the window, and `decide()` checked those values for internal consistency rather than for
    ///      truth. That is not a signing boundary; it is a signing service with extra steps.
    ///
    ///      Now there is no blob. The obligation is resolved here, from
    ///      `redemptionRequestInfoExt` on the asset manager, and the instruction payload is built by
    ///      this contract from what FAssets returned and what Signet's own registry holds. A caller
    ///      cannot express a destination, an amount, a reference, a tag, a window or an agent,
    ///      because there is no parameter that carries one and the payload is not theirs to write.
    ///
    ///      The agent is not a parameter either: it is read from the obligation. Passing one would
    ///      let a caller aim a real request at a binding of their choosing.
    function authorizeRedemption(uint256 _requestId, uint32 _generation) external payable returns (bytes32) {
        // The obligation, from FAssets. `readCanonicalRedemptionById` resolves the agent from the
        // request rather than accepting one, so identity comes from the protocol.
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory redemption) =
            ASSET_MANAGER.readCanonicalRedemptionById(_requestId);
        if (failure != ISignetTypes.AdapterFailure.NONE) revert AdapterRefused(failure);

        bytes32 bindingId = SIGNET_REGISTRY.bindingIdFor(ASSET_MANAGER, redemption.agentVault);
        SignetRegistry.AgentBinding memory agentBinding = SIGNET_REGISTRY.binding(bindingId);
        if (agentBinding.status != SignetRegistry.BindingStatus.ACTIVE) revert BindingNotActive();

        bytes32 actionId = SIGNET_REGISTRY.actionIdFor(bindingId, _requestId, _generation);
        SignetRegistry.Action memory action = SIGNET_REGISTRY.actionFor(actionId);
        if (action.state == SignetRegistry.ActionState.NONE) revert NoSuchAction();

        CanonicalInstruction memory instruction = CanonicalInstruction({
            schemaVersion: SCHEMA_VERSION,
            flareChainId: block.chainid,
            assetManager: ASSET_MANAGER,
            instructionSender: agentBinding.instructionSender,
            agentVault: redemption.agentVault,
            requestId: _requestId,
            requestGeneration: _generation,
            actionId: actionId,
            obligationHash: action.obligationHash,
            paymentAddress: redemption.paymentAddress,
            paymentReference: redemption.paymentReference,
            valueUBA: redemption.valueUBA,
            feeUBA: redemption.feeUBA,
            firstUnderlyingBlock: redemption.firstUnderlyingBlock,
            lastUnderlyingBlock: redemption.lastUnderlyingBlock,
            lastUnderlyingTimestamp: redemption.lastUnderlyingTimestamp,
            requiresDestinationTag: redemption.mode == ISignetTypes.RedemptionMode.DESTINATION_TAG,
            destinationTag: redemption.destinationTag,
            assetMintingDecimals: ASSET_MANAGER.assetMintingDecimals(),
            xrplSourceAddress: agentBinding.xrplSourceAddress,
            xrplNetworkId: agentBinding.xrplNetworkId,
            extensionId: agentBinding.extensionId,
            approvedCodeHash: agentBinding.approvedCodeHash,
            policyVersion: agentBinding.policyVersion
        });

        emit RedemptionInstructionSent(actionId, redemption.agentVault, _requestId, _generation);

        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_requireExtensionId(), 1);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_SIGNET_REDEMPTION,
            opCommand: OP_COMMAND_AUTHORIZE_REDEMPTION,
            message: abi.encode(instruction),
            cosigners: new address[](0),
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        return TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    /// @notice The canonical instruction this contract would send for a request, without sending it.
    /// @dev Exists so the invariant "two callers, one payload" is testable without a TEE machine.
    function canonicalInstructionFor(uint256 _requestId, uint32 _generation)
        external
        view
        returns (CanonicalInstruction memory instruction)
    {
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory redemption) =
            ASSET_MANAGER.readCanonicalRedemptionById(_requestId);
        if (failure != ISignetTypes.AdapterFailure.NONE) revert AdapterRefused(failure);

        bytes32 bindingId = SIGNET_REGISTRY.bindingIdFor(ASSET_MANAGER, redemption.agentVault);
        SignetRegistry.AgentBinding memory agentBinding = SIGNET_REGISTRY.binding(bindingId);
        bytes32 actionId = SIGNET_REGISTRY.actionIdFor(bindingId, _requestId, _generation);

        instruction = CanonicalInstruction({
            schemaVersion: SCHEMA_VERSION,
            flareChainId: block.chainid,
            assetManager: ASSET_MANAGER,
            instructionSender: agentBinding.instructionSender,
            agentVault: redemption.agentVault,
            requestId: _requestId,
            requestGeneration: _generation,
            actionId: actionId,
            obligationHash: SIGNET_REGISTRY.actionFor(actionId).obligationHash,
            paymentAddress: redemption.paymentAddress,
            paymentReference: redemption.paymentReference,
            valueUBA: redemption.valueUBA,
            feeUBA: redemption.feeUBA,
            firstUnderlyingBlock: redemption.firstUnderlyingBlock,
            lastUnderlyingBlock: redemption.lastUnderlyingBlock,
            lastUnderlyingTimestamp: redemption.lastUnderlyingTimestamp,
            requiresDestinationTag: redemption.mode == ISignetTypes.RedemptionMode.DESTINATION_TAG,
            destinationTag: redemption.destinationTag,
            assetMintingDecimals: ASSET_MANAGER.assetMintingDecimals(),
            xrplSourceAddress: agentBinding.xrplSourceAddress,
            xrplNetworkId: agentBinding.xrplNetworkId,
            extensionId: agentBinding.extensionId,
            approvedCodeHash: agentBinding.approvedCodeHash,
            policyVersion: agentBinding.policyVersion
        });
    }

    /// @notice Asks the extension whether it is alive. Carries no obligation and returns no payment.
    function healthCheck() external payable returns (bytes32) {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_requireExtensionId(), 1);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_SIGNET_REDEMPTION,
            opCommand: OP_COMMAND_HEALTH_CHECK,
            message: "",
            cosigners: new address[](0),
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        return TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    function _requireExtensionId() private view returns (uint256) {
        uint256 id = _extensionId;
        if (id == 0) revert ExtensionIdNotSet();
        return id;
    }
}

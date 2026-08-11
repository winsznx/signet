// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeeExtensionRegistry} from "./interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "./interfaces/ITeeMachineRegistry.sol";
import {SignetRegistry} from "../SignetRegistry.sol";

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

    /// @notice Carries one Signet authorization instruction into FCC, for an obligation that already
    ///         exists as an action in Signet's registry.
    ///
    /// @param _agentVault the agent the obligation belongs to
    /// @param _requestId the FAssets redemption request id
    /// @param _generation the request generation
    /// @param _message the canonical Signet decision input
    ///
    /// @dev An earlier version of this function took `_message` alone and relayed it unmodified. A
    ///      security review was right to call that an unauthenticated signing-decision relay: the
    ///      message is the whole decision input, so any caller could invent an obligation identity
    ///      and receive a signature for it. It also carried a comment claiming the opposite, which
    ///      was worse than the code.
    ///
    ///      The obligation identity is now a parameter and is checked against `SignetRegistry`,
    ///      where an action can only exist if the pinned `SignetInstructionSender` opened it after
    ///      reading the obligation from FAssets. A caller can no longer name an obligation that does
    ///      not exist.
    ///
    ///      What this does NOT do is verify the rest of the snapshot inside `_message`. The
    ///      destination, amount and window still arrive from whoever built the input, and
    ///      `decide()` checks their internal consistency rather than their truth. That gap is
    ///      recorded in `docs/threat-model.md` and is not closed here; this function narrows who can
    ///      invoke it and to which obligations, which is the part that was newly broken.
    function authorizeRedemption(address _agentVault, uint256 _requestId, uint32 _generation, bytes calldata _message)
        external
        payable
        returns (bytes32)
    {
        bytes32 bindingId = SIGNET_REGISTRY.bindingIdFor(ASSET_MANAGER, _agentVault);
        bytes32 actionId = SIGNET_REGISTRY.actionIdFor(bindingId, _requestId, _generation);
        if (SIGNET_REGISTRY.actionFor(actionId).state == SignetRegistry.ActionState.NONE) revert NoSuchAction();

        emit RedemptionInstructionSent(actionId, _agentVault, _requestId, _generation);

        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_requireExtensionId(), 1);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_SIGNET_REDEMPTION,
            opCommand: OP_COMMAND_AUTHORIZE_REDEMPTION,
            message: _message,
            cosigners: new address[](0),
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        return TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
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

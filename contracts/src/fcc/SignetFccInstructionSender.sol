// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeeExtensionRegistry} from "./interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "./interfaces/ITeeMachineRegistry.sol";

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

    /// @dev The registry reserves ids below this for system extensions.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;

    uint256 private _extensionId;

    error ExtensionIdAlreadySet();
    error ExtensionIdNotFound();
    error ExtensionIdNotSet();
    error ZeroAddress();
    error NotAContract();

    constructor(ITeeExtensionRegistry _teeExtensionRegistry, ITeeMachineRegistry _teeMachineRegistry) {
        if (address(_teeExtensionRegistry) == address(0) || address(_teeMachineRegistry) == address(0)) {
            revert ZeroAddress();
        }
        if (address(_teeExtensionRegistry).code.length == 0 || address(_teeMachineRegistry).code.length == 0) {
            revert NotAContract();
        }
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
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

    /// @notice Carries one Signet authorization instruction into FCC.
    ///
    /// @param _message the canonical Signet decision input, encoded by the caller.
    ///
    /// @dev The caller supplies the message and nothing else. There is no parameter here for a
    ///      destination, an amount or a payment field of any kind: the extension derives every one
    ///      of those from the FAssets obligation named inside the message, and a setter on this
    ///      contract would be the arbitrary signing endpoint the whole design exists to not have.
    function authorizeRedemption(bytes calldata _message) external payable returns (bytes32) {
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

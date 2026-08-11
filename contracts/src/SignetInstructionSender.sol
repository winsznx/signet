// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FAssetsAdapter} from "./adapters/FAssetsAdapter.sol";
import {ISignetTypes} from "./interfaces/ISignetTypes.sol";
import {SignetRegistry} from "./SignetRegistry.sol";

/// @title SignetInstructionSender
/// @notice The only public entry point that can start a signing action.
/// @dev Its entire security value is in its signature: `requestRedemptionSignature(uint256)`. There
///      is no overload that takes a destination, an amount, a memo or a tag, so there is no calldata
///      a compromised host can craft that changes what gets paid (FR-010).
///
///      It is deliberately callable by anyone. A lawful obligation should be payable without
///      trusting a privileged operator to trigger it, and since every payment field is read from
///      FAssets, an unauthorized caller can at most cause Signet to pay an obligation the agent
///      already owes.
///
///      Immutable, no proxy, no delegatecall, no arbitrary external call.
contract SignetInstructionSender {
    using FAssetsAdapter for address;

    error AdapterRefused(ISignetTypes.AdapterFailure failure);
    error BindingNotActive();
    error ZeroAddress();

    event RedemptionSignatureRequested(
        bytes32 indexed actionId,
        uint256 indexed requestId,
        address indexed agentVault,
        uint32 generation,
        bytes32 obligationHash
    );

    SignetRegistry public immutable registry;
    address public immutable assetManager;
    uint256 public immutable flareChainId;

    constructor(address _registry, address _assetManager) {
        if (_registry == address(0) || _assetManager == address(0)) revert ZeroAddress();
        registry = SignetRegistry(_registry);
        assetManager = _assetManager;
        flareChainId = SignetRegistry(_registry).flareChainId();
    }

    /// @notice Starts an authorization for an existing FAssets redemption.
    /// @param _requestId the FAssets redemption request id. The only thing a caller supplies.
    /// @param _agentVault the agent the obligation must belong to, checked against FAssets itself
    /// @param _generation the request generation; a replacement is a new generation, and the
    ///        registry rejects a repeat of one already recorded
    function requestRedemptionSignature(uint256 _requestId, address _agentVault, uint32 _generation)
        external
        returns (bytes32 actionId)
    {
        bytes32 bindingId = registry.bindingIdFor(assetManager, _agentVault);
        SignetRegistry.AgentBinding memory binding = registry.binding(bindingId);
        if (binding.status != SignetRegistry.BindingStatus.ACTIVE) revert BindingNotActive();

        // Every payment field comes from here and nowhere else.
        (ISignetTypes.AdapterFailure failure, ISignetTypes.CanonicalRedemption memory redemption) =
            assetManager.readCanonicalRedemption(_requestId, _agentVault);
        if (failure != ISignetTypes.AdapterFailure.NONE) revert AdapterRefused(failure);

        bytes32 obligationHash = obligationHashFor(_agentVault, _requestId, _generation);

        actionId = registry.recordActionRequested(bindingId, _requestId, _generation, obligationHash);

        emit RedemptionSignatureRequested(actionId, _requestId, _agentVault, _generation, obligationHash);
        // `redemption` is deliberately not emitted. Every field in it is already public in FAssets,
        // and re-emitting it here would create a second source of truth for values that must only
        // ever be read from the AssetManager.
        redemption;
    }

    /// @notice The obligation hash, matching the reference model's `SIGNET_FASSETS_OBLIGATION_V1`.
    /// @dev Field order and widths are fixed by docs/adr/0001-canonical-encoding.md. The reference
    ///      model and this contract must produce the same value for the same obligation, and
    ///      `contracts/test/unit/ObligationHashParity.t.sol` holds them to it.
    function obligationHashFor(address _agentVault, uint256 _requestId, uint32 _generation)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                keccak256("SIGNET_FASSETS_OBLIGATION_V1"),
                uint8(1),
                bytes32(flareChainId),
                assetManager,
                _agentVault,
                bytes32(_requestId),
                _generation
            )
        );
    }
}

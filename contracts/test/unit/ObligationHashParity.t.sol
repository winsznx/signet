// SPDX-License-Identifier: MIT
// NOTE ON V2: the reference model moved to schema version 2 when the underlying-payment
// observation was bound into the authorization commitment. The obligation preimage did not move.
// Its version byte is frozen at 1 precisely so that this contract, which is deployed on Coston2 at
// an address nobody can change, keeps agreeing with the model. These vectors are unchanged across
// the V2 fork, and that is the property being asserted.
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SignetInstructionSender} from "../../src/SignetInstructionSender.sol";
import {SignetRegistry} from "../../src/SignetRegistry.sol";

/// @notice Holds the Solidity obligation hash to the reference model, byte for byte.
///
/// @dev The expected values below were produced by `reference/src/encoding.ts` and are pasted here
///      as literals on purpose. Deriving them in Solidity would only prove that two copies of the
///      same idea agree; a literal fails the moment either side's encoding moves, which is exactly
///      the alarm ADR 0001 is asking for.
///
///      This is the seam where a cross-language encoding bug would otherwise hide until the
///      extension's signature failed to verify on chain, long after the payment had gone out.
contract ObligationHashParityTest is Test {
    SignetInstructionSender internal sender;

    uint256 internal constant CHAIN_ID = 114;
    address internal constant ASSET_MANAGER_A = 0x00000000000000000000000000000000000000B1;
    address internal constant AGENT_A = 0x00000000000000000000000000000000000000A1;

    address internal constant ASSET_MANAGER_LIVE = 0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA;
    address internal constant AGENT_LIVE = 0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC;

    function _senderFor(address assetManager) internal returns (SignetInstructionSender) {
        // The registry now refuses to deploy on a chain other than the one it is told about, so the
        // test environment has to actually be that chain.
        vm.chainId(CHAIN_ID);
        SignetRegistry registry = new SignetRegistry(address(0x6047), CHAIN_ID);
        return new SignetInstructionSender(address(registry), assetManager);
    }

    function test_matchesTheReferenceModelForASyntheticObligation() public {
        sender = _senderFor(ASSET_MANAGER_A);
        assertEq(
            sender.obligationHashFor(AGENT_A, 4242, 0),
            0x31e3d860072262eeb11afc5e250c3d7e4c884b9702fc4fbc24c0da966c0e9f75,
            "synthetic obligation hash drifted from the reference model"
        );
    }

    function test_matchesTheReferenceModelForTheRealCoston2Obligation() public {
        sender = _senderFor(ASSET_MANAGER_LIVE);
        // The obligation decoded from live Coston2 in phase 02.
        assertEq(
            sender.obligationHashFor(AGENT_LIVE, 44_851_498, 0),
            0x77f552171323c53f688fb2a9edfdde983665c2a740cc50d94f1247cec5c7f957,
            "real obligation hash drifted from the reference model"
        );
    }

    function test_generationChangesTheHash() public {
        sender = _senderFor(ASSET_MANAGER_LIVE);
        assertEq(
            sender.obligationHashFor(AGENT_LIVE, 44_851_498, 3),
            0x1375aabe90d1342c258043f72dbf53c52d3a718f5d621949fd367ad1e2bc7a55,
            "generation 3 hash drifted from the reference model"
        );
        assertTrue(
            sender.obligationHashFor(AGENT_LIVE, 44_851_498, 0) != sender.obligationHashFor(AGENT_LIVE, 44_851_498, 3),
            "a replacement generation must not share an obligation hash"
        );
    }

    function test_everyFieldMovesTheHash() public {
        sender = _senderFor(ASSET_MANAGER_LIVE);
        bytes32 base = sender.obligationHashFor(AGENT_LIVE, 44_851_498, 0);

        assertTrue(sender.obligationHashFor(AGENT_A, 44_851_498, 0) != base, "agent vault must be bound");
        assertTrue(sender.obligationHashFor(AGENT_LIVE, 44_851_499, 0) != base, "request id must be bound");
        assertTrue(sender.obligationHashFor(AGENT_LIVE, 44_851_498, 1) != base, "generation must be bound");

        // A different asset manager means a different deployment of this sender.
        SignetInstructionSender other = _senderFor(ASSET_MANAGER_A);
        assertTrue(other.obligationHashFor(AGENT_LIVE, 44_851_498, 0) != base, "asset manager must be bound");
    }
}

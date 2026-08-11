// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Compilation anchor for the pinned upstream protocol interfaces.
//
// Signet never re-declares an upstream interface. Everything the protocol seams touch is imported
// from the commit pinned in docs/source-lock.json, so `forge build` produces artifacts whose ABIs
// and selectors are derived from official source rather than transcribed by hand.
// scripts/resolve-coston2.mjs reads those artifacts and checks each selector against live code.

import {IAssetManager} from "@flare-periphery/coston2/IAssetManager.sol";
import {IAssetManagerController} from "@flare-periphery/coston2/IAssetManagerController.sol";
import {IAssetManagerEvents} from "@flare-periphery/coston2/IAssetManagerEvents.sol";
import {IAgentOwnerRegistry} from "@flare-periphery/coston2/IAgentOwnerRegistry.sol";
import {IFdcHub} from "@flare-periphery/coston2/IFdcHub.sol";
import {IFdcRequestFeeConfigurations} from "@flare-periphery/coston2/IFdcRequestFeeConfigurations.sol";
import {IFdcVerification} from "@flare-periphery/coston2/IFdcVerification.sol";
import {IPayment} from "@flare-periphery/coston2/IPayment.sol";
import {IPaymentVerification} from "@flare-periphery/coston2/IPaymentVerification.sol";
import {IXRPPayment} from "@flare-periphery/coston2/IXRPPayment.sol";
import {IXRPPaymentVerification} from "@flare-periphery/coston2/IXRPPaymentVerification.sol";
import {IXRPPaymentNonexistence} from "@flare-periphery/coston2/IXRPPaymentNonexistence.sol";
import {IXRPPaymentNonexistenceVerification} from "@flare-periphery/coston2/IXRPPaymentNonexistenceVerification.sol";
import {IRedeemExtended} from "@flare-periphery/coston2/IRedeemExtended.sol";
import {IReferencedPaymentNonexistence} from "@flare-periphery/coston2/IReferencedPaymentNonexistence.sol";
import {
    IReferencedPaymentNonexistenceVerification
} from "@flare-periphery/coston2/IReferencedPaymentNonexistenceVerification.sol";
import {IConfirmedBlockHeightExists} from "@flare-periphery/coston2/IConfirmedBlockHeightExists.sol";
import {IRelay} from "@flare-periphery/coston2/IRelay.sol";
import {IFlareContractRegistry} from "@flare-periphery/coston2/IFlareContractRegistry.sol";
import {ITeeExtensionRegistry} from "@fcc-scaffold/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "@fcc-scaffold/interfaces/ITeeMachineRegistry.sol";

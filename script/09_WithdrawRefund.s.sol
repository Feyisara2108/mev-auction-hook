// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {console2} from "forge-std/Script.sol";

import {BaseScript} from "./base/BaseScript.sol";
import {MevAuctionHook} from "../src/MevAuctionHook.sol";

/**
 * @notice Withdraws a pending refund for an outbid MEV searcher.
 *         When a higher bid replaces yours, your funds are credited to pendingRefunds
 *         rather than pushed back — this avoids the revert-griefing vector in push-refund designs.
 *
 * Set in .env:
 *   HOOK_ADDRESS, TOKEN0_ADDRESS (or TOKEN1_ADDRESS if you bid on a !zeroForOne swap)
 *
 * Usage:
 *   forge script script/09_WithdrawRefund.s.sol \
 *     --rpc-url $UNICHAIN_SEPOLIA_RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     -vvv
 */
contract WithdrawRefundScript is BaseScript {
    using CurrencyLibrary for Currency;

    function run() external {
        require(address(hookContract) != address(0), "Set HOOK_ADDRESS in .env");

        MevAuctionHook hook = MevAuctionHook(payable(address(hookContract)));

        // Check both currencies for pending refunds
        address c0 = Currency.unwrap(currency0);
        address c1 = Currency.unwrap(currency1);

        uint256 refund0 = hook.pendingRefunds(msg.sender, c0);
        uint256 refund1 = hook.pendingRefunds(msg.sender, c1);

        require(refund0 > 0 || refund1 > 0, "No pending refunds for this address");

        vm.startBroadcast();
        if (refund0 > 0) {
            hook.withdrawRefund(c0);
            console2.log("Withdrew currency0 refund:", refund0);
        }
        if (refund1 > 0) {
            hook.withdrawRefund(c1);
            console2.log("Withdrew currency1 refund:", refund1);
        }
        vm.stopBroadcast();
    }
}

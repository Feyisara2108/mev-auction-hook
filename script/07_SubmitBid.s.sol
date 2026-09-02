// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {console2} from "forge-std/Script.sol";

import {BaseScript} from "./base/BaseScript.sol";
import {MevAuctionHook} from "../src/MevAuctionHook.sol";

/**
 * @notice Places a bid on an open MEV auction.
 *         Bid currency matches the swap input: currency0 for zeroForOne swaps,
 *         currency1 for !zeroForOne swaps.
 *         If outbid, your funds are credited to pendingRefunds — call 09_WithdrawRefund to reclaim.
 *
 * Set in .env:
 *   HOOK_ADDRESS, TOKEN0_ADDRESS, TOKEN1_ADDRESS, REQUEST_ID, BID_AMOUNT
 *
 * Usage:
 *   forge script script/07_SubmitBid.s.sol \
 *     --rpc-url $UNICHAIN_SEPOLIA_RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     -vvv
 */
contract SubmitBidScript is BaseScript {
    using CurrencyLibrary for Currency;

    function run() external {
        require(address(hookContract) != address(0), "Set HOOK_ADDRESS in .env");

        uint256 requestId = vm.envUint("REQUEST_ID");
        uint256 bidAmount = vm.envUint("BID_AMOUNT");

        MevAuctionHook hook = MevAuctionHook(payable(address(hookContract)));
        MevAuctionHook.RequestInfo memory info = hook.getRequestInfo(requestId);

        require(!info.isCompleted, "Request already completed");
        require(info.auctionOpen,  "Auction window has closed - run 08_ExecuteSwap");

        // Approve the bid currency (input currency for this swap direction)
        bool isZeroForOne = info.zeroForOne;
        vm.startBroadcast();
        if (isZeroForOne) {
            if (!currency0.isAddressZero()) token0.approve(address(hook), bidAmount);
            hook.submitBid{value: currency0.isAddressZero() ? bidAmount : 0}(requestId, bidAmount);
        } else {
            if (!currency1.isAddressZero()) token1.approve(address(hook), bidAmount);
            hook.submitBid{value: currency1.isAddressZero() ? bidAmount : 0}(requestId, bidAmount);
        }
        vm.stopBroadcast();

        console2.log("=== Bid submitted ===");
        console2.log("Request ID :", requestId);
        console2.log("Bid amount :", bidAmount);
    }
}

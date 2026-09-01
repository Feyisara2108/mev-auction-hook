// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";

import {BaseScript} from "./base/BaseScript.sol";
import {MevAuctionHook} from "../src/MevAuctionHook.sol";

/**
 * @notice Executes a swap after the auction window has closed.
 *         Anyone can call this — the swap output always goes to the original requester.
 *         The winning bid is donated to in-range LPs via poolManager.donate().
 *
 * Set in .env:
 *   HOOK_ADDRESS, REQUEST_ID
 *
 * Usage:
 *   forge script script/08_ExecuteSwap.s.sol \
 *     --rpc-url $UNICHAIN_SEPOLIA_RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     -vvv
 */
contract ExecuteSwapScript is BaseScript {
    function run() external {
        require(address(hookContract) != address(0), "Set HOOK_ADDRESS in .env");

        uint256 requestId = vm.envUint("REQUEST_ID");

        MevAuctionHook hook = MevAuctionHook(payable(address(hookContract)));
        MevAuctionHook.RequestInfo memory info = hook.getRequestInfo(requestId);

        require(!info.isCompleted, "Request already completed");
        require(!info.auctionOpen, "Auction window still open — wait for more blocks");

        vm.startBroadcast();
        hook.executeSwap(requestId);
        vm.stopBroadcast();

        console2.log("=== Swap executed ===");
        console2.log("Request ID         :", requestId);
        console2.log("Winning bid to LPs :", info.highestBid);
        console2.log("Output sent to     :", info.sender);
    }
}

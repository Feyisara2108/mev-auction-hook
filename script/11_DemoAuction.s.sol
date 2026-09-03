// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SwapParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {console2} from "forge-std/Script.sol";

import {BaseScript} from "./base/BaseScript.sol";
import {GovernedMevAuctionHook} from "../src/GovernedMevAuctionHook.sol";

/**
 * @notice Full demo: requestSwap + submitBid in one script run.
 *         The bid is submitted in the same broadcast so it lands before the
 *         3-block auction window closes.
 *
 *         After running this, wait 4+ seconds then run 08_ExecuteSwap.s.sol.
 */
contract DemoAuctionScript is BaseScript {
    using CurrencyLibrary for Currency;

    // Both are denominated in the swap's INPUT currency. This demo swaps zeroForOne,
    // so that is currency0 — which is whichever of the two tokens sorts lower, not
    // necessarily the one named "TKNA".
    uint256 constant SWAP_AMOUNT = 2e18; // above smallSwapThreshold, so it opens an auction
    uint256 constant BID_AMOUNT = 1e17; // split between LPs and the trader per the LP vote

    function run() external {
        require(address(hookContract) != address(0), "Set HOOK_ADDRESS in .env");

        GovernedMevAuctionHook hook = GovernedMevAuctionHook(payable(address(hookContract)));

        PoolKey memory poolKey =
            PoolKey({currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: hookContract});

        SwapParams memory params =
            SwapParams({zeroForOne: true, amountSpecified: -int256(SWAP_AMOUNT), sqrtPriceLimitX96: 0});

        vm.startBroadcast();

        // Step 1: approve swap amount + bid amount together
        token0.approve(address(hook), SWAP_AMOUNT + BID_AMOUNT);

        // Step 2: request the swap — opens a 3-block auction window
        uint256 requestId = hook.requestSwap(poolKey, params);
        console2.log("=== Swap requested ===");
        console2.log("Request ID :", requestId);

        // Step 3: submit bid in the same broadcast — lands before window closes
        hook.submitBid(requestId, BID_AMOUNT);
        console2.log("=== Bid submitted ===");
        console2.log("Bid amount (currency0 wei):", BID_AMOUNT);
        console2.log("Bid currency              :", Currency.unwrap(currency0));

        vm.stopBroadcast();

        uint256 lpShareBps = hook.effectiveLpShareBps(poolKey.toId());
        console2.log("");
        console2.log("=== How this bid will be split (current LP vote) ===");
        console2.log("To LPs   (bps / wei):", lpShareBps, (BID_AMOUNT * lpShareBps) / 10_000);
        console2.log("To trader(bps / wei):", 10_000 - lpShareBps, BID_AMOUNT - (BID_AMOUNT * lpShareBps) / 10_000);

        console2.log("");
        console2.log("Wait for the auction window to close, then run:");
        console2.log("  REQUEST_ID=%s forge script script/08_ExecuteSwap.s.sol ...", requestId);
    }
}

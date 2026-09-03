// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SwapParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {console2} from "forge-std/Script.sol";

import {BaseScript} from "./base/BaseScript.sol";
import {MevAuctionHook} from "../src/MevAuctionHook.sol";

/**
 * @notice Full demo: requestSwap + submitBid in one script run.
 *         The bid is submitted in the same broadcast so it lands before the
 *         3-block auction window closes.
 *
 *         After running this, wait 4+ seconds then run 08_ExecuteSwap.s.sol.
 */
contract DemoAuctionScript is BaseScript {
    using CurrencyLibrary for Currency;

    uint256 constant SWAP_AMOUNT = 2e18;   // 2 TKNA — triggers auction
    uint256 constant BID_AMOUNT  = 1e17;   // 0.1 TKNA bid donated to LPs

    function run() external {
        require(address(hookContract) != address(0), "Set HOOK_ADDRESS in .env");

        MevAuctionHook hook = MevAuctionHook(payable(address(hookContract)));

        PoolKey memory poolKey = PoolKey({
            currency0:   currency0,
            currency1:   currency1,
            fee:         3000,
            tickSpacing: 60,
            hooks:       hookContract
        });

        SwapParams memory params = SwapParams({
            zeroForOne:        true,
            amountSpecified:   -int256(SWAP_AMOUNT),
            sqrtPriceLimitX96: 0
        });

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
        console2.log("Bid amount :", BID_AMOUNT, "(0.1 TKNA -> LPs)");

        vm.stopBroadcast();

        console2.log("");
        console2.log("Wait 4+ seconds, then run:");
        console2.log("  REQUEST_ID=<id> forge script script/08_ExecuteSwap.s.sol ...");
    }
}

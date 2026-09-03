// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SwapParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {console2} from "forge-std/Script.sol";

import {BaseScript} from "./base/BaseScript.sol";
import {GovernedMevAuctionHook} from "../src/GovernedMevAuctionHook.sol";

/**
 * @notice Submits a swap intent to the MEV auction hook.
 *         Input tokens are taken into hook custody immediately.
 *         Swaps below smallSwapThreshold (1 ETH) execute in the same tx.
 *         Larger swaps open a 3-block bidding window.
 *
 * Set in .env:
 *   HOOK_ADDRESS, TOKEN0_ADDRESS, TOKEN1_ADDRESS
 *
 * Usage:
 *   forge script script/06_RequestSwap.s.sol \
 *     --rpc-url $UNICHAIN_SEPOLIA_RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     -vvv
 */
contract RequestSwapScript is BaseScript {
    using CurrencyLibrary for Currency;

    uint256 constant SWAP_AMOUNT = 2e18; // triggers auction (above 1 ETH threshold)

    function run() external {
        require(address(hookContract) != address(0), "Set HOOK_ADDRESS in .env");

        GovernedMevAuctionHook hook = GovernedMevAuctionHook(payable(address(hookContract)));

        PoolKey memory poolKey =
            PoolKey({currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: hookContract});

        SwapParams memory params =
            SwapParams({zeroForOne: true, amountSpecified: -int256(SWAP_AMOUNT), sqrtPriceLimitX96: 0});

        vm.startBroadcast();
        token0.approve(address(hook), SWAP_AMOUNT);
        uint256 requestId = hook.requestSwap(poolKey, params);
        vm.stopBroadcast();

        console2.log("=== Swap requested ===");
        console2.log("Request ID  :", requestId);
        console2.log("Swap amount :", SWAP_AMOUNT);
        console2.log("");
        console2.log("Copy REQUEST_ID to .env, then run script/07_SubmitBid.s.sol to place a bid.");
    }
}

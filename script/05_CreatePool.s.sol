// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {console2} from "forge-std/Script.sol";

import {BaseScript} from "./base/BaseScript.sol";
import {LiquidityHelpers} from "./base/LiquidityHelpers.sol";

/**
 * @notice Initialises a Uniswap v4 pool with the MEV auction hook and seeds full-range liquidity.
 *
 * Prerequisites:
 *   - Run script/12_DeployGovernedMevAuctionHook.s.sol and set HOOK_ADDRESS in .env
 *   - Set TOKEN0_ADDRESS and TOKEN1_ADDRESS in .env (TOKEN0 < TOKEN1 numerically)
 *
 * Usage:
 *   forge script script/05_CreatePool.s.sol \
 *     --rpc-url $UNICHAIN_SEPOLIA_RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     -vvv
 */
contract CreatePoolScript is BaseScript, LiquidityHelpers {
    using CurrencyLibrary for Currency;

    uint24 constant LP_FEE = 3000; // 0.30%
    int24 constant TICK_SPACING = 60;
    uint160 constant START_PRICE = 2 ** 96; // 1:1 ratio
    uint256 constant SEED = 100e18;

    function run() external {
        require(address(hookContract) != address(0), "Set HOOK_ADDRESS in .env");
        require(address(token0) != address(0), "Set TOKEN0_ADDRESS in .env");
        require(address(token1) != address(0), "Set TOKEN1_ADDRESS in .env");

        PoolKey memory poolKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: LP_FEE, tickSpacing: TICK_SPACING, hooks: hookContract
        });

        _createAndSeed(poolKey);

        console2.log("=== Pool created ===");
        console2.log("Hook  :", address(hookContract));
        console2.log("Token0:", address(token0));
        console2.log("Token1:", address(token1));
        console2.log("");
        console2.log("Next step: request a swap via script/06_RequestSwap.s.sol");
    }

    function _createAndSeed(PoolKey memory poolKey) internal {
        int24 currentTick = TickMath.getTickAtSqrtPrice(START_PRICE);
        int24 tickLower = truncateTickSpacing(currentTick - 750 * TICK_SPACING, TICK_SPACING);
        int24 tickUpper = truncateTickSpacing(currentTick + 750 * TICK_SPACING, TICK_SPACING);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            START_PRICE, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), SEED, SEED
        );

        (bytes memory actions, bytes[] memory mintParams) = _mintLiquidityParams(
            poolKey, tickLower, tickUpper, liquidity, SEED + 1, SEED + 1, deployerAddress, new bytes(0)
        );

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encodeWithSelector(positionManager.initializePool.selector, poolKey, START_PRICE, new bytes(0));
        params[1] = abi.encodeWithSelector(
            positionManager.modifyLiquidities.selector, abi.encode(actions, mintParams), block.timestamp + 3600
        );

        uint256 ethValue = currency0.isAddressZero() ? SEED + 1 : 0;

        vm.startBroadcast();
        tokenApprovals();
        positionManager.multicall{value: ethValue}(params);
        vm.stopBroadcast();
    }
}

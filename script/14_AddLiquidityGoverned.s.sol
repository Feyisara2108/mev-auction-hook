// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {console2} from "forge-std/Script.sol";

import {BaseScript} from "./base/BaseScript.sol";
import {LiquidityHelpers} from "./base/LiquidityHelpers.sol";

/**
 * @notice Adds liquidity to a GovernedMevAuctionHook pool, passing the LP's address in `hookData`
 *         so the hook attributes the liquidity (and therefore the governance voting weight) to the
 *         real LP rather than to the PositionManager singleton.
 *
 *         Use this instead of 02_AddLiquidity when the pool is governed and you want your vote to
 *         count.
 *
 * Set in .env: HOOK_ADDRESS (GovernedMevAuctionHook), TOKEN0_ADDRESS, TOKEN1_ADDRESS
 *
 * Usage:
 *   forge script script/14_AddLiquidityGoverned.s.sol \
 *     --rpc-url $UNICHAIN_SEPOLIA_RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     -vvv
 */
contract AddLiquidityGovernedScript is BaseScript, LiquidityHelpers {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    uint24 lpFee = 3000;
    int24 tickSpacing = 60;
    uint160 startingPrice = 2 ** 96;

    uint256 public token0Amount = 100e18;
    uint256 public token1Amount = 100e18;

    int24 tickLower;
    int24 tickUpper;

    function run() external {
        require(address(hookContract) != address(0), "Set HOOK_ADDRESS in .env");

        PoolKey memory poolKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: lpFee, tickSpacing: tickSpacing, hooks: hookContract
        });

        // Attribute liquidity + voting weight to the actual LP. The hook verifies a one-time
        // attestation signed by the LP: abi.encode(lp, signature). The digest binds chain id,
        // hook address, pool id and the LP address (see GovernedMevAuctionHook.attributionDigest).
        uint256 lpKey = vm.envUint("PRIVATE_KEY");
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(hookContract), poolKey.toId(), deployerAddress))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lpKey, digest);
        bytes memory hookData = abi.encode(deployerAddress, abi.encodePacked(r, s, v));

        int24 currentTick = TickMath.getTickAtSqrtPrice(startingPrice);
        tickLower = truncateTickSpacing((currentTick - 750 * tickSpacing), tickSpacing);
        tickUpper = truncateTickSpacing((currentTick + 750 * tickSpacing), tickSpacing);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            startingPrice,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            token0Amount,
            token1Amount
        );

        uint256 amount0Max = token0Amount + 1;
        uint256 amount1Max = token1Amount + 1;

        (bytes memory actions, bytes[] memory mintParams) = _mintLiquidityParams(
            poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, deployerAddress, hookData
        );

        uint256 valueToPass = currency0.isAddressZero() ? amount0Max : 0;

        vm.startBroadcast();
        tokenApprovals();
        positionManager.modifyLiquidities{value: valueToPass}(abi.encode(actions, mintParams), block.timestamp + 3600);
        vm.stopBroadcast();

        console2.log("=== Governed liquidity added ===");
        console2.log("LP (voting weight owner):", deployerAddress);
        console2.log("Liquidity               :", liquidity);
        console2.log("Now run script/13_Vote.s.sol to cast your LP vote on the revenue split.");
    }
}

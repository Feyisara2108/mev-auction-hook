// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {console2} from "forge-std/Script.sol";

import {BaseScript} from "./base/BaseScript.sol";
import {GovernedMevAuctionHook} from "../src/GovernedMevAuctionHook.sol";

/**
 * @notice Casts an LP governance vote on the pool's MEV revenue split.
 *         The caller's vote is weighted by the liquidity they have provided to the pool
 *         (tracked by the hook's afterAddLiquidity callback).
 *
 * Set in .env:
 *   HOOK_ADDRESS (must be a GovernedMevAuctionHook), TOKEN0_ADDRESS, TOKEN1_ADDRESS
 *   LP_SHARE_BPS — desired share of each winning bid donated to LPs (0..10000).
 *                  The remainder is rebated to the trader who requested the swap.
 *
 * Usage:
 *   LP_SHARE_BPS=6000 forge script script/13_Vote.s.sol \
 *     --rpc-url $UNICHAIN_SEPOLIA_RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     -vvv
 */
contract VoteScript is BaseScript {
    function run() external {
        require(address(hookContract) != address(0), "Set HOOK_ADDRESS in .env");
        uint256 lpShareBps = vm.envOr("LP_SHARE_BPS", uint256(6000));

        GovernedMevAuctionHook hook = GovernedMevAuctionHook(payable(address(hookContract)));

        PoolKey memory poolKey =
            PoolKey({currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: hookContract});

        vm.startBroadcast();
        hook.vote(poolKey, lpShareBps);
        vm.stopBroadcast();

        GovernedMevAuctionHook.GovernanceInfo memory info = hook.getGovernanceInfo(poolKey);
        console2.log("=== Vote cast ===");
        console2.log("Your LP-share vote (bps)      :", lpShareBps);
        console2.log("New effective LP share (bps)  :", info.effectiveLpShareBps);
        console2.log("New trader rebate (bps)       :", info.traderRebateBps);
        console2.log("Total tracked liquidity       :", info.totalLiquidity);
        console2.log("Total voting weight           :", info.votingWeight);
    }
}

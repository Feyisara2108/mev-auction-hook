// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager, SwapParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {EasyPosm} from "./utils/libraries/EasyPosm.sol";
import {BaseTest} from "./utils/BaseTest.sol";
import {GovernedMevAuctionHook} from "../src/GovernedMevAuctionHook.sol";

contract GovernedMevAuctionHookTest is BaseTest {
    using EasyPosm for IPositionManager;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    uint256 constant SMALL_SWAP_THRESHOLD = 1 ether;
    uint256 constant AUCTION_WINDOW = 3;
    uint256 constant BPS = 10_000;

    address alice = makeAddr("alice"); // trader / swapper
    address bidder1 = makeAddr("bidder1");
    address lp1 = makeAddr("lp1");
    address lp2 = makeAddr("lp2");

    Currency currency0;
    Currency currency1;
    PoolKey poolKey;
    PoolId poolId;
    GovernedMevAuctionHook hook;

    int24 tickLower;
    int24 tickUpper;

    function setUp() public {
        deployArtifactsAndLabel();
        (currency0, currency1) = deployCurrencyPair();

        address flags = address(
            uint160(
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
            ) ^ (0x4444 << 144)
        );
        bytes memory constructorArgs = abi.encode(poolManager, SMALL_SWAP_THRESHOLD, AUCTION_WINDOW);
        deployCodeTo("GovernedMevAuctionHook.sol:GovernedMevAuctionHook", constructorArgs, flags);
        hook = GovernedMevAuctionHook(payable(flags));

        poolKey = PoolKey(currency0, currency1, 3000, 60, IHooks(hook));
        poolId = poolKey.toId();
        poolManager.initialize(poolKey, Constants.SQRT_PRICE_1_1);

        tickLower = TickMath.minUsableTick(poolKey.tickSpacing);
        tickUpper = TickMath.maxUsableTick(poolKey.tickSpacing);

        // Baseline pool liquidity (attributed to this test contract via empty hookData).
        _addLiquidity(100e18, "");

        deal(Currency.unwrap(currency0), alice, 10 ether);
        deal(Currency.unwrap(currency0), bidder1, 10 ether);
    }

    // ─── Governance: weight tracking ──────────────────────────────────────────

    function test_afterAddLiquidity_tracksLpWeight() public {
        _addLiquidity(50e18, abi.encode(lp1));
        assertEq(hook.lpLiquidity(poolId, lp1), 50e18, "lp1 weight not tracked");
    }

    function test_defaultSplit_is100PercentToLps() public view {
        assertEq(hook.effectiveLpShareBps(poolId), BPS, "default split should be 100% to LPs");
    }

    function test_singleLpVote_setsSplit() public {
        _addLiquidity(50e18, abi.encode(lp1));

        vm.prank(lp1);
        hook.vote(poolKey, 6000);

        assertEq(hook.effectiveLpShareBps(poolId), 6000, "single LP vote not applied");
    }

    function test_twoLps_liquidityWeightedAverage() public {
        _addLiquidity(100e18, abi.encode(lp1));
        _addLiquidity(300e18, abi.encode(lp2));

        vm.prank(lp1);
        hook.vote(poolKey, 8000);
        vm.prank(lp2);
        hook.vote(poolKey, 4000);

        // (100*8000 + 300*4000) / 400 = 5000
        assertEq(hook.effectiveLpShareBps(poolId), 5000, "weighted average incorrect");
    }

    function test_voteWeight_followsLiquidityChanges() public {
        _addLiquidity(100e18, abi.encode(lp1));
        _addLiquidity(100e18, abi.encode(lp2));

        vm.prank(lp1);
        hook.vote(poolKey, 8000);
        vm.prank(lp2);
        hook.vote(poolKey, 4000);
        // equal weight -> 6000
        assertEq(hook.effectiveLpShareBps(poolId), 6000, "pre-change average wrong");

        // lp1 triples their liquidity; their vote should now dominate.
        _addLiquidity(200e18, abi.encode(lp1));
        // (300*8000 + 100*4000)/400 = 7000
        assertEq(hook.effectiveLpShareBps(poolId), 7000, "post-change average wrong");
    }

    function test_removeLiquidity_reducesWeight() public {
        uint256 tokenId = _addLiquidity(100e18, abi.encode(lp1));
        assertEq(hook.lpLiquidity(poolId, lp1), 100e18);

        positionManager.decreaseLiquidity(
            tokenId, 40e18, 0, 0, address(this), block.timestamp, abi.encode(lp1)
        );
        assertEq(hook.lpLiquidity(poolId, lp1), 60e18, "weight not reduced on remove");
    }

    function test_vote_rejectsInvalidShare() public {
        vm.prank(lp1);
        vm.expectRevert(GovernedMevAuctionHook.InvalidShare.selector);
        hook.vote(poolKey, 10_001);
    }

    // ─── Governed split enforcement in the auction ────────────────────────────

    function test_governedSplit_donatesAndRebates() public {
        // lp1 provides liquidity and votes 60% to LPs / 40% rebate to trader.
        _addLiquidity(100e18, abi.encode(lp1));
        vm.prank(lp1);
        hook.vote(poolKey, 6000);
        assertEq(hook.effectiveLpShareBps(poolId), 6000);

        uint256 swapAmount = 2 ether;
        uint256 bidAmount = 0.5 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        vm.startPrank(bidder1);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), bidAmount);
        hook.submitBid(requestId, bidAmount);
        vm.stopPrank();

        (uint256 fg0Before,) = poolManager.getFeeGrowthGlobals(poolId);
        uint256 aliceCur0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);

        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        // Trader receives a 40% rebate of the bid in the input currency (currency0).
        uint256 aliceCur0After = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 expectedRebate = (bidAmount * 4000) / BPS; // 0.2 ether
        assertEq(aliceCur0After - aliceCur0Before, expectedRebate, "trader rebate incorrect");

        // LPs still receive the 60% donation (fee growth rises).
        (uint256 fg0After,) = poolManager.getFeeGrowthGlobals(poolId);
        assertGt(fg0After, fg0Before, "LP donation did not occur");
    }

    function test_defaultSplit_fullDonation_noRebate() public {
        // No votes -> 100% to LPs, trader gets nothing back (matches base hook behaviour).
        uint256 swapAmount = 2 ether;
        uint256 bidAmount = 0.3 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        vm.startPrank(bidder1);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), bidAmount);
        hook.submitBid(requestId, bidAmount);
        vm.stopPrank();

        uint256 aliceCur0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        (uint256 fg0Before,) = poolManager.getFeeGrowthGlobals(poolId);

        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        uint256 aliceCur0After = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        assertEq(aliceCur0After, aliceCur0Before, "no rebate expected at 100% LP share");

        (uint256 fg0After,) = poolManager.getFeeGrowthGlobals(poolId);
        assertGt(fg0After, fg0Before, "full donation did not occur");
    }

    function test_getGovernanceInfo_view() public {
        _addLiquidity(100e18, abi.encode(lp1));
        vm.prank(lp1);
        hook.vote(poolKey, 7000);

        GovernedMevAuctionHook.GovernanceInfo memory info = hook.getGovernanceInfo(poolKey);
        assertEq(info.effectiveLpShareBps, 7000);
        assertEq(info.traderRebateBps, 3000);
        assertEq(info.votingWeight, 100e18);
        assertEq(info.totalLiquidity, 200e18); // 100 baseline + 100 lp1
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _addLiquidity(uint128 liquidity, bytes memory hookData) internal returns (uint256 tokenId) {
        (uint256 amt0, uint256 amt1) = LiquidityAmounts.getAmountsForLiquidity(
            Constants.SQRT_PRICE_1_1,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            liquidity
        );
        deal(Currency.unwrap(currency0), address(this), amt0 + 2);
        deal(Currency.unwrap(currency1), address(this), amt1 + 2);
        MockERC20(Currency.unwrap(currency0)).approve(address(positionManager), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(positionManager), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(permit2), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(permit2), type(uint256).max);

        (tokenId,) = positionManager.mint(
            poolKey, tickLower, tickUpper, liquidity, amt0 + 2, amt1 + 2,
            address(this), block.timestamp, hookData
        );
    }
}

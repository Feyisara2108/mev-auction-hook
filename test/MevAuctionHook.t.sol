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
import {MevAuctionHook} from "../src/MevAuctionHook.sol";

contract MevAuctionHookTest is BaseTest {
    using EasyPosm for IPositionManager;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    // ─── Hook config ──────────────────────────────────────────────────────────
    uint256 constant SMALL_SWAP_THRESHOLD = 1 ether;
    uint256 constant AUCTION_WINDOW = 3; // blocks

    // ─── Actors ───────────────────────────────────────────────────────────────
    address alice = makeAddr("alice");
    address bidder1 = makeAddr("bidder1");
    address bidder2 = makeAddr("bidder2");
    address anyone = makeAddr("anyone");

    // ─── Pool state ───────────────────────────────────────────────────────────
    Currency currency0;
    Currency currency1;
    PoolKey poolKey;
    PoolId poolId;
    MevAuctionHook hook;

    int24 tickLower;
    int24 tickUpper;

    function setUp() public {
        deployArtifactsAndLabel();
        (currency0, currency1) = deployCurrencyPair();

        address flags = address(
            uint160(Hooks.BEFORE_SWAP_FLAG) ^ (0x4444 << 144)
        );
        bytes memory constructorArgs = abi.encode(poolManager, SMALL_SWAP_THRESHOLD, AUCTION_WINDOW);
        deployCodeTo("MevAuctionHook.sol:MevAuctionHook", constructorArgs, flags);
        hook = MevAuctionHook(payable(flags));

        poolKey = PoolKey(currency0, currency1, 3000, 60, IHooks(hook));
        poolId = poolKey.toId();
        poolManager.initialize(poolKey, Constants.SQRT_PRICE_1_1);

        tickLower = TickMath.minUsableTick(poolKey.tickSpacing);
        tickUpper = TickMath.maxUsableTick(poolKey.tickSpacing);

        uint128 liquidity = 100e18;
        (uint256 amt0, uint256 amt1) = LiquidityAmounts.getAmountsForLiquidity(
            Constants.SQRT_PRICE_1_1,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            liquidity
        );
        positionManager.mint(
            poolKey, tickLower, tickUpper, liquidity, amt0 + 1, amt1 + 1,
            address(this), block.timestamp, Constants.ZERO_BYTES
        );

        _fundAndApprove(alice,    10 ether, 10 ether);
        _fundAndApprove(bidder1,  10 ether, 0);
        _fundAndApprove(bidder2,  10 ether, 0);
        _fundAndApprove(anyone,   0,        0);
    }

    // ─── 1. Pool initializes correctly ────────────────────────────────────────

    function test_poolInitializedWithHook() public view {
        (uint160 sqrtPrice,,,) = poolManager.getSlot0(poolId);
        assertEq(sqrtPrice, Constants.SQRT_PRICE_1_1);
    }

    // ─── 2. Small swap executes immediately (express lane) ────────────────────

    function test_smallSwap_executesImmediately() public {
        uint256 swapAmount = 0.5 ether;

        uint256 aliceCurrency1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(swapAmount),
            sqrtPriceLimitX96: 0
        });
        uint256 requestId = hook.requestSwap(poolKey, params);
        vm.stopPrank();

        (, , , , , , bool completed) = _getRequest(requestId);
        assertTrue(completed, "small swap not immediately completed");

        uint256 aliceCurrency1After = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        assertGt(aliceCurrency1After, aliceCurrency1Before, "alice did not receive output");
    }

    // ─── 3. Large swap — full auction flow ────────────────────────────────────

    function test_largeSwap_fullAuction() public {
        uint256 swapAmount = 2 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(swapAmount),
            sqrtPriceLimitX96: 0
        });
        uint256 requestId = hook.requestSwap(poolKey, params);
        vm.stopPrank();

        (, , , uint256 deadline, , , ) = _getRequest(requestId);
        assertEq(deadline, block.number + AUCTION_WINDOW);

        uint256 bid1 = 0.1 ether;
        vm.startPrank(bidder1);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), bid1);
        hook.submitBid(requestId, bid1);
        vm.stopPrank();
        (, , , , uint256 highestBid, address highestBidder, ) = _getRequest(requestId);
        assertEq(highestBid, bid1);
        assertEq(highestBidder, bidder1);

        uint256 bid2 = 0.2 ether;
        vm.startPrank(bidder2);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), bid2);
        hook.submitBid(requestId, bid2);
        vm.stopPrank();
        (, , , , uint256 newHighestBid, address newHighestBidder, ) = _getRequest(requestId);
        assertEq(newHighestBid, bid2);
        assertEq(newHighestBidder, bidder2);

        uint256 refundDue = hook.pendingRefunds(bidder1, Currency.unwrap(currency0));
        assertEq(refundDue, bid1, "bidder1 refund not queued");

        uint256 bidder1BalanceBefore = MockERC20(Currency.unwrap(currency0)).balanceOf(bidder1);
        vm.prank(bidder1);
        hook.withdrawRefund(Currency.unwrap(currency0));
        uint256 bidder1BalanceAfter = MockERC20(Currency.unwrap(currency0)).balanceOf(bidder1);
        assertEq(bidder1BalanceAfter - bidder1BalanceBefore, bid1, "bidder1 refund incorrect");

        uint256 aliceCurrency1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        vm.roll(block.number + AUCTION_WINDOW);

        vm.prank(anyone);
        hook.executeSwap(requestId);

        uint256 aliceCurrency1After = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        assertGt(aliceCurrency1After, aliceCurrency1Before, "alice did not receive swap output");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(anyone), 0, "executor incorrectly got output");

        (, , , , , , bool completed) = _getRequest(requestId);
        assertTrue(completed, "request not marked completed");
    }

    // ─── 4. Direct bypass attempt reverts ─────────────────────────────────────

    function test_directSwap_reverts() public {
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -1 ether,
            sqrtPriceLimitX96: 0
        });

        vm.expectRevert(MevAuctionHook.DirectSwapNotAllowed.selector);
        vm.prank(address(poolManager));
        hook.beforeSwap(address(this), poolKey, params, "");
    }

    // ─── 5. LP donation after a completed auction (zeroForOne — donates currency0) ────

    function test_lpDonation_afterAuction() public {
        uint256 swapAmount = 2 ether;
        uint256 bidAmount  = 0.3 ether;

        (uint256 fg0Before,) = poolManager.getFeeGrowthGlobals(poolId);

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

        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        (uint256 fg0After,) = poolManager.getFeeGrowthGlobals(poolId);
        assertGt(fg0After, fg0Before, "feeGrowthGlobal0 did not increase after donation");
    }

    // ─── 6. Zero-bid auction still executes ───────────────────────────────────

    function test_zeroBid_auctionExecutes() public {
        uint256 swapAmount = 2 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        vm.roll(block.number + AUCTION_WINDOW);

        uint256 aliceCurrency1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        vm.prank(anyone);
        hook.executeSwap(requestId);

        uint256 aliceCurrency1After = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        assertGt(aliceCurrency1After, aliceCurrency1Before, "zero-bid: alice did not receive output");

        (, , , , , , bool completed) = _getRequest(requestId);
        assertTrue(completed, "zero-bid: request not completed");
    }

    // ─── 7. Cannot execute before window closes ───────────────────────────────

    function test_executeBeforeDeadline_reverts() public {
        uint256 swapAmount = 2 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        vm.expectRevert(MevAuctionHook.AuctionStillOpen.selector);
        hook.executeSwap(requestId);
    }

    // ─── 8. Cannot bid after window closes ────────────────────────────────────

    function test_bidAfterDeadline_reverts() public {
        uint256 swapAmount = 2 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        vm.roll(block.number + AUCTION_WINDOW);

        vm.startPrank(bidder1);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), 0.1 ether);
        vm.expectRevert(MevAuctionHook.AuctionAlreadyClosed.selector);
        hook.submitBid(requestId, 0.1 ether);
        vm.stopPrank();
    }

    // ─── 9. Cannot replay an executed request ─────────────────────────────────

    function test_cannotReplayExecutedRequest() public {
        uint256 swapAmount = 2 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        vm.expectRevert(MevAuctionHook.AlreadyExecuted.selector);
        hook.executeSwap(requestId);
    }

    // ─── 10. Simulated LP value recapture ─────────────────────────────────────

    function test_simulation_recaptureEstimate() public {
        uint256 N = 10;
        uint256 swapAmount = 2 ether;
        uint256 bidFraction = 5; // percent

        uint256 totalSwapVolume;
        uint256 totalRecaptured;

        for (uint256 i = 0; i < N; i++) {
            address swapper = makeAddr(string.concat("swapper", vm.toString(i)));
            address bdr = makeAddr(string.concat("bdr", vm.toString(i)));

            deal(Currency.unwrap(currency0), swapper, swapAmount);
            deal(Currency.unwrap(currency0), bdr, swapAmount);

            vm.startPrank(swapper);
            MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
            uint256 reqId = hook.requestSwap(
                poolKey,
                SwapParams({zeroForOne: true, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
            );
            vm.stopPrank();

            uint256 bid = (swapAmount * bidFraction) / 100;
            vm.startPrank(bdr);
            MockERC20(Currency.unwrap(currency0)).approve(address(hook), bid);
            hook.submitBid(reqId, bid);
            vm.stopPrank();

            vm.roll(block.number + AUCTION_WINDOW);
            hook.executeSwap(reqId);

            totalSwapVolume += swapAmount;
            totalRecaptured += bid;
        }

        uint256 recaptureRateBps = (totalRecaptured * 10_000) / totalSwapVolume;

        emit log_named_uint("Total swap volume (ether)", totalSwapVolume / 1 ether);
        emit log_named_uint("Total LP recaptured (ether)", totalRecaptured / 1 ether);
        emit log_named_uint("Recapture rate (bps)", recaptureRateBps);

        assertEq(recaptureRateBps, 500, "unexpected recapture rate");
    }

    // ─── 11. Cancel with no bids returns tokens ───────────────────────────────

    function test_cancelSwap_noBids_returnsTokens() public {
        uint256 swapAmount = 2 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        uint256 aliceBalanceBefore = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);

        vm.prank(alice);
        hook.cancelSwap(requestId);

        uint256 aliceBalanceAfter = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        assertEq(aliceBalanceAfter - aliceBalanceBefore, swapAmount, "tokens not returned on cancel");

        (, , , , , , bool completed) = _getRequest(requestId);
        assertTrue(completed, "cancelled request should be marked completed");
    }

    // ─── 12. Cancel with active bids reverts ──────────────────────────────────

    function test_cancelSwap_withBids_reverts() public {
        uint256 swapAmount = 2 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        vm.startPrank(bidder1);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), 0.1 ether);
        hook.submitBid(requestId, 0.1 ether);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(MevAuctionHook.BidsAlreadySubmitted.selector);
        hook.cancelSwap(requestId);
    }

    // ─── 13. Reverse swap (token1 → token0) — bid in currency1 (input) ──────────

    function test_reverseSwap_token1ToToken0() public {
        uint256 swapAmount = 2 ether;
        uint256 bidAmount  = 0.1 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: false, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        // For !zeroForOne, bid currency is currency1 (the input token)
        deal(Currency.unwrap(currency1), bidder1, bidAmount);
        vm.startPrank(bidder1);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), bidAmount);
        hook.submitBid(requestId, bidAmount);
        vm.stopPrank();

        uint256 aliceCurrency0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        (, uint256 fg1Before) = poolManager.getFeeGrowthGlobals(poolId);

        vm.roll(block.number + 3);
        hook.executeSwap(requestId);

        uint256 aliceCurrency0After = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        assertGt(aliceCurrency0After, aliceCurrency0Before, "alice did not receive currency0 output");

        (, uint256 fg1After) = poolManager.getFeeGrowthGlobals(poolId);
        assertGt(fg1After, fg1Before, "feeGrowthGlobal1 did not increase after currency1 donation");
    }

    // ─── 14. !zeroForOne with zero bids executes correctly ────────────────────

    function test_reverseSwap_zeroBid_auctionExecutes() public {
        uint256 swapAmount = 2 ether;

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), swapAmount);
        uint256 requestId = hook.requestSwap(
            poolKey,
            SwapParams({zeroForOne: false, amountSpecified: -int256(swapAmount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();

        // No bids placed — exercises the zero-bid branch of the !zeroForOne unlockCallback path.
        uint256 aliceCurrency0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);

        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        uint256 aliceCurrency0After = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        assertGt(aliceCurrency0After, aliceCurrency0Before, "alice did not receive currency0 output on zero-bid reverse swap");

        (, , , , , , bool completed) = _getRequest(requestId);
        assertTrue(completed, "reverse zero-bid: request not completed");
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _fundAndApprove(address user, uint256 amount0, uint256 amount1) internal {
        if (amount0 > 0) {
            deal(Currency.unwrap(currency0), user, amount0);
        }
        if (amount1 > 0) {
            deal(Currency.unwrap(currency1), user, amount1);
        }
    }

    function _getRequest(uint256 requestId)
        internal
        view
        returns (
            address sender,
            PoolKey memory key,
            SwapParams memory params,
            uint256 deadlineBlock,
            uint256 highestBid,
            address highestBidder,
            bool isCompleted
        )
    {
        (sender, key, params, deadlineBlock, highestBid, highestBidder, isCompleted) =
            _decodeRequest(requestId);
    }

    function _decodeRequest(uint256 requestId)
        internal
        view
        returns (
            address sender,
            PoolKey memory key,
            SwapParams memory params,
            uint256 deadlineBlock,
            uint256 highestBid,
            address highestBidder,
            bool isCompleted
        )
    {
        (sender, key, params, deadlineBlock, highestBid, highestBidder, isCompleted) =
            hook.swapRequests(requestId);
    }
}

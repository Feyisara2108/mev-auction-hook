// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

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
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {EasyPosm} from "./utils/libraries/EasyPosm.sol";
import {BaseTest} from "./utils/BaseTest.sol";
import {GovernedMevAuctionHook} from "../src/GovernedMevAuctionHook.sol";

/// @dev Minimal ERC-1271 smart-contract wallet that vouches for one signer.
contract MockSmartWallet is IERC1271 {
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (uint8 v, bytes32 r, bytes32 s) = _split(signature);
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function _split(bytes memory sig) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        require(sig.length == 65, "bad sig");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }
}

/**
 * @notice Edge-case and boundary coverage for GovernedMevAuctionHook.
 *
 *         Split into three groups:
 *           1. Auction mechanics — the invariants that must hold regardless of governance.
 *           2. Input validation — every custom error has a test that provokes it.
 *           3. Governance & attribution — boundaries, re-votes, exits, and forged/garbage hookData.
 */
contract GovernedMevAuctionHookEdgeCasesTest is BaseTest {
    using EasyPosm for IPositionManager;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    uint256 constant SMALL_SWAP_THRESHOLD = 1 ether;
    uint256 constant AUCTION_WINDOW = 3;
    uint256 constant BPS = 10_000;

    address alice = makeAddr("alice"); // trader
    address bidder1 = makeAddr("bidder1");
    address bidder2 = makeAddr("bidder2");
    address anyone = makeAddr("anyone");

    address lp1;
    uint256 lp1Key;
    address lp2;
    uint256 lp2Key;

    Currency currency0;
    Currency currency1;
    PoolKey poolKey;
    PoolId poolId;
    PoolKey altPoolKey; // same hook + tokens, different fee tier
    GovernedMevAuctionHook hook;

    int24 tickLower;
    int24 tickUpper;

    function setUp() public {
        (lp1, lp1Key) = makeAddrAndKey("lp1");
        (lp2, lp2Key) = makeAddrAndKey("lp2");

        deployArtifactsAndLabel();
        (currency0, currency1) = deployCurrencyPair();

        address flags = address(
            uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG)
                ^ (0x4444 << 144)
        );
        bytes memory constructorArgs = abi.encode(poolManager, SMALL_SWAP_THRESHOLD, AUCTION_WINDOW);
        deployCodeTo("GovernedMevAuctionHook.sol:GovernedMevAuctionHook", constructorArgs, flags);
        hook = GovernedMevAuctionHook(payable(flags));

        poolKey = PoolKey(currency0, currency1, 3000, 60, IHooks(hook));
        poolId = poolKey.toId();
        poolManager.initialize(poolKey, Constants.SQRT_PRICE_1_1);

        // A second pool on the same hook — used to prove attestations are pool-bound.
        altPoolKey = PoolKey(currency0, currency1, 500, 10, IHooks(hook));
        poolManager.initialize(altPoolKey, Constants.SQRT_PRICE_1_1);

        tickLower = TickMath.minUsableTick(poolKey.tickSpacing);
        tickUpper = TickMath.maxUsableTick(poolKey.tickSpacing);

        _addLiquidity(100e18, ""); // baseline, unattested

        _fund(alice, 20 ether);
        _fund(bidder1, 20 ether);
        _fund(bidder2, 20 ether);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 1. Auction mechanics
    // ══════════════════════════════════════════════════════════════════════════

    function test_poolInitializedWithHook() public view {
        (uint160 sqrtPrice,,,) = poolManager.getSlot0(poolId);
        assertEq(sqrtPrice, Constants.SQRT_PRICE_1_1);
    }

    function test_directSwap_reverts() public {
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: 0});

        vm.expectRevert(GovernedMevAuctionHook.DirectSwapNotAllowed.selector);
        vm.prank(address(poolManager));
        hook.beforeSwap(address(this), poolKey, params, "");
    }

    function test_smallSwap_expressLane_executesImmediately() public {
        uint256 before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        uint256 requestId = _requestSwap(alice, 0.5 ether, true);

        GovernedMevAuctionHook.RequestInfo memory info = hook.getRequestInfo(requestId);
        assertTrue(info.isCompleted, "express lane did not settle inline");
        assertGt(MockERC20(Currency.unwrap(currency1)).balanceOf(alice), before, "trader received no output");
    }

    function test_fullAuction_competitiveBidding_refundsAndSettles() public {
        uint256 requestId = _requestSwap(alice, 2 ether, true);

        _bid(bidder1, requestId, 0.1 ether, true);
        _bid(bidder2, requestId, 0.2 ether, true);

        // bidder1 was outbid: funds are queued, not pushed.
        assertEq(hook.pendingRefunds(bidder1, Currency.unwrap(currency0)), 0.1 ether, "refund not queued");

        uint256 b1Before = MockERC20(Currency.unwrap(currency0)).balanceOf(bidder1);
        vm.prank(bidder1);
        hook.withdrawRefund(Currency.unwrap(currency0));
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(bidder1) - b1Before, 0.1 ether, "refund amount wrong");

        uint256 aliceBefore = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        vm.roll(block.number + AUCTION_WINDOW);
        vm.prank(anyone);
        hook.executeSwap(requestId);

        assertGt(MockERC20(Currency.unwrap(currency1)).balanceOf(alice), aliceBefore, "trader got no output");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(anyone), 0, "executor siphoned the output");
        assertTrue(hook.getRequestInfo(requestId).isCompleted, "request not completed");
    }

    function test_zeroBid_executesWithNoDonationOrRebate() public {
        uint256 requestId = _requestSwap(alice, 2 ether, true);
        vm.roll(block.number + AUCTION_WINDOW);

        (uint256 fg0Before,) = poolManager.getFeeGrowthGlobals(poolId);
        uint256 aliceCur0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 aliceCur1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        vm.prank(anyone);
        hook.executeSwap(requestId);

        (uint256 fg0After,) = poolManager.getFeeGrowthGlobals(poolId);
        assertGt(MockERC20(Currency.unwrap(currency1)).balanceOf(alice), aliceCur1Before, "no output");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(alice), aliceCur0Before, "unexpected rebate");
        // The swap itself accrues LP fees, but no donation is layered on top.
        assertGe(fg0After, fg0Before);
    }

    function test_reverseDirection_donatesAndRebatesInCurrency1() public {
        _addLiquidity(100e18, _attest(lp1Key, lp1));
        vm.prank(lp1);
        hook.vote(poolKey, 6000);

        uint256 swapAmount = 2 ether;
        uint256 bidAmount = 0.5 ether;

        uint256 requestId = _requestSwap(alice, swapAmount, false); // oneForZero: input is currency1
        _bid(bidder1, requestId, bidAmount, false);

        (, uint256 fg1Before) = poolManager.getFeeGrowthGlobals(poolId);
        uint256 aliceCur1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        (, uint256 fg1After) = poolManager.getFeeGrowthGlobals(poolId);
        assertGt(fg1After, fg1Before, "currency1 donation missing");
        assertEq(
            MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - aliceCur1Before,
            (bidAmount * 4000) / BPS,
            "currency1 rebate wrong"
        );
    }

    /// @dev After settlement the hook must not be sitting on leftover dust from the split.
    function test_settlement_leavesNoDustInHook() public {
        _addLiquidity(100e18, _attest(lp1Key, lp1));
        vm.prank(lp1);
        hook.vote(poolKey, 3333); // deliberately awkward ratio

        uint256 requestId = _requestSwap(alice, 2 ether, true);
        _bid(bidder1, requestId, 333333333333333333, true); // odd wei amount

        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(hook)), 0, "currency0 dust stranded in hook");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(hook)), 0, "currency1 dust stranded in hook");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 2. Input validation — one test per custom error
    // ══════════════════════════════════════════════════════════════════════════

    function test_requestSwap_exactOutput_reverts() public {
        vm.prank(alice);
        vm.expectRevert(GovernedMevAuctionHook.OnlyExactIn.selector);
        hook.requestSwap(poolKey, SwapParams({zeroForOne: true, amountSpecified: 1 ether, sqrtPriceLimitX96: 0}));
    }

    function test_requestSwap_ethSentForErc20Pool_reverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(GovernedMevAuctionHook.UnexpectedETH.selector);
        hook.requestSwap{value: 1 ether}(
            poolKey, SwapParams({zeroForOne: true, amountSpecified: -2 ether, sqrtPriceLimitX96: 0})
        );
    }

    function test_submitBid_equalToHighest_reverts() public {
        uint256 requestId = _requestSwap(alice, 2 ether, true);
        _bid(bidder1, requestId, 0.1 ether, true);

        vm.startPrank(bidder2);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), 0.1 ether);
        vm.expectRevert(GovernedMevAuctionHook.BidTooLow.selector);
        hook.submitBid(requestId, 0.1 ether); // must strictly exceed
        vm.stopPrank();
    }

    function test_submitBid_unknownRequest_reverts() public {
        vm.prank(bidder1);
        vm.expectRevert(GovernedMevAuctionHook.RequestNotFound.selector);
        hook.submitBid(999, 1 ether);
    }

    function test_submitBid_afterDeadline_reverts() public {
        uint256 requestId = _requestSwap(alice, 2 ether, true);
        vm.roll(block.number + AUCTION_WINDOW);

        vm.startPrank(bidder1);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), 0.1 ether);
        vm.expectRevert(GovernedMevAuctionHook.AuctionAlreadyClosed.selector);
        hook.submitBid(requestId, 0.1 ether);
        vm.stopPrank();
    }

    function test_executeSwap_beforeDeadline_reverts() public {
        uint256 requestId = _requestSwap(alice, 2 ether, true);
        vm.expectRevert(GovernedMevAuctionHook.AuctionStillOpen.selector);
        hook.executeSwap(requestId);
    }

    function test_executeSwap_unknownRequest_reverts() public {
        vm.expectRevert(GovernedMevAuctionHook.RequestNotFound.selector);
        hook.executeSwap(999);
    }

    function test_executeSwap_replay_reverts() public {
        uint256 requestId = _requestSwap(alice, 2 ether, true);
        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        vm.expectRevert(GovernedMevAuctionHook.AlreadyExecuted.selector);
        hook.executeSwap(requestId);
    }

    function test_withdrawRefund_nothingPending_reverts() public {
        vm.prank(bidder1);
        vm.expectRevert(GovernedMevAuctionHook.NoRefundAvailable.selector);
        hook.withdrawRefund(Currency.unwrap(currency0));
    }

    function test_cancelSwap_noBids_refundsInFull() public {
        uint256 before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 requestId = _requestSwap(alice, 2 ether, true);

        vm.prank(alice);
        hook.cancelSwap(requestId);

        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(alice), before, "cancel did not refund in full");
        assertTrue(hook.getRequestInfo(requestId).isCompleted, "cancelled request still open");
    }

    function test_cancelSwap_afterBid_reverts() public {
        uint256 requestId = _requestSwap(alice, 2 ether, true);
        _bid(bidder1, requestId, 0.1 ether, true);

        vm.prank(alice);
        vm.expectRevert(GovernedMevAuctionHook.BidsAlreadySubmitted.selector);
        hook.cancelSwap(requestId);
    }

    function test_cancelSwap_byStranger_reverts() public {
        uint256 requestId = _requestSwap(alice, 2 ether, true);

        vm.prank(anyone);
        vm.expectRevert(GovernedMevAuctionHook.NotRequester.selector);
        hook.cancelSwap(requestId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 3. Governance & attribution edge cases
    // ══════════════════════════════════════════════════════════════════════════

    function test_vote_zeroBps_allRebateNoDonation() public {
        _addLiquidity(100e18, _attest(lp1Key, lp1));
        vm.prank(lp1);
        hook.vote(poolKey, 0); // 0% to LPs — everything back to the trader
        assertEq(hook.effectiveLpShareBps(poolId), 0);

        uint256 bidAmount = 0.4 ether;
        uint256 requestId = _requestSwap(alice, 2 ether, true);
        _bid(bidder1, requestId, bidAmount, true);

        uint256 aliceCur0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        assertEq(
            MockERC20(Currency.unwrap(currency0)).balanceOf(alice) - aliceCur0Before,
            bidAmount,
            "trader should receive the whole bid at 0 bps"
        );
    }

    function test_vote_maxBpsAccepted_oneOverRejected() public {
        _addLiquidity(100e18, _attest(lp1Key, lp1));

        vm.prank(lp1);
        hook.vote(poolKey, BPS); // exactly 10_000 is the legal maximum
        assertEq(hook.effectiveLpShareBps(poolId), BPS);

        vm.prank(lp1);
        vm.expectRevert(GovernedMevAuctionHook.InvalidShare.selector);
        hook.vote(poolKey, BPS + 1);
    }

    function test_revote_replacesRatherThanAccumulates() public {
        _addLiquidity(100e18, _attest(lp1Key, lp1));

        vm.prank(lp1);
        hook.vote(poolKey, 8000);
        assertEq(hook.votingWeight(poolId), 100e18);

        vm.prank(lp1);
        hook.vote(poolKey, 2000);

        // Weight must not be double-counted, and the new vote fully replaces the old.
        assertEq(hook.votingWeight(poolId), 100e18, "weight double-counted on re-vote");
        assertEq(hook.effectiveLpShareBps(poolId), 2000, "old vote still contributing");
    }

    function test_voteBeforeLiquidity_takesEffectOnceWeightArrives() public {
        vm.prank(lp1);
        hook.vote(poolKey, 4000); // no liquidity yet — zero weight
        assertEq(hook.effectiveLpShareBps(poolId), BPS, "zero-weight vote must not move the split");

        _addLiquidity(100e18, _attest(lp1Key, lp1));
        assertEq(hook.effectiveLpShareBps(poolId), 4000, "vote did not activate when weight arrived");
    }

    function test_lpExitsCompletely_voteDropsOutOfAverage() public {
        uint256 lp1TokenId = _addLiquidity(100e18, _attest(lp1Key, lp1));
        _addLiquidity(100e18, _attest(lp2Key, lp2));

        vm.prank(lp1);
        hook.vote(poolKey, 9000);
        vm.prank(lp2);
        hook.vote(poolKey, 1000);
        assertEq(hook.effectiveLpShareBps(poolId), 5000);

        positionManager.decreaseLiquidity(lp1TokenId, 100e18, 0, 0, address(this), block.timestamp, "");

        assertEq(hook.lpLiquidity(poolId, lp1), 0, "lp1 weight not cleared");
        assertEq(hook.effectiveLpShareBps(poolId), 1000, "exited LP still influencing the split");
    }

    function test_effectiveSplit_floorsOnUnevenWeights() public {
        _addLiquidity(1e18, _attest(lp1Key, lp1));
        _addLiquidity(2e18, _attest(lp2Key, lp2));

        vm.prank(lp1);
        hook.vote(poolKey, 5000);
        vm.prank(lp2);
        hook.vote(poolKey, 5001);

        // (1*5000 + 2*5001) / 3 = 15002/3 = 5000.67 -> floors to 5000
        assertEq(hook.effectiveLpShareBps(poolId), 5000, "expected floored integer division");
    }

    // ─── Attribution ──────────────────────────────────────────────────────────

    function test_malformedHookData_doesNotRevertTheAdd() public {
        // Long enough to pass the length gate, but not valid abi.encode(address,bytes).
        bytes memory garbage = new bytes(200);
        garbage[0] = 0xff;
        garbage[99] = 0xab;

        uint256 tokenId = _addLiquidity(50e18, garbage); // must not revert
        assertGt(tokenId, 0);
        assertEq(hook.lpLiquidity(poolId, lp1), 0, "garbage must not credit anyone");
        assertEq(hook.totalLiquidity(poolId), 0, "garbage must not be tracked");
    }

    function test_legacyBareAddressHookData_isIgnored() public {
        // The pre-signature format was abi.encode(address) — 32 bytes. It must no longer count.
        _addLiquidity(50e18, abi.encode(lp1));
        assertEq(hook.lpLiquidity(poolId, lp1), 0, "unsigned bare address must not be honoured");
    }

    function test_attestationFromAnotherPool_isRejected() public {
        bytes32 inner = keccak256(abi.encode(block.chainid, address(hook), altPoolKey.toId(), lp1));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lp1Key, MessageHashUtils.toEthSignedMessageHash(inner));

        _addLiquidity(50e18, abi.encode(lp1, abi.encodePacked(r, s, v)));

        assertEq(hook.lpLiquidity(poolId, lp1), 0, "attestation must be pool-bound");
    }

    function test_secondAddToSamePosition_needsNoHookData() public {
        uint256 tokenId = _addLiquidity(50e18, _attest(lp1Key, lp1));
        assertEq(hook.lpLiquidity(poolId, lp1), 50e18);

        // Top up the same position with empty hookData — attribution is already pinned.
        _increaseLiquidity(tokenId, 25e18, "");
        assertEq(hook.lpLiquidity(poolId, lp1), 75e18, "pinned attribution not reused");
    }

    function test_attributionCannotBeHijackedOnTopUp() public {
        uint256 tokenId = _addLiquidity(50e18, _attest(lp1Key, lp1));

        // lp2 tops up lp1's position with their own valid attestation.
        _increaseLiquidity(tokenId, 25e18, _attest(lp2Key, lp2));

        assertEq(hook.lpLiquidity(poolId, lp1), 75e18, "lp1 should keep the whole position");
        assertEq(hook.lpLiquidity(poolId, lp2), 0, "lp2 hijacked an existing position");
    }

    function test_erc1271SmartWalletAttestation_isAccepted() public {
        MockSmartWallet wallet = new MockSmartWallet(lp1);

        bytes32 inner = keccak256(abi.encode(block.chainid, address(hook), poolId, address(wallet)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lp1Key, MessageHashUtils.toEthSignedMessageHash(inner));

        _addLiquidity(60e18, abi.encode(address(wallet), abi.encodePacked(r, s, v)));

        assertEq(hook.lpLiquidity(poolId, address(wallet)), 60e18, "ERC-1271 attestation not honoured");
    }

    function test_removingUnattributedPosition_leavesWeightsAlone() public {
        _addLiquidity(100e18, _attest(lp1Key, lp1));
        uint256 untrackedId = _addLiquidity(80e18, ""); // no attestation

        vm.prank(lp1);
        hook.vote(poolKey, 7000);
        uint256 weightBefore = hook.votingWeight(poolId);

        positionManager.decreaseLiquidity(untrackedId, 80e18, 0, 0, address(this), block.timestamp, "");

        assertEq(hook.lpLiquidity(poolId, lp1), 100e18, "tracked LP weight disturbed");
        assertEq(hook.votingWeight(poolId), weightBefore, "vote sums disturbed");
        assertEq(hook.effectiveLpShareBps(poolId), 7000, "split disturbed");
    }

    function test_attributionDigest_matchesTheOffChainRecipe() public view {
        bytes32 expected =
            MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(block.chainid, address(hook), poolId, lp1)));
        assertEq(hook.attributionDigest(poolKey, lp1), expected, "digest recipe drifted");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 4. Fuzzed invariants
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Any share above 10_000 bps must be rejected; anything at or below must be accepted.
    function testFuzz_vote_boundaryIsExactlyMaxBps(uint256 bps) public {
        if (bps > BPS) {
            vm.prank(lp1);
            vm.expectRevert(GovernedMevAuctionHook.InvalidShare.selector);
            hook.vote(poolKey, bps);
        } else {
            vm.prank(lp1);
            hook.vote(poolKey, bps);
            assertEq(hook.lpVoteBps(poolId, lp1), bps);
        }
    }

    /// @dev A signature from any key other than the LP's must never credit that LP.
    /// forge-config: default.fuzz.runs = 32
    function testFuzz_forgedAttestation_neverCredits(uint256 badKey) public {
        badKey = bound(badKey, 1, type(uint128).max);
        vm.assume(vm.addr(badKey) != lp1);

        _addLiquidity(50e18, abi.encode(lp1, _sign(badKey, lp1)));

        assertEq(hook.lpLiquidity(poolId, lp1), 0, "forged attestation credited the LP");
        assertEq(hook.totalLiquidity(poolId), 0, "forged attestation tracked liquidity");
        assertEq(hook.effectiveLpShareBps(poolId), BPS, "forged attestation moved the split");
    }

    /// @dev Whatever the vote and bid, donation + rebate must equal the bid exactly and the
    ///      hook must retain nothing.
    /// forge-config: default.fuzz.runs = 24
    function testFuzz_splitConservesTheWholeBid(uint256 lpShareBps, uint96 rawBid) public {
        lpShareBps = bound(lpShareBps, 0, BPS);
        uint256 bidAmount = bound(uint256(rawBid), 1, 5 ether);

        _addLiquidity(100e18, _attest(lp1Key, lp1));
        vm.prank(lp1);
        hook.vote(poolKey, lpShareBps);

        uint256 requestId = _requestSwap(alice, 2 ether, true);
        _bid(bidder1, requestId, bidAmount, true);

        uint256 aliceBefore = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        vm.roll(block.number + AUCTION_WINDOW);
        hook.executeSwap(requestId);

        uint256 expectedLpShare = (bidAmount * lpShareBps) / BPS;
        uint256 expectedRebate = bidAmount - expectedLpShare;

        assertEq(
            MockERC20(Currency.unwrap(currency0)).balanceOf(alice) - aliceBefore,
            expectedRebate,
            "trader rebate is not the exact remainder"
        );
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(hook)), 0, "hook retained value");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Helpers
    // ══════════════════════════════════════════════════════════════════════════

    function _fund(address who, uint256 amount) internal {
        deal(Currency.unwrap(currency0), who, amount);
        deal(Currency.unwrap(currency1), who, amount);
    }

    function _requestSwap(address trader, uint256 amount, bool zeroForOne) internal returns (uint256 requestId) {
        Currency input = zeroForOne ? currency0 : currency1;
        vm.startPrank(trader);
        MockERC20(Currency.unwrap(input)).approve(address(hook), amount);
        requestId = hook.requestSwap(
            poolKey, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: 0})
        );
        vm.stopPrank();
    }

    function _bid(address bidder, uint256 requestId, uint256 amount, bool zeroForOne) internal {
        Currency bidCurrency = zeroForOne ? currency0 : currency1;
        vm.startPrank(bidder);
        MockERC20(Currency.unwrap(bidCurrency)).approve(address(hook), amount);
        hook.submitBid(requestId, amount);
        vm.stopPrank();
    }

    function _addLiquidity(uint128 liquidity, bytes memory hookData) internal returns (uint256 tokenId) {
        (uint256 amt0, uint256 amt1) = LiquidityAmounts.getAmountsForLiquidity(
            Constants.SQRT_PRICE_1_1,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            liquidity
        );
        _seedSelf(amt0 + 2, amt1 + 2);

        (tokenId,) = positionManager.mint(
            poolKey, tickLower, tickUpper, liquidity, amt0 + 2, amt1 + 2, address(this), block.timestamp, hookData
        );
    }

    function _increaseLiquidity(uint256 tokenId, uint128 liquidity, bytes memory hookData) internal {
        (uint256 amt0, uint256 amt1) = LiquidityAmounts.getAmountsForLiquidity(
            Constants.SQRT_PRICE_1_1,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            liquidity
        );
        _seedSelf(amt0 + 2, amt1 + 2);

        positionManager.increaseLiquidity(tokenId, liquidity, amt0 + 2, amt1 + 2, block.timestamp, hookData);
    }

    function _seedSelf(uint256 amt0, uint256 amt1) internal {
        deal(Currency.unwrap(currency0), address(this), amt0);
        deal(Currency.unwrap(currency1), address(this), amt1);
        MockERC20(Currency.unwrap(currency0)).approve(address(positionManager), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(positionManager), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(permit2), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(permit2), type(uint256).max);
    }

    function _sign(uint256 signerKey, address lp) internal view returns (bytes memory) {
        bytes32 digest =
            MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(block.chainid, address(hook), poolId, lp)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _attest(uint256 lpKey, address lp) internal view returns (bytes memory) {
        return abi.encode(lp, _sign(lpKey, lp));
    }
}

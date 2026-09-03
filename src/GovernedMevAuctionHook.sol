// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager, SwapParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title GovernedMevAuctionHook
 * @notice LP-governed MEV auction hook for Uniswap v4.
 *
 *         Like the base MevAuctionHook, every large swap becomes an on-chain auction and the
 *         winning bid is captured for the pool. What is NEW here is that the *revenue split* —
 *         how much of each winning bid is donated to in-range LPs vs. rebated back to the trader
 *         who requested the swap — is decided by the LPs of that pool themselves.
 *
 *         Governance is continuous and liquidity-weighted. Each LP calls `vote(key, lpShareBps)`.
 *         The effective split for a pool is the liquidity-weighted average of all LP votes,
 *         recomputed in O(1) on every vote and every liquidity change:
 *
 *              effectiveLpShareBps = Σ(weight_i · vote_i) / Σ(weight_i)      (over LPs who voted)
 *
 *         where `weight_i` is the LP's currently-tracked liquidity in the pool. When no LP has
 *         voted, a sensible default split applies. This makes "LPs vote, weighted by their own
 *         liquidity, on the economics applied to their liquidity" a first-class, on-chain rule.
 *
 *         LP identity: v4 liquidity is added through the PositionManager singleton, so the
 *         `afterAddLiquidity` callback never sees the real LP — only the PositionManager. To
 *         attribute liquidity (and therefore voting weight) to the right address, the LP signs a
 *         one-time attestation (see `attributionDigest`) and passes `abi.encode(lp, signature)` as
 *         the `hookData` of their add-liquidity call. The hook verifies the signature (EOA or
 *         ERC-1271) before crediting weight; liquidity added without a valid attestation simply
 *         carries no governance weight. Attribution is then pinned to the position key, so removals
 *         debit the same LP the add credited regardless of the `hookData` supplied at removal —
 *         this closes the weight-desync vector. Known limitation: transferring the position NFT to
 *         a new owner does not move the vote weight, because the hook cannot observe the transfer.
 */
contract GovernedMevAuctionHook is BaseHook, IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    // ─── Immutable config ─────────────────────────────────────────────────────

    uint256 public immutable smallSwapThreshold;
    uint256 public immutable auctionWindowBlocks;

    /// @notice Basis-point denominator. 10_000 bps = 100%.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Split applied to a pool before any LP has voted: 100% of the bid goes to LPs.
    uint256 public constant DEFAULT_LP_SHARE_BPS = 10_000;

    // ─── Auction storage (unchanged mechanics) ────────────────────────────────

    struct SwapRequest {
        address sender;
        PoolKey key;
        SwapParams params;
        uint256 deadlineBlock;
        uint256 highestBid;
        address highestBidder;
        bool isCompleted;
    }

    uint256 public nextRequestId;
    mapping(uint256 => SwapRequest) public swapRequests;
    mapping(address => mapping(address => uint256)) public pendingRefunds;

    bool private _swapInProgress;

    // ─── Governance storage ───────────────────────────────────────────────────

    /// @notice Tracked liquidity per LP per pool. This is the LP's voting weight.
    mapping(PoolId => mapping(address => uint256)) public lpLiquidity;

    /// @notice Total tracked liquidity per pool (sum of all lpLiquidity for the pool).
    mapping(PoolId => uint256) public totalLiquidity;

    /// @notice Each LP's chosen LP-share (in bps). Only meaningful when `hasVoted` is true.
    mapping(PoolId => mapping(address => uint256)) public lpVoteBps;

    /// @notice Whether an LP has cast a vote in a pool.
    mapping(PoolId => mapping(address => bool)) public hasVoted;

    /// @notice Σ(weight_i · vote_i) over LPs who have voted — numerator of the weighted average.
    mapping(PoolId => uint256) public weightedVoteSum;

    /// @notice Σ(weight_i) over LPs who have voted — denominator of the weighted average.
    mapping(PoolId => uint256) public votingWeight;

    /// @notice LP a tracked position's weight is attributed to, keyed by position key.
    ///         Set once, from a signed attestation, on the first tracked add for that position.
    mapping(PoolId => mapping(bytes32 => address)) public positionAttribution;

    /// @notice Liquidity the hook has tracked for a position key. May lag the pool's real position
    ///         if liquidity was ever added to it without a valid attestation.
    mapping(PoolId => mapping(bytes32 => uint256)) public positionTrackedLiquidity;

    // ─── Events ───────────────────────────────────────────────────────────────

    event SwapRequested(uint256 indexed requestId, address indexed sender, uint256 inputAmount, uint256 deadlineBlock);
    event BidSubmitted(uint256 indexed requestId, address indexed bidder, uint256 bidAmount);
    event SwapExecuted(uint256 indexed requestId, address indexed executor, uint256 lpDonation, uint256 traderRebate);
    event SwapCancelled(uint256 indexed requestId, address indexed sender, uint256 refundedAmount);

    event LiquidityTracked(PoolId indexed poolId, address indexed lp, uint256 newLpLiquidity, uint256 totalLiquidity);
    event Voted(PoolId indexed poolId, address indexed lp, uint256 lpShareBps, uint256 newEffectiveLpShareBps);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error DirectSwapNotAllowed();
    error AuctionStillOpen();
    error AuctionAlreadyClosed();
    error BidTooLow();
    error AlreadyExecuted();
    error RequestNotFound();
    error NoRefundAvailable();
    error OnlyExactIn();
    error WrongETHAmount();
    error UnexpectedETH();
    error NotRequester();
    error BidsAlreadySubmitted();
    error InvalidShare();
    error NoVotingWeight();

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(IPoolManager _poolManager, uint256 _smallSwapThreshold, uint256 _auctionWindowBlocks)
        BaseHook(_poolManager)
    {
        smallSwapThreshold = _smallSwapThreshold;
        auctionWindowBlocks = _auctionWindowBlocks;
    }

    receive() external payable {}

    // ─── Governance: voting ───────────────────────────────────────────────────

    /**
     * @notice Cast (or update) this caller's vote on the LP revenue-share for a pool.
     * @param key         The pool the caller is an LP in.
     * @param lpShareBps  Desired share of each winning bid donated to LPs, in bps (0..10_000).
     *                    The remainder is rebated to the trader who requested the swap.
     *
     * The vote is weighted by the caller's currently-tracked liquidity. Callers with zero
     * tracked liquidity cannot move the outcome (their weight is zero), but the vote is stored
     * so it takes effect the moment they add liquidity.
     */
    function vote(PoolKey calldata key, uint256 lpShareBps) external {
        if (lpShareBps > BPS_DENOMINATOR) revert InvalidShare();
        PoolId poolId = key.toId();
        uint256 weight = lpLiquidity[poolId][msg.sender];

        if (hasVoted[poolId][msg.sender]) {
            // Replace the old contribution with the new one (weight unchanged here).
            weightedVoteSum[poolId] =
                weightedVoteSum[poolId] - (weight * lpVoteBps[poolId][msg.sender]) + (weight * lpShareBps);
        } else {
            hasVoted[poolId][msg.sender] = true;
            votingWeight[poolId] += weight;
            weightedVoteSum[poolId] += weight * lpShareBps;
        }

        lpVoteBps[poolId][msg.sender] = lpShareBps;
        emit Voted(poolId, msg.sender, lpShareBps, effectiveLpShareBps(poolId));
    }

    /// @notice The current liquidity-weighted-average LP share for a pool, in bps.
    function effectiveLpShareBps(PoolId poolId) public view returns (uint256) {
        uint256 w = votingWeight[poolId];
        if (w == 0) return DEFAULT_LP_SHARE_BPS;
        return weightedVoteSum[poolId] / w;
    }

    // ─── Governance: LP attribution ───────────────────────────────────────────

    /**
     * @notice The 32-byte digest an LP signs once to attribute their liquidity (and the governance
     *         voting weight it carries) in `key` to `lp`.
     * @param key  The pool the LP provides liquidity to.
     * @param lp   The address that should own the voting weight (usually the signer / EOA, but an
     *             ERC-1271 contract wallet works too).
     *
     * The digest binds `block.chainid`, this hook's address, the pool id and `lp`, so a signature
     * cannot be replayed against another pool, hook or chain. It is deliberately not bound to an
     * amount, nonce, deadline or specific position: one signature authorises all of that LP's
     * liquidity in the pool, so a frontend can capture it once and attach it to every add call
     * (and subsequent adds to an already-attributed position need no `hookData` at all).
     *
     * The only consequence of the loose binding is that a third party could attach a *published*
     * attestation to their own deposit and thereby credit `lp` with voting weight backed by
     * someone else's capital. That grants no capability the third party does not already have by
     * depositing and voting themselves, and the weight unwinds when that deposit is withdrawn.
     *
     * The signature is passed as `abi.encode(lp, signature)` in the `hookData` argument of the
     * add-liquidity call.
     */
    function attributionDigest(PoolKey calldata key, address lp) public view returns (bytes32) {
        return _attributionDigest(key.toId(), lp);
    }

    function _attributionDigest(PoolId poolId, address lp) internal view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(block.chainid, address(this), poolId, lp)));
    }

    /// @dev External so `_recoverAttributedLp` can `try` it — a malformed `hookData` then yields
    ///      "no attribution" instead of reverting the whole liquidity operation.
    function decodeAttribution(bytes calldata hookData) external pure returns (address lp, bytes memory signature) {
        (lp, signature) = abi.decode(hookData, (address, bytes));
    }

    /// @dev Returns the attested LP encoded in `hookData`, or `address(0)` if absent/invalid.
    function _recoverAttributedLp(PoolId poolId, bytes calldata hookData) internal view returns (address) {
        if (hookData.length < 96) return address(0);
        try this.decodeAttribution(hookData) returns (address lp, bytes memory signature) {
            if (lp == address(0) || signature.length == 0) return address(0);
            if (SignatureChecker.isValidSignatureNow(lp, _attributionDigest(poolId, lp), signature)) {
                return lp;
            }
            return address(0);
        } catch {
            return address(0);
        }
    }

    function _positionKey(address owner, ModifyLiquidityParams calldata params) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, params.tickLower, params.tickUpper, params.salt));
    }

    // ─── Auction functions ────────────────────────────────────────────────────

    function requestSwap(PoolKey calldata key, SwapParams calldata params)
        external
        payable
        returns (uint256 requestId)
    {
        if (params.amountSpecified >= 0) revert OnlyExactIn();

        uint256 absAmount = uint256(-params.amountSpecified);
        Currency inputCurrency = params.zeroForOne ? key.currency0 : key.currency1;

        if (inputCurrency.isAddressZero()) {
            if (msg.value != absAmount) revert WrongETHAmount();
        } else {
            if (msg.value != 0) revert UnexpectedETH();
            IERC20Minimal(Currency.unwrap(inputCurrency)).transferFrom(msg.sender, address(this), absAmount);
        }

        SwapParams memory normalizedParams = SwapParams({
            zeroForOne: params.zeroForOne,
            amountSpecified: params.amountSpecified,
            sqrtPriceLimitX96: params.sqrtPriceLimitX96 == 0
                ? (params.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
                : params.sqrtPriceLimitX96
        });

        requestId = nextRequestId++;

        bool isSmall = absAmount < smallSwapThreshold;
        swapRequests[requestId] = SwapRequest({
            sender: msg.sender,
            key: key,
            params: normalizedParams,
            deadlineBlock: isSmall ? block.number : block.number + auctionWindowBlocks,
            highestBid: 0,
            highestBidder: address(0),
            isCompleted: false
        });

        if (isSmall) {
            _doExecuteSwap(requestId);
        } else {
            emit SwapRequested(requestId, msg.sender, absAmount, block.number + auctionWindowBlocks);
        }
    }

    function cancelSwap(uint256 requestId) external {
        SwapRequest storage request = swapRequests[requestId];
        if (request.sender == address(0)) revert RequestNotFound();
        if (request.isCompleted) revert AlreadyExecuted();
        if (msg.sender != request.sender) revert NotRequester();

        bool hasBids = request.highestBid > 0;
        if (hasBids) revert BidsAlreadySubmitted();

        request.isCompleted = true;

        uint256 inputAmount = uint256(-request.params.amountSpecified);
        Currency inputCurrency = request.params.zeroForOne ? request.key.currency0 : request.key.currency1;

        if (inputCurrency.isAddressZero()) {
            (bool ok,) = msg.sender.call{value: inputAmount}("");
            require(ok, "ETH refund failed");
        } else {
            IERC20Minimal(Currency.unwrap(inputCurrency)).transfer(msg.sender, inputAmount);
        }

        emit SwapCancelled(requestId, msg.sender, inputAmount);
    }

    function submitBid(uint256 requestId, uint256 bidAmount) external payable {
        SwapRequest storage request = swapRequests[requestId];
        if (request.sender == address(0)) revert RequestNotFound();
        if (request.isCompleted) revert AlreadyExecuted();
        if (block.number >= request.deadlineBlock) revert AuctionAlreadyClosed();

        Currency bidCurrency = request.params.zeroForOne ? request.key.currency0 : request.key.currency1;
        uint256 actualBid;

        if (bidCurrency.isAddressZero()) {
            actualBid = msg.value;
        } else {
            if (msg.value != 0) revert UnexpectedETH();
            actualBid = bidAmount;
            IERC20Minimal(Currency.unwrap(bidCurrency)).transferFrom(msg.sender, address(this), bidAmount);
        }

        if (actualBid <= request.highestBid) revert BidTooLow();

        if (request.highestBidder != address(0)) {
            pendingRefunds[request.highestBidder][Currency.unwrap(bidCurrency)] += request.highestBid;
        }

        request.highestBid = actualBid;
        request.highestBidder = msg.sender;

        emit BidSubmitted(requestId, msg.sender, actualBid);
    }

    function executeSwap(uint256 requestId) external {
        SwapRequest storage request = swapRequests[requestId];
        if (request.sender == address(0)) revert RequestNotFound();
        if (request.isCompleted) revert AlreadyExecuted();
        if (block.number < request.deadlineBlock) revert AuctionStillOpen();

        _doExecuteSwap(requestId);
    }

    function withdrawRefund(address currencyAddress) external {
        uint256 amount = pendingRefunds[msg.sender][currencyAddress];
        if (amount == 0) revert NoRefundAvailable();

        pendingRefunds[msg.sender][currencyAddress] = 0;

        Currency currency = Currency.wrap(currencyAddress);
        if (currency.isAddressZero()) {
            (bool ok,) = msg.sender.call{value: amount}("");
            require(ok, "ETH refund failed");
        } else {
            IERC20Minimal(currencyAddress).transfer(msg.sender, amount);
        }
    }

    // ─── IUnlockCallback ──────────────────────────────────────────────────────

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint256 requestId, address executor) = abi.decode(data, (uint256, address));
        SwapRequest storage request = swapRequests[requestId];

        _swapInProgress = true;

        BalanceDelta swapDelta = poolManager.swap(request.key, request.params, "");

        _swapInProgress = false;

        int128 delta0 = swapDelta.amount0();
        int128 delta1 = swapDelta.amount1();

        // Governed revenue split: LPs get `lpShare`, the trader gets the `rebate`.
        uint256 bid = request.highestBid;
        uint256 lpShare = (bid * effectiveLpShareBps(request.key.toId())) / BPS_DENOMINATOR;
        uint256 rebate = bid - lpShare;

        if (request.params.zeroForOne) {
            // Bid + swap input are both in currency0.
            if (lpShare > 0) {
                poolManager.donate(request.key, lpShare, 0, "");
            }
            if (delta1 > 0) {
                poolManager.take(request.key.currency1, request.sender, uint128(delta1));
            }
            uint256 toSettle0 = uint256(uint128(-delta0)) + lpShare;
            if (toSettle0 > 0) {
                _settle(request.key.currency0, toSettle0);
            }
            if (rebate > 0) {
                _payout(request.key.currency0, request.sender, rebate);
            }
        } else {
            // Bid + swap input are both in currency1.
            if (lpShare > 0) {
                poolManager.donate(request.key, 0, lpShare, "");
            }
            if (delta0 > 0) {
                poolManager.take(request.key.currency0, request.sender, uint128(delta0));
            }
            uint256 toSettle1 = uint256(uint128(-delta1)) + lpShare;
            if (toSettle1 > 0) {
                _settle(request.key.currency1, toSettle1);
            }
            if (rebate > 0) {
                _payout(request.key.currency1, request.sender, rebate);
            }
        }

        emit SwapExecuted(requestId, executor, lpShare, rebate);

        return "";
    }

    // ─── Hook permissions ─────────────────────────────────────────────────────

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: true,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: true,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ─── Hook callbacks ───────────────────────────────────────────────────────

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!_swapInProgress) revert DirectSwapNotAllowed();
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /**
     * @dev Track an LP's liquidity (their voting weight). Because liquidity in v4 is added through
     *      the PositionManager singleton, `sender` is not the real LP — the LP is recovered from a
     *      signed attestation in `hookData` (`abi.encode(lp, signature)`) the first time a position
     *      is tracked, and pinned to that position's key. Liquidity added with no valid attestation
     *      carries no governance weight.
     */
    function _afterAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        BalanceDelta,
        BalanceDelta,
        bytes calldata hookData
    ) internal override returns (bytes4, BalanceDelta) {
        if (params.liquidityDelta > 0) {
            PoolId poolId = key.toId();
            bytes32 positionKey = _positionKey(sender, params);

            address lp = positionAttribution[poolId][positionKey];
            if (lp == address(0)) {
                lp = _recoverAttributedLp(poolId, hookData);
                if (lp != address(0)) positionAttribution[poolId][positionKey] = lp;
            }

            if (lp != address(0)) {
                uint256 amount = uint256(params.liquidityDelta);
                positionTrackedLiquidity[poolId][positionKey] += amount;
                _addWeight(poolId, lp, amount);
            }
        }
        return (BaseHook.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    /**
     * @dev Debits the LP the matching add credited, looked up by position key. `hookData` is not
     *      consulted here, so a removal cannot mis-attribute weight or desync the vote sums.
     */
    function _afterRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) internal override returns (bytes4, BalanceDelta) {
        if (params.liquidityDelta < 0) {
            PoolId poolId = key.toId();
            bytes32 positionKey = _positionKey(sender, params);
            address lp = positionAttribution[poolId][positionKey];

            if (lp != address(0)) {
                uint256 amount = uint256(-params.liquidityDelta);
                uint256 tracked = positionTrackedLiquidity[poolId][positionKey];
                if (amount > tracked) amount = tracked;
                if (amount > 0) {
                    positionTrackedLiquidity[poolId][positionKey] = tracked - amount;
                    _removeWeight(poolId, lp, amount);
                }
            }
        }
        return (BaseHook.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    /// @dev Increase an LP's weight, keeping the weighted-vote sums consistent.
    function _addWeight(PoolId poolId, address lp, uint256 amount) internal {
        lpLiquidity[poolId][lp] += amount;
        totalLiquidity[poolId] += amount;
        if (hasVoted[poolId][lp]) {
            votingWeight[poolId] += amount;
            weightedVoteSum[poolId] += amount * lpVoteBps[poolId][lp];
        }
        emit LiquidityTracked(poolId, lp, lpLiquidity[poolId][lp], totalLiquidity[poolId]);
    }

    /// @dev Decrease an LP's weight, clamping to what we have tracked.
    function _removeWeight(PoolId poolId, address lp, uint256 amount) internal {
        uint256 current = lpLiquidity[poolId][lp];
        if (amount > current) amount = current;
        if (amount == 0) return;

        lpLiquidity[poolId][lp] = current - amount;
        totalLiquidity[poolId] -= amount;
        if (hasVoted[poolId][lp]) {
            votingWeight[poolId] -= amount;
            weightedVoteSum[poolId] -= amount * lpVoteBps[poolId][lp];
        }
        emit LiquidityTracked(poolId, lp, lpLiquidity[poolId][lp], totalLiquidity[poolId]);
    }

    function _doExecuteSwap(uint256 requestId) internal {
        swapRequests[requestId].isCompleted = true;
        poolManager.unlock(abi.encode(requestId, msg.sender));
    }

    function _settle(Currency currency, uint256 amount) internal {
        if (currency.isAddressZero()) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            currency.transfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    /// @dev Pay a rebate straight from the hook's own token/ETH balance (bid funds are held here).
    function _payout(Currency currency, address to, uint256 amount) internal {
        if (currency.isAddressZero()) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "ETH rebate failed");
        } else {
            IERC20Minimal(Currency.unwrap(currency)).transfer(to, amount);
        }
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    struct RequestInfo {
        address sender;
        address currency0;
        address currency1;
        bool zeroForOne;
        int256 amountSpecified;
        uint256 deadlineBlock;
        uint256 highestBid;
        address highestBidder;
        bool isCompleted;
        bool auctionOpen;
    }

    function getRequestInfo(uint256 requestId) external view returns (RequestInfo memory info) {
        SwapRequest storage r = swapRequests[requestId];
        info = RequestInfo({
            sender: r.sender,
            currency0: Currency.unwrap(r.key.currency0),
            currency1: Currency.unwrap(r.key.currency1),
            zeroForOne: r.params.zeroForOne,
            amountSpecified: r.params.amountSpecified,
            deadlineBlock: r.deadlineBlock,
            highestBid: r.highestBid,
            highestBidder: r.highestBidder,
            isCompleted: r.isCompleted,
            auctionOpen: !r.isCompleted && block.number < r.deadlineBlock
        });
    }

    /// @notice Convenience view bundling a pool's live governance state for the frontend.
    struct GovernanceInfo {
        uint256 effectiveLpShareBps;
        uint256 traderRebateBps;
        uint256 totalLiquidity;
        uint256 votingWeight;
    }

    function getGovernanceInfo(PoolKey calldata key) external view returns (GovernanceInfo memory info) {
        PoolId poolId = key.toId();
        uint256 lpShare = effectiveLpShareBps(poolId);
        info = GovernanceInfo({
            effectiveLpShareBps: lpShare,
            traderRebateBps: BPS_DENOMINATOR - lpShare,
            totalLiquidity: totalLiquidity[poolId],
            votingWeight: votingWeight[poolId]
        });
    }
}

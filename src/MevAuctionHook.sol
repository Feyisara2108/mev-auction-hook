// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager, SwapParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";

contract MevAuctionHook is BaseHook, IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;
    using CurrencyLibrary for Currency;

    // ─── Immutable config ─────────────────────────────────────────────────────

    uint256 public immutable smallSwapThreshold;
    uint256 public immutable auctionWindowBlocks;

    // ─── Storage ──────────────────────────────────────────────────────────────

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
    uint256 private _currentRequestId;

    // ─── Events ───────────────────────────────────────────────────────────────

    event SwapRequested(uint256 indexed requestId, address indexed sender, uint256 inputAmount, uint256 deadlineBlock);
    event BidSubmitted(uint256 indexed requestId, address indexed bidder, uint256 bidAmount);
    event SwapExecuted(uint256 indexed requestId, address indexed executor, uint256 donatedAmount);
    event SwapCancelled(uint256 indexed requestId, address indexed sender, uint256 refundedAmount);

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

    // Constructor

    constructor(IPoolManager _poolManager, uint256 _smallSwapThreshold, uint256 _auctionWindowBlocks)
        BaseHook(_poolManager)
    {
        smallSwapThreshold = _smallSwapThreshold;
        auctionWindowBlocks = _auctionWindowBlocks;
    }

    receive() external payable {}

    //Public auction functions

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
            emit SwapExecuted(requestId, msg.sender, 0);
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

        uint256 bid = request.highestBid;
        _doExecuteSwap(requestId);
        emit SwapExecuted(requestId, msg.sender, bid);
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
        uint256 requestId = abi.decode(data, (uint256));
        SwapRequest storage request = swapRequests[requestId];

        _swapInProgress = true;
        _currentRequestId = requestId;

        BalanceDelta swapDelta = poolManager.swap(request.key, request.params, "");

        _swapInProgress = false;
        _currentRequestId = 0;

        int128 delta0 = swapDelta.amount0();
        int128 delta1 = swapDelta.amount1();
        uint256 bid = request.highestBid;

        if (request.params.zeroForOne) {
            if (bid > 0) {
                poolManager.donate(request.key, bid, 0, "");
            }
            if (delta1 > 0) {
                poolManager.take(request.key.currency1, request.sender, uint128(delta1));
            }
            uint256 toSettle0 = uint256(uint128(-delta0)) + bid;
            if (toSettle0 > 0) {
                _settle(request.key.currency0, toSettle0);
            }
        } else {
            if (bid > 0) {
                poolManager.donate(request.key, 0, bid, "");
            }
            if (delta0 > 0) {
                poolManager.take(request.key.currency0, request.sender, uint128(delta0));
            }
            uint256 toSettle1 = uint256(uint128(-delta1)) + bid;
            if (toSettle1 > 0) {
                _settle(request.key.currency1, toSettle1);
            }
        }

        return "";
    }

    // ─── Hook permissions ─────────────────────────────────────────────────────

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
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

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _doExecuteSwap(uint256 requestId) internal {
        swapRequests[requestId].isCompleted = true;
        poolManager.unlock(abi.encode(requestId));
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
}

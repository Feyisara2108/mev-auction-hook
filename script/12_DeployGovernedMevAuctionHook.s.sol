// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {GovernedMevAuctionHook} from "../src/GovernedMevAuctionHook.sol";

/**
 * @notice Deploys GovernedMevAuctionHook to Unichain Sepolia using CREATE2 so the hook address
 *         encodes the BEFORE_SWAP + AFTER_ADD_LIQUIDITY + AFTER_REMOVE_LIQUIDITY permission flags
 *         in its lower bits (Uniswap v4 requirement).
 *
 * Usage:
 *   forge script script/12_DeployGovernedMevAuctionHook.s.sol \
 *     --rpc-url $RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     --verify \
 *     --verifier-url https://api-sepolia.uniscan.xyz/api \
 *     --etherscan-api-key $UNISCAN_API_KEY \
 *     -vvv
 *
 *   Then copy the deployed hook address into HOOK_ADDRESS in .env (and the frontend .env.local)
 *   and run script/05_CreatePool.s.sol against it.
 */
contract DeployGovernedMevAuctionHook is Script {
    // Standard CREATE2 deployer proxy — same address on all EVM chains
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // Unichain Sepolia Uniswap v4 PoolManager (chainId 1301)
    IPoolManager constant POOL_MANAGER = IPoolManager(0x00B036B58a818B1BC34d502D3fE730Db729e62AC);

    // Auction config — matches test defaults; adjust after deployment if needed
    uint256 constant SMALL_SWAP_THRESHOLD = 1 ether; // swaps below this skip the auction
    uint256 constant AUCTION_WINDOW_BLOCKS = 3; // ~3 s on Unichain (1-second blocks)

    function run() external {
        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
        );

        bytes memory constructorArgs = abi.encode(POOL_MANAGER, SMALL_SWAP_THRESHOLD, AUCTION_WINDOW_BLOCKS);

        console2.log("Mining hook address (this may take a few seconds)...");
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(GovernedMevAuctionHook).creationCode, constructorArgs);
        console2.log("Target hook address :", hookAddress);
        console2.log("Salt                :", vm.toString(salt));

        vm.startBroadcast();
        GovernedMevAuctionHook hook =
            new GovernedMevAuctionHook{salt: salt}(POOL_MANAGER, SMALL_SWAP_THRESHOLD, AUCTION_WINDOW_BLOCKS);
        vm.stopBroadcast();

        require(address(hook) == hookAddress, "Hook address mismatch - re-run the script");

        console2.log("");
        console2.log("=== GovernedMevAuctionHook deployed ===");
        console2.log("Address            :", address(hook));
        console2.log("PoolManager        :", address(POOL_MANAGER));
        console2.log("SmallSwapThreshold :", SMALL_SWAP_THRESHOLD);
        console2.log("AuctionWindow      :", AUCTION_WINDOW_BLOCKS, "blocks");
        console2.log("");
        console2.log("Next: set HOOK_ADDRESS in .env to the address above, then run script/05_CreatePool.s.sol");
    }
}

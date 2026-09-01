// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";

import {IUniswapV4Router04} from "hookmate/interfaces/router/IUniswapV4Router04.sol";
import {AddressConstants} from "hookmate/constants/AddressConstants.sol";

import {Deployers} from "test/utils/Deployers.sol";

/// @notice Shared script base — set TOKEN0_ADDRESS, TOKEN1_ADDRESS, HOOK_ADDRESS in .env
contract BaseScript is Script, Deployers {
    address immutable deployerAddress;

    IERC20 internal immutable token0;
    IERC20 internal immutable token1;
    IHooks internal immutable hookContract;

    Currency immutable currency0;
    Currency immutable currency1;

    constructor() {
        token0       = IERC20(vm.envOr("TOKEN0_ADDRESS", address(0)));
        token1       = IERC20(vm.envOr("TOKEN1_ADDRESS", address(0)));
        hookContract = IHooks(vm.envOr("HOOK_ADDRESS",   address(0)));

        deployArtifacts();
        deployerAddress = getDeployer();

        (currency0, currency1) = getCurrencies();

        vm.label(address(permit2),         "Permit2");
        vm.label(address(poolManager),     "V4PoolManager");
        vm.label(address(positionManager), "V4PositionManager");
        vm.label(address(swapRouter),      "V4SwapRouter");
        vm.label(address(token0),          "Currency0");
        vm.label(address(token1),          "Currency1");
        vm.label(address(hookContract),    "HookContract");
    }

    function _etch(address target, bytes memory bytecode) internal override {
        if (block.chainid == 31337) {
            vm.rpc("anvil_setCode", string.concat('["', vm.toString(target), '",', '"', vm.toString(bytecode), '"]'));
        } else {
            revert("Unsupported etch on this network");
        }
    }

    function getCurrencies() internal view returns (Currency, Currency) {
        require(address(token0) != address(token1));

        if (address(token0) < address(token1)) {
            return (Currency.wrap(address(token0)), Currency.wrap(address(token1)));
        } else {
            return (Currency.wrap(address(token1)), Currency.wrap(address(token0)));
        }
    }

    function getDeployer() internal returns (address) {
        address[] memory wallets = vm.getWallets();

        if (wallets.length > 0) {
            return wallets[0];
        } else {
            return msg.sender;
        }
    }
}

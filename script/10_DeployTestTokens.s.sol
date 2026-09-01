// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

contract DeployTestTokensScript is Script {
    function run() external {
        vm.startBroadcast();

        MockERC20 tokenA = new MockERC20("MEV Token A", "TKNA", 18);
        MockERC20 tokenB = new MockERC20("MEV Token B", "TKNB", 18);

        tokenA.mint(msg.sender, 1_000_000e18);
        tokenB.mint(msg.sender, 1_000_000e18);

        vm.stopBroadcast();

        console2.log("=== Test tokens deployed ===");
        console2.log("TKNA:", address(tokenA));
        console2.log("TKNB:", address(tokenB));
        console2.log("");

        if (address(tokenA) < address(tokenB)) {
            console2.log("TOKEN0_ADDRESS:", address(tokenA), "(TKNA)");
            console2.log("TOKEN1_ADDRESS:", address(tokenB), "(TKNB)");
        } else {
            console2.log("TOKEN0_ADDRESS:", address(tokenB), "(TKNB)");
            console2.log("TOKEN1_ADDRESS:", address(tokenA), "(TKNA)");
        }
    }
}

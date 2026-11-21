// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {RandomnessOracle} from "../src/RandomnessOracle.sol";
import {AuditSampler} from "../src/AuditSampler.sol";

/// @notice Needs ORACLE_PK_0..3 (from `npm run keygen`), ORACLE_OPERATOR and ORACLE_FEE (wei).
///         For a key split across nodes, also ORACLE_THRESHOLD and ORACLE_SHARE_PK_1..n, each four numbers
///         separated by commas. The oracle stores them and refuses a set that does not make up the public key.
contract DeployOracle is Script {
    function run() external returns (RandomnessOracle oracle, AuditSampler sampler) {
        uint256[4] memory pk =
            [vm.envUint("ORACLE_PK_0"), vm.envUint("ORACLE_PK_1"), vm.envUint("ORACLE_PK_2"), vm.envUint("ORACLE_PK_3")];
        uint256 threshold = vm.envOr("ORACLE_THRESHOLD", uint256(1));
        uint256[4][] memory shares = threshold == 1 ? new uint256[4][](0) : _shareKeys();
        vm.startBroadcast();
        oracle = new RandomnessOracle(pk, payable(vm.envAddress("ORACLE_OPERATOR")), vm.envUint("ORACLE_FEE"), uint8(threshold), shares);
        sampler = new AuditSampler(oracle);
        vm.stopBroadcast();
        console.log("ORACLE_ADDRESS=%s", address(oracle));
        console.log("SAMPLER_ADDRESS=%s", address(sampler));
    }

    function _shareKeys() private view returns (uint256[4][] memory shares) {
        uint256 n;
        while (vm.envExists(_name(n + 1))) n++;
        shares = new uint256[4][](n);
        for (uint256 i; i < n; i++) {
            uint256[] memory words = vm.envUint(_name(i + 1), ",");
            require(words.length == 4, "a share key is four numbers");
            shares[i] = [words[0], words[1], words[2], words[3]];
        }
    }

    function _name(uint256 index) private pure returns (string memory) {
        return string.concat("ORACLE_SHARE_PK_", vm.toString(index));
    }
}

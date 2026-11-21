// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {RandomnessOracle} from "../src/RandomnessOracle.sol";
import {AuditSampler} from "../src/AuditSampler.sol";

/// @notice Adds an AuditSampler to an oracle that is already deployed. Needs ORACLE_ADDRESS.
contract DeploySampler is Script {
    function run() external returns (AuditSampler sampler) {
        vm.startBroadcast();
        sampler = new AuditSampler(RandomnessOracle(payable(vm.envAddress("ORACLE_ADDRESS"))));
        vm.stopBroadcast();
        console.log("SAMPLER_ADDRESS=%s", address(sampler));
    }
}

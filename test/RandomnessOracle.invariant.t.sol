// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {BLS} from "../src/BLS.sol";
import {RandomnessOracle} from "../src/RandomnessOracle.sol";

/// Random sequences of request, answer, expire and withdraw. The money the oracle holds must always cover
/// everything it owes, and nobody may take more than they paid in or earned.
contract OracleHandler is Test {
    RandomnessOracle internal immutable oracle;
    uint256 internal immutable sk;
    uint256 internal immutable fee;
    address[] internal requesters;
    uint256[] internal open;

    uint256 public paidIn;
    uint256 public paidOut;

    constructor(RandomnessOracle oracle_, uint256 sk_) {
        oracle = oracle_;
        sk = sk_;
        fee = oracle_.fee();
        for (uint160 i = 1; i <= 4; i++) requesters.push(address(i * 0x1000));
    }

    function request(uint256 who) external {
        address r = requesters[who % requesters.length];
        vm.deal(r, fee);
        vm.prank(r);
        open.push(oracle.requestRandomness{value: fee}());
        paidIn += fee;
        vm.roll(block.number + 1);
    }

    function answer(uint256 which) external {
        if (open.length == 0) return;
        uint256 id = open[which % open.length];
        if (oracle.statusOf(id) != RandomnessOracle.Status.Pending) return;
        (uint256 x, uint256 y) = BLS.hashToG1(oracle.messageOf(id));
        (, bytes memory out) = address(7).staticcall(abi.encode(x, y, sk));
        (uint256 sx, uint256 sy) = abi.decode(out, (uint256, uint256));
        try oracle.fulfill(id, [sx, sy]) {} catch {}
    }

    function expire(uint256 which, uint256 wait) external {
        if (open.length == 0) return;
        uint256 id = open[which % open.length];
        vm.roll(block.number + bound(wait, 0, 400));
        try oracle.expire(id) {} catch {}
    }

    function withdrawRefund(uint256 who, uint256 amount) external {
        address r = requesters[who % requesters.length];
        uint256 owed = oracle.refunds(r);
        if (owed == 0) return;
        amount = bound(amount, 1, owed);
        uint256 before = r.balance;
        vm.prank(r);
        oracle.withdrawRefund(payable(r), amount);
        paidOut += r.balance - before;
    }

    function withdraw() external {
        address payable op = oracle.operator();
        uint256 before = op.balance;
        try oracle.withdraw() {} catch {}
        paidOut += op.balance - before;
    }

    function owedToRequesters() external view returns (uint256 sum) {
        for (uint256 i; i < requesters.length; i++) sum += oracle.refunds(requesters[i]);
    }

    function pendingFees() external view returns (uint256 sum) {
        for (uint256 i; i < open.length; i++) {
            if (oracle.statusOf(open[i]) == RandomnessOracle.Status.Pending) sum += fee;
        }
    }
}

/// Kept small so it runs in seconds: every answer does a BLS pairing.
/// forge-config: default.invariant.runs = 32
/// forge-config: default.invariant.depth = 40
contract RandomnessOracleInvariantTest is Test {
    RandomnessOracle internal oracle;
    OracleHandler internal handler;

    function setUp() public {
        string memory json = vm.readFile("test/fixtures/bls.json");
        uint256[4] memory pk;
        for (uint256 i; i < 4; i++) pk[i] = vm.parseJsonUint(json, string.concat(".publicKey[", vm.toString(i), "]"));
        oracle = new RandomnessOracle(pk, payable(address(0xA11CE)), 0.01 ether, 1, new uint256[4][](0));
        vm.roll(1000);
        handler = new OracleHandler(oracle, vm.parseJsonUint(json, ".sk"));
        targetContract(address(handler));
    }

    /// Everything still owed is backed by the contract's balance.
    function invariant_balanceCoversWhatIsOwed() public view {
        assertGe(address(oracle).balance, oracle.earned() + handler.owedToRequesters() + handler.pendingFees());
    }

    /// Money only leaves as earned fees or refunds, never more than came in.
    function invariant_noMoneyCreated() public view {
        assertEq(address(oracle).balance + handler.paidOut(), handler.paidIn());
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {BLS} from "../src/BLS.sol";
import {IRandomnessConsumer, RandomnessOracle} from "../src/RandomnessOracle.sol";
import {AuditSampler} from "../src/AuditSampler.sol";

contract Consumer is IRandomnessConsumer {
    RandomnessOracle public immutable oracle;
    uint256 public lastId;
    uint256 public lastValue;
    uint256 public calls;
    uint256 public gasSeen;

    constructor(RandomnessOracle oracle_) {
        oracle = oracle_;
    }

    function request() external payable returns (uint256) {
        return oracle.requestRandomness{value: msg.value}();
    }

    function onRandomness(uint256 requestId, uint256 randomness) external virtual {
        gasSeen = gasleft();
        lastId = requestId;
        lastValue = randomness;
        calls++;
    }

    function withdrawRefund(address payable to, uint256 amount) external {
        oracle.withdrawRefund(to, amount);
    }
}

contract RevertingConsumer is Consumer {
    constructor(RandomnessOracle oracle_) Consumer(oracle_) {}

    function onRandomness(uint256, uint256) external pure override {
        revert("no");
    }
}

contract GasBurner is Consumer {
    constructor(RandomnessOracle oracle_) Consumer(oracle_) {}

    function onRandomness(uint256, uint256) external pure override {
        while (true) {}
    }
}

contract ReturnBomb is Consumer {
    constructor(RandomnessOracle oracle_) Consumer(oracle_) {}

    function onRandomness(uint256, uint256) external pure override {
        assembly {
            // As large as the callback allowance can afford. Copying it back would cost the caller about the same again.
            revert(0, 250000)
        }
    }
}

contract Reenterer is Consumer {
    bytes public innerError;
    uint256 public resultSeen;
    RandomnessOracle.Status public statusSeen;
    uint256[2] private sig;

    constructor(RandomnessOracle oracle_) Consumer(oracle_) {}

    function setSig(uint256[2] memory s) external {
        sig = s;
    }

    function onRandomness(uint256 requestId, uint256) external override {
        calls++;
        statusSeen = oracle.statusOf(requestId);
        resultSeen = oracle.randomnessOf(requestId);
        try oracle.fulfill(requestId, sig) {} catch (bytes memory reason) {
            innerError = reason;
        }
    }
}

contract OracleTestBase is Test {
    uint256 internal constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant FEE = 0.01 ether;
    address payable internal constant OPERATOR = payable(address(0xA11CE));

    uint256 internal sk;
    uint256[4] internal pk;
    string internal json;
    RandomnessOracle internal oracle;

    function setUp() public virtual {
        json = vm.readFile("test/fixtures/bls.json");
        sk = vm.parseJsonUint(json, ".sk");
        for (uint256 i; i < 4; i++) {
            pk[i] = vm.parseJsonUint(json, string.concat(".publicKey[", vm.toString(i), "]"));
        }
        oracle = new RandomnessOracle(pk, OPERATOR, FEE, 1, new uint256[4][](0));
        vm.roll(1000);
    }

    function _signWith(uint256 key, bytes32 message) internal view returns (uint256[2] memory sig) {
        (uint256 x, uint256 y) = BLS.hashToG1(message);
        (bool ok, bytes memory out) = address(7).staticcall(abi.encode(x, y, key));
        require(ok, "ecMul");
        (sig[0], sig[1]) = abi.decode(out, (uint256, uint256));
    }

    /// Moves `age` blocks past the request and pins the hash the contract will read.
    function _age(uint256 requestId, uint256 age) internal {
        (, uint64 requestBlock,) = oracle.requests(requestId);
        vm.setBlockhash(requestBlock, keccak256(abi.encode("block", requestBlock)));
        vm.roll(requestBlock + age);
    }

    function _signed(uint256 requestId) internal view returns (uint256[2] memory) {
        return _signWith(sk, oracle.messageOf(requestId));
    }
}

contract BLSTest is OracleTestBase {
    function _vector(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".vectors[", vm.toString(i), "].", field);
    }

    function test_hashToG1_matchesTheNode() public view {
        uint256 retries;
        for (uint256 i; i < 5; i++) {
            bytes32 m = vm.parseJsonBytes32(json, _vector(i, "message"));
            (uint256 x, uint256 y) = BLS.hashToG1(m);
            assertEq(x, vm.parseJsonUint(json, _vector(i, "hx")));
            assertEq(y, vm.parseJsonUint(json, _vector(i, "hy")));
            if (vm.parseJsonUint(json, _vector(i, "attempts")) > 0) retries++;
        }
        assertGt(retries, 0, "vectors must cover retries");
    }

    function test_verify_acceptsSignaturesFromTheNode() public view {
        for (uint256 i; i < 5; i++) {
            bytes32 m = vm.parseJsonBytes32(json, _vector(i, "message"));
            uint256[2] memory sig = [vm.parseJsonUint(json, _vector(i, "sigX")), vm.parseJsonUint(json, _vector(i, "sigY"))];
            assertTrue(BLS.verify(pk, m, sig));
            uint256[2] memory mine = _signWith(sk, m);
            assertEq(mine[0], sig[0]);
            assertEq(mine[1], sig[1]);
        }
    }

    function test_verify_rejectsAlteredSignatures() public view {
        bytes32 m = keccak256("m");
        uint256[2] memory sig = _signWith(sk, m);

        assertFalse(BLS.verify(pk, keccak256("other"), sig), "other message");
        assertFalse(BLS.verify(pk, m, _signWith(sk + 1, m)), "other key");
        assertFalse(BLS.verify(pk, m, [uint256(0), uint256(0)]), "infinity");
        assertFalse(BLS.verify(pk, m, [sig[0], P - sig[1]]), "negated");
        assertFalse(BLS.verify(pk, m, [sig[0] + P, sig[1]]), "non canonical x");
        assertFalse(BLS.verify(pk, m, [sig[0], sig[1] + 1]), "not on curve");
    }

    function test_messageEncoding_matchesTheNode() public view {
        bytes32 expected = keccak256(
            abi.encode(
                vm.parseJsonUint(json, ".request.chainId"),
                vm.parseJsonAddress(json, ".request.oracle"),
                vm.parseJsonUint(json, ".request.requestId"),
                vm.parseJsonAddress(json, ".request.consumer"),
                vm.parseJsonBytes32(json, ".request.blockHash")
            )
        );
        assertEq(expected, vm.parseJsonBytes32(json, ".request.message"));
    }
}

contract RandomnessOracleTest is OracleTestBase {
    Consumer internal consumer;

    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomness, bool callbackOk);

    function setUp() public override {
        super.setUp();
        consumer = new Consumer(oracle);
        vm.deal(address(this), 10 ether);
    }

    function _request() internal returns (uint256) {
        return consumer.request{value: FEE}();
    }

    // ---- constructor

    function test_constructor_rejectsInfinityKey() public {
        uint256[4] memory zero;
        vm.expectRevert(RandomnessOracle.BadPublicKey.selector);
        new RandomnessOracle(zero, OPERATOR, FEE, 1, new uint256[4][](0));
    }

    function test_constructor_rejectsKeyNotOnCurve() public {
        uint256[4] memory bad = pk;
        bad[0] += 1;
        vm.expectRevert(RandomnessOracle.BadPublicKey.selector);
        new RandomnessOracle(bad, OPERATOR, FEE, 1, new uint256[4][](0));
    }

    function test_constructor_rejectsZeroOperator() public {
        vm.expectRevert(RandomnessOracle.BadOperator.selector);
        new RandomnessOracle(pk, payable(address(0)), FEE, 1, new uint256[4][](0));
    }

    // --- key shares fixed at deployment ---

    function _shares(string memory name, uint256 n) internal view returns (uint256[4][] memory keys) {
        keys = new uint256[4][](n);
        for (uint256 i; i < n; i++) {
            for (uint256 w; w < 4; w++) {
                keys[i][w] = vm.parseJsonUint(json, string.concat(".shares.", name, "[", vm.toString(i), "][", vm.toString(w), "]"));
            }
        }
    }

    function test_shares_singleSignerIsDeclaredAsSuch() public view {
        assertEq(oracle.threshold(), 1);
        assertEq(oracle.shareCount(), 0);
    }

    function test_shares_aRealSplitIsStoredAndAnnounced() public {
        uint256[4][] memory keys = _shares("twoOfThree", 3);
        vm.expectEmit();
        emit RandomnessOracle.KeyShares(2, keys);
        RandomnessOracle split = new RandomnessOracle(pk, OPERATOR, FEE, 2, keys);
        assertEq(split.threshold(), 2);
        assertEq(split.shareCount(), 3);
        for (uint256 i; i < 3; i++) {
            assertEq(keccak256(abi.encode(split.shareKey(i + 1))), keccak256(abi.encode(keys[i])));
        }
        vm.expectRevert();
        split.shareKey(4);

        RandomnessOracle wider = new RandomnessOracle(pk, OPERATOR, FEE, 3, _shares("threeOfFive", 5));
        assertEq(wider.shareCount(), 5);
    }

    function test_shares_ofAnotherKeyAreRefused() public {
        uint256[4][] memory keys = _shares("ofAnotherKey", 3);
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 2, keys);
    }

    function test_shares_aWrongThresholdIsRefused() public {
        uint256[4][] memory two = _shares("twoOfThree", 3);
        uint256[4][] memory three = _shares("threeOfFive", 5);
        // Shares of a 2-of-3 split must not pass for 3-of-3: two of them already sign. Nor 3-of-5 shares for 2-of-5.
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 3, two);
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 2, three);
        // One share that "signs alone" is a single signer, and must be declared as one.
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 1, two);
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 4, two);
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 2, new uint256[4][](0));
    }

    function test_shares_theKeyItselfADuplicateOrAWrongOrderIsRefused() public {
        uint256[4][] memory keys = _shares("twoOfThree", 3);

        uint256[4][] memory withKey = _shares("twoOfThree", 3);
        withKey[2] = pk;
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 2, withKey);

        uint256[4][] memory duplicate = _shares("twoOfThree", 3);
        duplicate[2] = duplicate[1];
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 2, duplicate);

        uint256[4][] memory swapped = _shares("twoOfThree", 3);
        (swapped[0], swapped[1]) = (keys[1], keys[0]);
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 2, swapped);

        uint256[4][] memory offCurve = _shares("twoOfThree", 3);
        offCurve[0][0] += 1;
        vm.expectRevert(RandomnessOracle.BadShares.selector);
        new RandomnessOracle(pk, OPERATOR, FEE, 2, offCurve);
    }

    function test_shares_aSplitOracleStillAnswersWithTheSameSignature() public {
        RandomnessOracle split = new RandomnessOracle(pk, OPERATOR, FEE, 2, _shares("twoOfThree", 3));
        Consumer c = new Consumer(split);
        uint256 id = c.request{value: FEE}();
        (, uint64 requestBlock,) = split.requests(id);
        vm.setBlockhash(requestBlock, keccak256("block"));
        vm.roll(requestBlock + 1);
        split.fulfill(id, _signWith(sk, split.messageOf(id)));
        assertEq(uint8(split.statusOf(id)), uint8(RandomnessOracle.Status.Fulfilled));
    }

    function test_publicKey_isReadable() public view {
        uint256[4] memory read = oracle.publicKey();
        for (uint256 i; i < 4; i++) assertEq(read[i], pk[i]);
    }

    // ---- request

    function test_request_rejectsWrongFee() public {
        vm.expectRevert(RandomnessOracle.WrongFee.selector);
        consumer.request{value: FEE - 1}();
        vm.expectRevert(RandomnessOracle.WrongFee.selector);
        consumer.request{value: FEE + 1}();
    }

    function test_request_recordsAndEmits() public {
        vm.expectEmit(true, true, false, false);
        emit RandomnessRequested(1, address(consumer));
        uint256 id = _request();

        assertEq(id, 1);
        assertEq(_request(), 2);
        (address who, uint64 requestBlock, RandomnessOracle.Status status) = oracle.requests(id);
        assertEq(who, address(consumer));
        assertEq(requestBlock, block.number);
        assertEq(uint8(status), uint8(RandomnessOracle.Status.Pending));
    }

    // ---- fulfil

    function test_fulfill_recordsAndCallsBack() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        uint256 expected = uint256(keccak256(abi.encode(sig)));

        vm.expectEmit(true, false, false, true);
        emit RandomnessFulfilled(id, expected, true);
        oracle.fulfill(id, sig);

        assertEq(oracle.randomnessOf(id), expected);
        assertEq(consumer.lastId(), id);
        assertEq(consumer.lastValue(), expected);
        assertEq(consumer.calls(), 1);
        assertEq(oracle.earned(), FEE);
    }

    function test_fulfill_messageBindsAllFields() public {
        uint256 id = _request();
        _age(id, 1);
        (, uint64 requestBlock,) = oracle.requests(id);
        assertEq(
            oracle.messageOf(id),
            keccak256(abi.encode(block.chainid, address(oracle), id, address(consumer), blockhash(requestBlock)))
        );
    }

    function test_fulfill_inSameBlockReverts() public {
        uint256 id = _request();
        vm.expectRevert(RandomnessOracle.OutsideWindow.selector);
        oracle.fulfill(id, [uint256(1), uint256(2)]);
    }

    function test_fulfill_atLastBlockOfWindowWorks() public {
        uint256 id = _request();
        _age(id, 256);
        oracle.fulfill(id, _signed(id));
        assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Fulfilled));
    }

    function test_fulfill_afterWindowReverts() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        _age(id, 257);
        vm.expectRevert(RandomnessOracle.OutsideWindow.selector);
        oracle.fulfill(id, sig);
    }

    function test_fulfill_rejectsSignatureForAnotherRequest() public {
        uint256 a = _request();
        uint256 b = _request();
        _age(a, 1);
        uint256[2] memory sig = _signed(a);
        vm.expectRevert(RandomnessOracle.BadSignature.selector);
        oracle.fulfill(b, sig);
    }

    function test_fulfill_rejectsAnotherKey() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signWith(sk + 1, oracle.messageOf(id));
        vm.expectRevert(RandomnessOracle.BadSignature.selector);
        oracle.fulfill(id, sig);
    }

    function test_fulfill_signatureDependsOnRequestBlockHash() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        (, uint64 requestBlock,) = oracle.requests(id);
        vm.setBlockhash(requestBlock, keccak256("reorged"));
        vm.expectRevert(RandomnessOracle.BadSignature.selector);
        oracle.fulfill(id, sig);
    }

    function test_fulfill_replayReverts() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        oracle.fulfill(id, sig);
        vm.expectRevert(RandomnessOracle.NotPending.selector);
        oracle.fulfill(id, sig);
        assertEq(oracle.earned(), FEE);
    }

    function test_fulfill_unknownRequestReverts() public {
        vm.expectRevert(RandomnessOracle.NotPending.selector);
        oracle.fulfill(99, [uint256(1), uint256(2)]);
    }

    function test_fulfill_isPermissionless() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        vm.prank(address(0xbeef));
        oracle.fulfill(id, sig);
        assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Fulfilled));
    }

    function test_randomnessOf_revertsUntilFulfilled() public {
        uint256 id = _request();
        vm.expectRevert(RandomnessOracle.NotFulfilled.selector);
        oracle.randomnessOf(id);
    }

    // ---- hostile consumers

    function _fulfillHostile(Consumer c) internal returns (uint256 id) {
        id = c.request{value: FEE}();
        _age(id, 1);
        oracle.fulfill(id, _signed(id));
        assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Fulfilled));
    }

    function test_revertingCallback_stillRecords() public {
        Consumer c = new RevertingConsumer(oracle);
        uint256 id = c.request{value: FEE}();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        vm.expectEmit(true, false, false, true);
        emit RandomnessFulfilled(id, uint256(keccak256(abi.encode(sig))), false);
        oracle.fulfill(id, sig);
    }

    function test_gasBurningCallback_stillRecords() public {
        _fulfillHostile(new GasBurner(oracle));
    }

    function _gasToFulfil(Consumer c) internal returns (uint256 used) {
        uint256 id = c.request{value: FEE}();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        uint256 before = gasleft();
        oracle.fulfill(id, sig);
        used = before - gasleft();
    }

    function test_returnBomb_doesNotCostTheFulfiller() public {
        uint256 baseline = _gasToFulfil(new RevertingConsumer(oracle));
        uint256 bomb = _gasToFulfil(new ReturnBomb(oracle));
        assertGt(bomb, baseline + 100_000, "the bomb must really spend gas in the callee");
        assertLt(bomb, baseline + oracle.CALLBACK_GAS() + 5_000, "return data must not be copied");
    }

    function test_reentrantCallback_seesFinalStateAndCannotFulfilTwice() public {
        Reenterer c = new Reenterer(oracle);
        uint256 id = c.request{value: FEE}();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        c.setSig(sig);
        vm.expectEmit(true, false, false, true);
        emit RandomnessFulfilled(id, uint256(keccak256(abi.encode(sig))), true);
        oracle.fulfill(id, sig);

        assertEq(uint8(c.statusSeen()), uint8(RandomnessOracle.Status.Fulfilled));
        assertEq(c.resultSeen(), uint256(keccak256(abi.encode(sig))));
        assertEq(bytes4(c.innerError()), RandomnessOracle.NotPending.selector);
        assertEq(c.calls(), 1);
        assertEq(oracle.earned(), FEE);
    }

    // ---- gas griefing: a submitter must not be able to make a callback fail by sending too little gas.

    function _succeedsWith(uint256 g, uint256 id, uint256[2] memory sig) internal returns (bool ok, uint256 seen) {
        uint256 snap = vm.snapshotState();
        (ok,) = address(oracle).call{gas: g}(abi.encodeCall(oracle.fulfill, (id, sig)));
        seen = consumer.gasSeen();
        vm.revertToState(snap);
    }

    function test_gas_everySuccessGivesTheCallbackItsFullAllowance() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        uint256 allowance = oracle.CALLBACK_GAS();

        // Binary search for the smallest gas that succeeds, then check every value just above it.
        uint256 low = 100_000;
        uint256 high = 1_000_000;
        (bool lowOk,) = _succeedsWith(low, id, sig);
        (bool highOk,) = _succeedsWith(high, id, sig);
        assertFalse(lowOk);
        assertTrue(highOk);
        while (high - low > 1) {
            uint256 mid = (low + high) / 2;
            (bool ok,) = _succeedsWith(mid, id, sig);
            if (ok) high = mid;
            else low = mid;
        }
        for (uint256 g = high; g < high + 6_000; g += 37) {
            (bool ok, uint256 seen) = _succeedsWith(g, id, sig);
            assertTrue(ok);
            assertGe(seen + 500, allowance, "callback was short of gas");
        }
    }

    function test_gas_aBurningCallbackNeverRollsBackASuccess() public {
        Consumer c = new GasBurner(oracle);
        uint256 id = c.request{value: FEE}();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);

        uint256 successes;
        for (uint256 g = 150_000; g < 700_000; g += 1_111) {
            uint256 snap = vm.snapshotState();
            try oracle.fulfill{gas: g}(id, sig) {
                successes++;
                assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Fulfilled));
                assertEq(oracle.earned(), FEE);
            } catch {
                assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Pending));
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
    }

    function test_gas_tooLittleRevertsWithAClearError() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        // Enough for the signature check, not for the callback allowance.
        (bool ok, bytes memory out) = address(oracle).call{gas: 300_000}(abi.encodeCall(oracle.fulfill, (id, sig)));
        assertFalse(ok);
        assertEq(bytes4(out), RandomnessOracle.NotEnoughGas.selector);
    }

    // ---- expiry and refunds

    function test_expire_tooEarlyReverts() public {
        uint256 id = _request();
        _age(id, 256);
        vm.expectRevert(RandomnessOracle.OutsideWindow.selector);
        oracle.expire(id);
    }

    function test_expire_creditsConsumerAndBlocksFulfil() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        _age(id, 257);
        oracle.expire(id);

        assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Expired));
        assertEq(oracle.refunds(address(consumer)), FEE);
        assertEq(oracle.earned(), 0);
        vm.expectRevert(RandomnessOracle.NotPending.selector);
        oracle.fulfill(id, sig);
        vm.expectRevert(RandomnessOracle.NotPending.selector);
        oracle.expire(id);
    }

    function test_expire_worksForConsumerThatCannotReceive() public {
        // Consumer has no receive function; expiry must not depend on it.
        uint256 id = _request();
        _age(id, 257);
        oracle.expire(id);
        assertEq(oracle.refunds(address(consumer)), FEE);
    }

    function test_withdrawRefund_paysChosenRecipientOnce() public {
        uint256 id = _request();
        _age(id, 257);
        oracle.expire(id);

        address payable to = payable(address(0xabc));
        consumer.withdrawRefund(to, FEE);
        assertEq(to.balance, FEE);
        assertEq(oracle.refunds(address(consumer)), 0);

        vm.expectRevert(RandomnessOracle.NothingToWithdraw.selector);
        consumer.withdrawRefund(to, 1);
    }

    function test_withdrawRefund_failedTransferReverts() public {
        uint256 id = _request();
        _age(id, 257);
        oracle.expire(id);
        vm.expectRevert(RandomnessOracle.TransferFailed.selector);
        consumer.withdrawRefund(payable(address(consumer)), FEE);
        assertEq(oracle.refunds(address(consumer)), FEE);
    }

    // ---- operator fees

    function test_withdraw_paysOnlyEarnedFees() public {
        uint256 done = _request();
        _request();
        _age(done, 1);
        oracle.fulfill(done, _signed(done));

        oracle.withdraw();
        assertEq(OPERATOR.balance, FEE);
        assertEq(oracle.earned(), 0);
        assertEq(address(oracle).balance, FEE, "pending fee stays");

        vm.expectRevert(RandomnessOracle.NothingToWithdraw.selector);
        oracle.withdraw();
    }

    function test_funds_areConserved() public {
        uint256 a = _request();
        uint256 b = _request();
        uint256 c = _request();
        _age(a, 1);
        oracle.fulfill(a, _signed(a));
        _age(b, 257);
        oracle.expire(b);

        assertEq(address(oracle).balance, oracle.earned() + oracle.refunds(address(consumer)) + FEE);
        assertEq(uint8(oracle.statusOf(c)), uint8(RandomnessOracle.Status.Pending));
    }
}

contract AuditSamplerTest is OracleTestBase {
    AuditSampler internal sampler;
    address internal constant AUDITOR = address(0xA0D1);
    address internal constant TREASURER = address(0x1234);
    address internal constant STRANGER = address(0x5678);
    bytes32 internal constant LIST = keccak256("receipts.csv");
    uint256 internal lists;

    function setUp() public override {
        super.setUp();
        sampler = new AuditSampler(oracle);
        vm.deal(TREASURER, 1 ether);
        vm.deal(STRANGER, 1 ether);
    }

    function _announce(bytes32 list, uint32 items, uint16 sample) internal {
        vm.prank(AUDITOR);
        sampler.announce(list, items, sample, TREASURER);
    }

    function _request(bytes32 list) internal returns (uint256) {
        vm.prank(TREASURER);
        return sampler.requestAudit{value: FEE}(list, AUDITOR, "Class fund, Q3");
    }

    /// A new list each time: one announcement gives one draw.
    function _audit(uint32 items, uint16 sample) internal returns (uint256) {
        bytes32 list = keccak256(abi.encode("list", lists++));
        _announce(list, items, sample);
        return _request(list);
    }

    function _audit() internal returns (uint256) {
        _announce(LIST, 40, 3);
        return _request(LIST);
    }

    function _answer(uint256 id) internal {
        _age(id, 1);
        oracle.fulfill(id, _signed(id));
    }

    function _expectAlreadyAudited(uint256 id) internal {
        vm.prank(TREASURER);
        vm.expectRevert(abi.encodeWithSelector(AuditSampler.AlreadyAudited.selector, id));
        sampler.requestAudit{value: FEE}(LIST, AUDITOR, "again");
    }

    // --- the auditor's announcement ---

    function test_announce_storesWhatWillBeAuditedAndWhoMayAsk() public {
        vm.expectEmit(address(sampler));
        emit AuditSampler.ListAnnounced(AUDITOR, LIST, TREASURER, keccak256(abi.encode(LIST, uint32(40))), 40, 3);
        _announce(LIST, 40, 3);
        (address requester, uint32 items, uint16 sample) = sampler.announcements(AUDITOR, LIST);
        assertEq(requester, TREASURER);
        assertEq(items, 40);
        assertEq(sample, 3);
        assertEq(sampler.announcedBy(AUDITOR), 1);
    }

    function test_announce_cannotBeChangedOrRepeated() public {
        _announce(LIST, 40, 3);
        vm.startPrank(AUDITOR);
        vm.expectRevert(AuditSampler.AlreadyAnnounced.selector);
        sampler.announce(LIST, 40, 3, TREASURER);
        vm.expectRevert(AuditSampler.AlreadyAnnounced.selector);
        sampler.announce(LIST, 45, 5, STRANGER);
        vm.stopPrank();
        assertEq(sampler.announcedBy(AUDITOR), 1);
    }

    function test_announce_rejectsBadSizesAndNoRequester() public {
        vm.startPrank(AUDITOR);
        vm.expectRevert(AuditSampler.BadSample.selector);
        sampler.announce(LIST, 40, 0, TREASURER);
        vm.expectRevert(AuditSampler.BadSample.selector);
        sampler.announce(LIST, 2, 3, TREASURER);
        vm.expectRevert(AuditSampler.BadSample.selector);
        sampler.announce(LIST, 100, 33, TREASURER);
        vm.expectRevert(AuditSampler.BadSample.selector);
        sampler.announce(LIST, 1_000_001, 3, TREASURER);
        vm.expectRevert(AuditSampler.BadRequester.selector);
        sampler.announce(LIST, 40, 3, address(0));
        vm.stopPrank();
        assertEq(sampler.announcedBy(AUDITOR), 0);
    }

    // --- the request ---

    function test_requestTakesCountAndSampleFromTheAnnouncementAndPaysTheOracle() public {
        uint256 id = _audit();
        AuditSampler.Audit memory a = sampler.audits(id);
        assertEq(a.requester, TREASURER);
        assertEq(a.itemCount, 40);
        assertEq(a.sampleSize, 3);
        assertEq(a.draw, 1);
        assertFalse(a.settled);
        assertFalse(a.refunded);
        assertEq(a.auditor, AUDITOR);
        assertFalse(a.reported);
        assertEq(a.fileHash, LIST);
        assertEq(a.label, "Class fund, Q3");
        bytes32 key = sampler.listKey(AUDITOR, LIST);
        assertEq(sampler.auditOfList(key), id);
        assertEq(sampler.drawsOfList(key), 1);
        assertEq(sampler.drawsOfFile(LIST), 1);
        assertEq(sampler.auditsBy(TREASURER), 1);
        assertEq(address(oracle).balance, FEE);
        assertEq(address(sampler).balance, 0);
    }

    function test_request_emits() public {
        _announce(LIST, 40, 3);
        vm.expectEmit(address(sampler));
        emit AuditSampler.AuditRequested(1, TREASURER, LIST, AUDITOR, 1);
        _request(LIST);
    }

    // Squatting: someone who knows the hash tries to use up the list's draw.

    function test_squat_aStrangerCannotDrawTheAnnouncedList() public {
        _announce(LIST, 40, 3);
        vm.prank(STRANGER);
        vm.expectRevert(AuditSampler.NotAnnounced.selector);
        sampler.requestAudit{value: FEE}(LIST, AUDITOR, "mine now");
        assertEq(STRANGER.balance, 1 ether, "a refused request must not take the fee");
        assertEq(sampler.drawsOfFile(LIST), 0);
    }

    function test_squat_aStrangersOwnAnnouncementDoesNotTouchTheAuditorsDraw() public {
        _announce(LIST, 40, 3);
        // The stranger plays auditor for the same bytes, with a sample of 1, and draws.
        vm.startPrank(STRANGER);
        sampler.announce(LIST, 40, 1, STRANGER);
        uint256 theirs = sampler.requestAudit{value: FEE}(LIST, STRANGER, "squat");
        vm.stopPrank();
        _answer(theirs);

        // The auditor's announcement still has its one draw, with the auditor's count and sample size.
        uint256 id = _request(LIST);
        _answer(id);
        AuditSampler.Audit memory a = sampler.audits(id);
        assertEq(a.sampleSize, 3);
        assertEq(a.draw, 1);
        assertEq(a.auditor, AUDITOR);
        assertEq(sampler.drawsOfList(sampler.listKey(AUDITOR, LIST)), 1);
        // That the same bytes were drawn elsewhere stays visible.
        assertEq(sampler.drawsOfFile(LIST), 2);
    }

    // Variant grinding: the treasurer tries lists the auditor did not announce.

    function test_variant_anEditedOrReorderedListHasNoAnnouncementAndNoDraw() public {
        _announce(LIST, 40, 3);
        bytes32 variant = keccak256("receipts-reordered.csv");
        vm.prank(TREASURER);
        vm.expectRevert(AuditSampler.NotAnnounced.selector);
        sampler.requestAudit{value: FEE}(variant, AUDITOR, "Class fund, Q3");
    }

    function test_variant_aFreshWalletCannotUseTheTreasurersAnnouncement() public {
        _announce(LIST, 40, 3);
        uint256 id = _request(LIST);
        _answer(id);
        vm.prank(STRANGER);
        vm.expectRevert(AuditSampler.NotAnnounced.selector);
        sampler.requestAudit{value: FEE}(LIST, AUDITOR, "Class fund, Q3");
    }

    function test_variant_namingAnAuditorWhoAnnouncedNothingReverts() public {
        vm.prank(TREASURER);
        vm.expectRevert(AuditSampler.NotAnnounced.selector);
        sampler.requestAudit{value: FEE}(LIST, AUDITOR, "");
    }

    function test_selfAnnounced_isAllowedAndRecordedAsSuch() public {
        vm.startPrank(TREASURER);
        sampler.announce(LIST, 40, 3, TREASURER);
        uint256 id = sampler.requestAudit{value: FEE}(LIST, TREASURER, "no auditor");
        vm.stopPrank();
        AuditSampler.Audit memory a = sampler.audits(id);
        assertEq(a.auditor, a.requester, "the page flags an audit whose auditor is its requester");
    }

    // The re-draw hole: a treasurer who dislikes a sample asks again for the same list.

    function test_redraw_sameListRevertsWhileWaiting() public {
        uint256 id = _audit();
        _expectAlreadyAudited(id);
    }

    function test_redraw_sameListRevertsAfterThePick() public {
        uint256 id = _audit();
        _answer(id);
        _expectAlreadyAudited(id);
        assertEq(TREASURER.balance, 1 ether - FEE, "a refused request must not take the fee");
    }

    function test_redraw_whenTheCallbackFailedTheListStaysTaken() public {
        uint256 id = _audit();
        _age(id, 1);
        vm.mockCallRevert(address(sampler), abi.encodeWithSelector(sampler.onRandomness.selector), "paused");
        oracle.fulfill(id, _signed(id));
        vm.clearMockedCalls();
        _expectAlreadyAudited(id);
    }

    function test_redraw_onlyAfterARefundAndItIsNumbered() public {
        uint256 first = _audit();
        _age(first, 257);
        // Expired on the oracle, but not refunded yet: still taken.
        oracle.expire(first);
        _expectAlreadyAudited(first);

        sampler.refund(first);
        uint256 second = _request(LIST);
        bytes32 key = sampler.listKey(AUDITOR, LIST);
        assertEq(sampler.audits(second).draw, 2);
        assertEq(sampler.drawsOfList(key), 2);
        assertEq(sampler.auditOfList(key), second);
        assertEq(sampler.auditsBy(TREASURER), 2);

        _answer(second);
        _expectAlreadyAudited(second);
    }

    // The receipt count is part of what is announced and committed.

    function test_commitment_coversTheFileAndTheCount() public {
        uint256 id = _audit();
        assertEq(sampler.commitmentOf(id), keccak256(abi.encode(LIST, uint32(40))));
        assertEq(sampler.commitmentOf(id), sampler.commitment(LIST, 40));
        assertTrue(sampler.commitment(LIST, 40) != sampler.commitment(LIST, 45), "another count is another commitment");
        assertTrue(sampler.commitment(LIST, 40) != sampler.commitment(keccak256("edited.csv"), 40));
    }

    // --- the auditor's report ---

    function test_report_onlyTheAuditorOnceAfterThePick() public {
        uint256 id = _audit();
        vm.prank(AUDITOR);
        vm.expectRevert(AuditSampler.NotSettled.selector);
        sampler.report(id, 0);
        _answer(id);

        vm.prank(TREASURER);
        vm.expectRevert(AuditSampler.NotAuditor.selector);
        sampler.report(id, 0);
        vm.prank(AUDITOR);
        vm.expectRevert(AuditSampler.BadReport.selector);
        sampler.report(id, 8); // bit 3, but only 3 receipts were picked

        vm.expectEmit(address(sampler));
        emit AuditSampler.AuditReported(id, AUDITOR, 2);
        vm.prank(AUDITOR);
        sampler.report(id, 2); // the second picked receipt was not found
        assertTrue(sampler.audits(id).reported);
        assertEq(sampler.audits(id).missing, 2);

        vm.prank(AUDITOR);
        vm.expectRevert(AuditSampler.AlreadyReported.selector);
        sampler.report(id, 0);
    }

    function test_report_unknownAuditReverts() public {
        vm.prank(AUDITOR);
        vm.expectRevert(AuditSampler.NotAuditor.selector);
        sampler.report(99, 0);
    }

    // --- the pick ---

    function test_callbackFixesADistinctInRangeSample() public {
        for (uint256 n; n < 10; n++) {
            uint256 id = _audit(12, 5);
            _answer(id);
            assertTrue(sampler.audits(id).settled);
            assertEq(sampler.audits(id).seed, oracle.randomnessOf(id));
            uint32[] memory picks = sampler.sampleOf(id);
            assertEq(picks.length, 5);
            for (uint256 i; i < picks.length; i++) {
                assertGe(picks[i], 1);
                assertLe(picks[i], 12);
                for (uint256 j; j < i; j++) assertTrue(picks[i] != picks[j], "repeat");
            }
        }
    }

    function test_sampleIsAPureFunctionOfTheSeed() public {
        uint256 id = _audit();
        _answer(id);
        uint32[] memory a = sampler.sampleOf(id);
        uint32[] memory b = sampler.pick(oracle.randomnessOf(id), 40, 3);
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)));
    }

    function test_fullSampleIsAPermutation() public view {
        uint32[] memory picks = sampler.pick(uint256(keccak256("seed")), 8, 8);
        uint256 seen;
        for (uint256 i; i < 8; i++) seen |= 1 << picks[i];
        assertEq(seen, 0x1fe);
    }

    function testFuzz_pickStaysInRange(uint256 seed, uint32 items, uint16 sample) public view {
        items = uint32(bound(items, 1, 1_000_000));
        sample = uint16(bound(sample, 1, items < 32 ? items : 32));
        uint32[] memory picks = sampler.pick(seed, items, sample);
        for (uint256 i; i < picks.length; i++) {
            assertGe(picks[i], 1);
            assertLe(picks[i], items);
        }
    }

    function test_labelTooLongAndWrongFeeLeaveTheAnnouncementUnused() public {
        _announce(LIST, 40, 3);
        vm.startPrank(TREASURER);
        vm.expectRevert(AuditSampler.LabelTooLong.selector);
        sampler.requestAudit{value: FEE}(LIST, AUDITOR, "0123456789012345678901234567890123456789012345678901234567890123x");
        vm.expectRevert(RandomnessOracle.WrongFee.selector);
        sampler.requestAudit{value: FEE - 1}(LIST, AUDITOR, "");
        vm.stopPrank();
        assertEq(sampler.drawsOfFile(LIST), 0);
        assertEq(sampler.auditOfList(sampler.listKey(AUDITOR, LIST)), 0);
    }

    function test_sampleOfRevertsBeforeTheAnswer() public {
        uint256 id = _audit();
        vm.expectRevert(AuditSampler.NotSettled.selector);
        sampler.sampleOf(id);
    }

    function test_onlyOracleCanCallBack() public {
        uint256 id = _audit();
        vm.expectRevert(AuditSampler.NotOracle.selector);
        sampler.onRandomness(id, 5);
    }

    function test_settle_recoversWhenTheCallbackFailed() public {
        uint256 id = _audit();
        _age(id, 1);
        vm.mockCallRevert(address(sampler), abi.encodeWithSelector(sampler.onRandomness.selector), "paused");
        oracle.fulfill(id, _signed(id));
        vm.clearMockedCalls();

        assertFalse(sampler.audits(id).settled);

        vm.prank(address(0xbeef));
        sampler.settle(id);
        assertTrue(sampler.audits(id).settled);
        assertEq(sampler.audits(id).seed, oracle.randomnessOf(id));
    }

    function test_settle_isIdempotent() public {
        uint256 id = _audit();
        _answer(id);
        vm.recordLogs();
        sampler.settle(id);
        assertEq(vm.getRecordedLogs().length, 0, "already settled");
    }

    function test_settle_revertsBeforeFulfilment() public {
        uint256 id = _audit();
        vm.expectRevert(RandomnessOracle.NotFulfilled.selector);
        sampler.settle(id);
    }

    function test_refund_afterExpiryPaysTheRequesterOnce() public {
        uint256 id = _audit();
        uint256 before = TREASURER.balance;
        _age(id, 257);
        vm.prank(address(0xbeef));
        sampler.refund(id);
        assertEq(TREASURER.balance, before + FEE);
        assertEq(address(oracle).balance, 0);

        vm.expectRevert(AuditSampler.NotRefundable.selector);
        sampler.refund(id);
    }

    function test_refund_beforeExpiryReverts() public {
        uint256 id = _audit();
        _age(id, 256);
        vm.expectRevert(RandomnessOracle.OutsideWindow.selector);
        sampler.refund(id);
    }

    function test_refund_afterFulfilmentReverts() public {
        uint256 id = _audit();
        _answer(id);
        vm.expectRevert(AuditSampler.NotRefundable.selector);
        sampler.refund(id);
    }

    function test_refund_unknownAuditReverts() public {
        vm.expectRevert(AuditSampler.NotRefundable.selector);
        sampler.refund(99);
    }

    function test_expiredAuditNeverGetsASample() public {
        uint256 id = _audit();
        _age(id, 257);
        sampler.refund(id);
        vm.expectRevert(AuditSampler.NotSettled.selector);
        sampler.sampleOf(id);
    }

    function test_callbackFitsTheGasAllowance() public {
        uint256 id = _audit(1_000_000, 32);
        _answer(id);
        assertTrue(sampler.audits(id).settled, "callback ran out of gas");
    }
}

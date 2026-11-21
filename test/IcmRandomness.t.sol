// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {OracleTestBase} from "./RandomnessOracle.t.sol";
import {RandomnessOracle} from "../src/RandomnessOracle.sol";
import {AuditSampler} from "../src/AuditSampler.sol";
import {IcmRandomnessAdapter} from "../src/icm/IcmRandomnessAdapter.sol";
import {L1AuditSampler} from "../src/icm/L1AuditSampler.sol";
import {ITeleporterMessenger, ITeleporterReceiver, TeleporterMessageInput} from "../src/icm/ITeleporter.sol";

/// A stand-in for TeleporterMessenger on one chain: records what is sent, and delivers what the test hands it.
contract MockMessenger {
    struct Sent {
        address sender;
        bytes32 destinationBlockchainID;
        address destinationAddress;
        uint256 requiredGasLimit;
        address feeToken;
        uint256 feeAmount;
        bytes message;
    }

    bytes32 public immutable blockchainID;
    Sent[] public sent;

    constructor(bytes32 blockchainID_) {
        blockchainID = blockchainID_;
    }

    function sendCrossChainMessage(TeleporterMessageInput calldata input) external returns (bytes32) {
        sent.push(
            Sent(
                msg.sender,
                input.destinationBlockchainID,
                input.destinationAddress,
                input.requiredGasLimit,
                input.feeInfo.feeTokenAddress,
                input.feeInfo.amount,
                input.message
            )
        );
        return keccak256(abi.encode(blockchainID, sent.length));
    }

    function sentCount() external view returns (uint256) {
        return sent.length;
    }

    function message(uint256 i) external view returns (bytes memory) {
        return sent[i].message;
    }

    /// Delivers message `i` of `from` here, the way the relayer and this chain's messenger would.
    function deliver(MockMessenger from, uint256 i) external {
        (address sender, bytes32 dest, address target, uint256 gasLimit,,, bytes memory m) = from.sent(i);
        require(dest == blockchainID, "wrong chain");
        ITeleporterReceiver(target).receiveTeleporterMessage{gas: gasLimit}(from.blockchainID(), sender, m);
    }

    function deliverRaw(address target, bytes32 source, address sender, bytes calldata m) external {
        ITeleporterReceiver(target).receiveTeleporterMessage(source, sender, m);
    }
}

contract IcmRandomnessTest is OracleTestBase {
    bytes32 internal constant FUJI = keccak256("fuji c-chain");
    bytes32 internal constant L1 = keccak256("fairpick l1");
    address internal constant AUDITOR = address(0xA0D1);
    address internal constant TREASURER = address(0x7EA5);
    bytes32 internal constant FILE = keccak256("receipts.csv");

    MockMessenger internal fujiMessenger;
    MockMessenger internal l1Messenger;
    IcmRandomnessAdapter internal adapter;
    L1AuditSampler internal sampler;

    function setUp() public override {
        super.setUp();
        fujiMessenger = new MockMessenger(FUJI);
        l1Messenger = new MockMessenger(L1);
        adapter = new IcmRandomnessAdapter(oracle, ITeleporterMessenger(address(fujiMessenger)), L1);
        sampler = new L1AuditSampler(ITeleporterMessenger(address(l1Messenger)), FUJI, block.chainid, address(oracle), pk);
        adapter.setRemoteSampler(address(sampler));
        sampler.setAdapter(address(adapter));
        vm.deal(address(adapter), 1 ether);
    }

    /// Announce, request on the L1, carry the request to Fuji. Returns the L1 audit id and the oracle request id.
    function _request(uint32 count, uint16 size) internal returns (uint256 auditId, uint256 requestId) {
        vm.prank(AUDITOR);
        sampler.announce(FILE, count, size, TREASURER);
        vm.prank(TREASURER);
        auditId = sampler.requestAudit(FILE, AUDITOR, "Club fund Q3");
        fujiMessenger.deliver(l1Messenger, l1Messenger.sentCount() - 1);
        requestId = adapter.requestOfRemoteAudit(auditId);
    }

    /// The oracle nodes answer on Fuji; returns the signature they submitted.
    function _answer(uint256 requestId) internal returns (uint256[2] memory sig) {
        _age(requestId, 2);
        sig = _signed(requestId);
        oracle.fulfill(requestId, sig);
    }

    function test_roundTrip_requestOverIcm_answerOverIcm_sampleStoredOnL1() public {
        (uint256 auditId, uint256 requestId) = _request(40, 3);
        assertEq(auditId, 1);
        assertEq(requestId, 1);
        (address consumer,, RandomnessOracle.Status status) = oracle.requests(requestId);
        assertEq(consumer, address(adapter));
        assertEq(uint8(status), uint8(RandomnessOracle.Status.Pending));
        assertEq(address(oracle).balance, FEE, "adapter paid the fee");

        uint256[2] memory sig = _answer(requestId);
        (,,, uint256 randomness, bool answered,) = adapter.pending(requestId);
        assertTrue(answered);
        assertEq(randomness, oracle.randomnessOf(requestId));

        adapter.forward(requestId, sig);
        l1Messenger.deliver(fujiMessenger, fujiMessenger.sentCount() - 1);

        L1AuditSampler.Audit memory a = sampler.audits(auditId);
        assertTrue(a.settled);
        assertEq(a.oracleRequestId, requestId);
        assertEq(a.seed, randomness);
        assertEq(a.signature[0], sig[0]);
        uint32[] memory picks = sampler.sampleOf(auditId);
        assertEq(picks.length, 3);
        // Same rule as the Fuji AuditSampler.
        AuditSampler fujiSampler = new AuditSampler(oracle);
        uint32[] memory expected = fujiSampler.pick(randomness, 40, 3);
        for (uint256 i; i < 3; i++) assertEq(picks[i], expected[i]);
    }

    function test_messagesCarryZeroFeeAndGasLimits() public {
        (uint256 auditId, uint256 requestId) = _request(10, 2);
        (address sender, bytes32 dest, address target, uint256 gasLimit, address token, uint256 amount,) = l1Messenger.sent(0);
        assertEq(sender, address(sampler));
        assertEq(dest, FUJI);
        assertEq(target, address(adapter));
        assertEq(gasLimit, sampler.REQUEST_GAS_LIMIT());
        assertEq(token, address(0));
        assertEq(amount, 0);
        (uint256 sentId,) = abi.decode(l1Messenger.message(0), (uint256, bytes32));
        assertEq(sentId, auditId);

        adapter.forward(requestId, _answer(requestId));
        (sender, dest, target, gasLimit, token, amount,) = fujiMessenger.sent(0);
        assertEq(sender, address(adapter));
        assertEq(dest, L1);
        assertEq(target, address(sampler));
        assertEq(gasLimit, adapter.RETURN_GAS_LIMIT());
        assertEq(amount, 0);
    }

    function test_twoAuditsRoundTrip_differentSamples() public {
        (uint256 a1, uint256 r1) = _request(40, 3);
        uint256[2] memory s1 = _answer(r1);
        vm.prank(AUDITOR);
        sampler.announce(keccak256("other.csv"), 25, 4, TREASURER);
        vm.prank(TREASURER);
        uint256 a2 = sampler.requestAudit(keccak256("other.csv"), AUDITOR, "Charity round 3");
        fujiMessenger.deliver(l1Messenger, 1);
        uint256 r2 = adapter.requestOfRemoteAudit(a2);
        uint256[2] memory s2 = _answer(r2);
        adapter.forward(r2, s2);
        adapter.forward(r1, s1);
        l1Messenger.deliver(fujiMessenger, 0);
        l1Messenger.deliver(fujiMessenger, 1);
        assertEq(sampler.audits(a1).oracleRequestId, r1);
        assertEq(sampler.audits(a2).oracleRequestId, r2);
        assertEq(sampler.sampleOf(a2).length, 4);
    }

    function test_callbackFits_withinOracleAllowance() public {
        (, uint256 requestId) = _request(40, 3);
        _age(requestId, 2);
        uint256[2] memory sig = _signed(requestId);
        vm.recordLogs();
        oracle.fulfill(requestId, sig);
        (,,,, bool answered,) = adapter.pending(requestId);
        assertTrue(answered, "callback succeeded within CALLBACK_GAS");
    }

    function test_adapter_rejectsWrongMessengerSourceOrSender() public {
        bytes memory m = abi.encode(uint256(9), bytes32(0));
        vm.expectRevert(IcmRandomnessAdapter.NotMessenger.selector);
        adapter.receiveTeleporterMessage(L1, address(sampler), m);
        vm.expectRevert(IcmRandomnessAdapter.WrongSource.selector);
        fujiMessenger.deliverRaw(address(adapter), FUJI, address(sampler), m);
        vm.expectRevert(IcmRandomnessAdapter.WrongSource.selector);
        fujiMessenger.deliverRaw(address(adapter), L1, address(0xBAD), m);
    }

    function test_adapter_rejectsSameAuditTwice() public {
        (uint256 auditId,) = _request(40, 3);
        vm.expectRevert(IcmRandomnessAdapter.AlreadyRequested.selector);
        fujiMessenger.deliverRaw(address(adapter), L1, address(sampler), abi.encode(auditId, bytes32(0)));
    }

    function test_adapter_withoutBalance_requestFailsAndCanBeRetried() public {
        vm.prank(address(this));
        adapter.withdraw(payable(address(0xD00D)), 1 ether);
        vm.prank(AUDITOR);
        sampler.announce(FILE, 40, 3, TREASURER);
        vm.prank(TREASURER);
        sampler.requestAudit(FILE, AUDITOR, "x");
        vm.expectRevert();
        fujiMessenger.deliver(l1Messenger, 0);
        vm.deal(address(adapter), FEE);
        fujiMessenger.deliver(l1Messenger, 0);
        assertEq(adapter.requestOfRemoteAudit(1), 1);
    }

    function test_forward_rejectsASignatureThatIsNotTheAnswer() public {
        (, uint256 requestId) = _request(40, 3);
        uint256[2] memory sig = _answer(requestId);
        uint256[2] memory other = _signWith(sk, keccak256("something else"));
        vm.expectRevert(IcmRandomnessAdapter.WrongSignature.selector);
        adapter.forward(requestId, other);
        adapter.forward(requestId, sig);
        vm.expectRevert(IcmRandomnessAdapter.AlreadyForwarded.selector);
        adapter.forward(requestId, sig);
    }

    function test_forward_beforeAnswer_reverts() public {
        (, uint256 requestId) = _request(40, 3);
        uint256[2] memory sig;
        vm.expectRevert(RandomnessOracle.NotFulfilled.selector);
        adapter.forward(requestId, sig);
        vm.expectRevert(IcmRandomnessAdapter.NotAnswered.selector);
        adapter.forward(99, sig);
    }

    function test_onRandomness_onlyOracle() public {
        vm.expectRevert(IcmRandomnessAdapter.NotOracle.selector);
        adapter.onRandomness(1, 1);
    }

    function test_remotes_setOnceByDeployer() public {
        vm.expectRevert(IcmRandomnessAdapter.RemoteAlreadySet.selector);
        adapter.setRemoteSampler(address(1));
        vm.expectRevert(L1AuditSampler.AdapterAlreadySet.selector);
        sampler.setAdapter(address(1));
        IcmRandomnessAdapter fresh = new IcmRandomnessAdapter(oracle, ITeleporterMessenger(address(fujiMessenger)), L1);
        vm.prank(address(0xBAD));
        vm.expectRevert(IcmRandomnessAdapter.NotOwner.selector);
        fresh.setRemoteSampler(address(1));
    }

    function test_reclaim_takesTheFeeBackAfterExpiry() public {
        (, uint256 requestId) = _request(40, 3);
        uint256 before = address(adapter).balance;
        vm.roll(block.number + 300);
        adapter.reclaim(requestId);
        assertEq(address(adapter).balance, before + FEE);
    }

    function test_l1_rejectsWrongMessengerSourceOrSender() public {
        (uint256 auditId, uint256 requestId) = _request(40, 3);
        uint256[2] memory sig = _answer(requestId);
        adapter.forward(requestId, sig);
        bytes memory m = fujiMessenger.message(0);
        vm.expectRevert(L1AuditSampler.NotMessenger.selector);
        sampler.receiveTeleporterMessage(FUJI, address(adapter), m);
        vm.expectRevert(L1AuditSampler.WrongSource.selector);
        l1Messenger.deliverRaw(address(sampler), L1, address(adapter), m);
        vm.expectRevert(L1AuditSampler.WrongSource.selector);
        l1Messenger.deliverRaw(address(sampler), FUJI, address(0xBAD), m);
        assertFalse(sampler.audits(auditId).settled);
    }

    function test_l1_checksTheSignatureItself() public {
        (uint256 auditId, uint256 requestId) = _request(40, 3);
        (, uint64 requestBlock,) = oracle.requests(requestId);
        _answer(requestId);
        bytes32 blockHash = blockhash(requestBlock);
        // A signature by another key, even if the adapter's allowlisted address sent it.
        uint256[2] memory forged = _signWith(sk + 1, sampler.oracleMessage(requestId, blockHash));
        vm.expectRevert(L1AuditSampler.BadSignature.selector);
        l1Messenger.deliverRaw(address(sampler), FUJI, address(adapter), abi.encode(auditId, requestId, blockHash, forged));
        // The right key but a different block hash: not the message the nodes signed.
        uint256[2] memory sig = _signed(requestId);
        vm.expectRevert(L1AuditSampler.BadSignature.selector);
        l1Messenger.deliverRaw(address(sampler), FUJI, address(adapter), abi.encode(auditId, requestId, bytes32(uint256(1)), sig));
        // The real one passes.
        l1Messenger.deliverRaw(address(sampler), FUJI, address(adapter), abi.encode(auditId, requestId, blockHash, sig));
        assertTrue(sampler.audits(auditId).settled);
        assertEq(sampler.oracleMessage(requestId, blockHash), oracle.messageOf(requestId));
    }

    function test_l1_oneAnswerPerAudit_andPerOracleRequest() public {
        (uint256 a1, uint256 r1) = _request(40, 3);
        uint256[2] memory sig = _answer(r1);
        adapter.forward(r1, sig);
        l1Messenger.deliver(fujiMessenger, 0);
        bytes memory m = fujiMessenger.message(0);
        vm.expectRevert(L1AuditSampler.AlreadySettled.selector);
        l1Messenger.deliverRaw(address(sampler), FUJI, address(adapter), m);

        vm.prank(AUDITOR);
        sampler.announce(keccak256("b"), 40, 3, TREASURER);
        vm.prank(TREASURER);
        uint256 a2 = sampler.requestAudit(keccak256("b"), AUDITOR, "b");
        (, uint256 req, bytes32 bh, uint256[2] memory s) = abi.decode(m, (uint256, uint256, bytes32, uint256[2]));
        vm.expectRevert(L1AuditSampler.AnswerReused.selector);
        l1Messenger.deliverRaw(address(sampler), FUJI, address(adapter), abi.encode(a2, req, bh, s));
        vm.expectRevert(L1AuditSampler.UnknownAudit.selector);
        l1Messenger.deliverRaw(address(sampler), FUJI, address(adapter), abi.encode(uint256(77), req, bh, s));
        assertEq(sampler.auditOfOracleRequest(r1), a1);
    }

    function test_l1_announceAndRequestRules() public {
        vm.expectRevert(L1AuditSampler.BadSample.selector);
        sampler.announce(FILE, 2, 3, TREASURER);
        vm.expectRevert(L1AuditSampler.BadRequester.selector);
        sampler.announce(FILE, 10, 3, address(0));
        vm.prank(AUDITOR);
        sampler.announce(FILE, 10, 3, TREASURER);
        vm.prank(AUDITOR);
        vm.expectRevert(L1AuditSampler.AlreadyAnnounced.selector);
        sampler.announce(FILE, 10, 3, TREASURER);
        vm.expectRevert(L1AuditSampler.NotAnnounced.selector);
        sampler.requestAudit(FILE, AUDITOR, "x");
        vm.prank(TREASURER);
        uint256 id = sampler.requestAudit(FILE, AUDITOR, "x");
        vm.prank(TREASURER);
        vm.expectRevert(abi.encodeWithSelector(L1AuditSampler.AlreadyAudited.selector, id));
        sampler.requestAudit(FILE, AUDITOR, "x");
        vm.expectRevert(L1AuditSampler.NotSettled.selector);
        sampler.sampleOf(id);
    }

    function test_l1_rejectsAnInvalidPublicKey() public {
        uint256[4] memory zero;
        vm.expectRevert(L1AuditSampler.BadPublicKey.selector);
        new L1AuditSampler(ITeleporterMessenger(address(l1Messenger)), FUJI, 1, address(oracle), zero);
    }

    function testFuzz_l1Pick_matchesFujiPick(uint256 seed, uint32 count, uint16 size) public {
        count = uint32(bound(count, 1, 5000));
        size = uint16(bound(size, 1, count < 32 ? count : 32));
        AuditSampler fujiSampler = new AuditSampler(oracle);
        uint32[] memory a = sampler.pick(seed, count, size);
        uint32[] memory b = fujiSampler.pick(seed, count, size);
        assertEq(a.length, b.length);
        for (uint256 i; i < a.length; i++) assertEq(a[i], b[i]);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {BLS} from "./BLS.sol";

interface IRandomnessConsumer {
    function onRandomness(uint256 requestId, uint256 randomness) external;
}

/// @title RandomnessOracle: a number nobody chose, from one BLS key that lives off-chain.
/// @notice A contract pays a flat fee and requests. The key holders sign a message tied to that request, and
///         anyone may submit the signature. The result is the hash of the signature. Nobody can make up a
///         result, because a message has only one valid signature under the key. The key holders can still
///         see the result first and refuse to answer. See README for what this does and does not protect
///         against.
///         The contract checks every answer against one public key. Off-chain that key can sit in one node, or
///         be split so that any t of n nodes sign together (node/src/threshold.ts); the signature is the same
///         either way. Which of the two a deployment is, is fixed here at deployment: `threshold` is 1 for a
///         single signer, or else the public keys of all n key shares are stored, and the constructor refuses
///         them unless any `threshold` of them make up the public key. That says how the key was split. It
///         cannot say who holds the shares.
/// @dev The only role is `operator`: the address that receives the fees of answered requests. It is fixed at
///      deployment and has no other power: `withdraw` can be called by anyone and always pays the operator.
///      There is no owner, no pause and no key rotation: someone able to change the key could pick one after
///      seeing a request and so choose the result. A new key or a new fee means a new deployment.
contract RandomnessOracle {
    enum Status { None, Pending, Fulfilled, Expired }

    struct Request {
        address consumer;
        uint64 requestBlock;
        Status status;
    }

    /// @notice Gas forwarded to every callback. A consumer needing more should store and finish later.
    uint256 public constant CALLBACK_GAS = 200_000;
    /// @notice BLOCKHASH only reaches back 256 blocks, so a request can only be answered within that.
    uint256 public constant EXPIRY_BLOCKS = 256;
    /// @dev Kept back for cold account access and for finishing after a callback that spends its allowance.
    uint256 private constant GAS_RESERVE = 10_000;

    address payable public immutable operator;
    uint256 public immutable fee;
    uint256 private immutable pk0;
    uint256 private immutable pk1;
    uint256 private immutable pk2;
    uint256 private immutable pk3;

    /// @notice How many key shares it takes to sign. 1 means a single signer holds the whole key.
    uint8 public immutable threshold;
    /// @dev Public key of share i at index i - 1. Empty when `threshold` is 1.
    uint256[4][] private shareKeys;

    uint256 public requestCount;
    uint256 public earned;
    mapping(uint256 => Request) public requests;
    mapping(address => uint256) public refunds;
    mapping(uint256 => uint256) private results;

    error BadPublicKey();
    error BadOperator();
    error BadShares();
    error WrongFee();
    error NotPending();
    error OutsideWindow();
    error BadSignature();
    error NotEnoughGas();
    error NotFulfilled();
    error NothingToWithdraw();
    error TransferFailed();

    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomness, bool callbackOk);
    event RequestExpired(uint256 indexed requestId);
    event KeyShares(uint8 threshold, uint256[4][] shareKeys);

    /// @param threshold_ 1 with no share keys for a single signer. Otherwise at least 2, with the public key of
    ///        every key share, in order: share 1 first.
    constructor(
        uint256[4] memory publicKey_,
        address payable operator_,
        uint256 fee_,
        uint8 threshold_,
        uint256[4][] memory shareKeys_
    ) {
        if (!BLS.isValidPublicKey(publicKey_)) revert BadPublicKey();
        if (operator_ == address(0)) revert BadOperator();
        if (shareKeys_.length == 0 ? threshold_ != 1 : !BLS.sharesMatchKey(publicKey_, shareKeys_, threshold_)) {
            revert BadShares();
        }
        (pk0, pk1, pk2, pk3) = (publicKey_[0], publicKey_[1], publicKey_[2], publicKey_[3]);
        operator = operator_;
        fee = fee_;
        threshold = threshold_;
        for (uint256 i; i < shareKeys_.length; i++) {
            shareKeys.push(shareKeys_[i]);
        }
        emit KeyShares(threshold_, shareKeys_);
    }

    function requestRandomness() external payable returns (uint256 requestId) {
        if (msg.value != fee) revert WrongFee();
        requestId = ++requestCount;
        requests[requestId] = Request(msg.sender, uint64(block.number), Status.Pending);
        emit RandomnessRequested(requestId, msg.sender);
    }

    /// @notice Anyone may submit: the signature is the authority.
    function fulfill(uint256 requestId, uint256[2] calldata signature) external {
        Request storage r = requests[requestId];
        if (r.status != Status.Pending) revert NotPending();
        uint256 age = block.number - r.requestBlock;
        if (age == 0 || age > EXPIRY_BLOCKS) revert OutsideWindow();
        if (!BLS.verify(publicKey(), _message(requestId, r), signature)) revert BadSignature();

        uint256 randomness = uint256(keccak256(abi.encode(signature)));
        r.status = Status.Fulfilled;
        results[requestId] = randomness;
        earned += fee;

        bool callbackOk = _callback(r.consumer, requestId, randomness);
        emit RandomnessFulfilled(requestId, randomness, callbackOk);
    }

    /// @notice Closes a request that can no longer be answered, and credits its fee to the consumer.
    /// @dev Consumers must not redraw automatically after this: a new try is what a withholding operator wants.
    function expire(uint256 requestId) external {
        Request storage r = requests[requestId];
        if (r.status != Status.Pending) revert NotPending();
        if (block.number <= r.requestBlock + EXPIRY_BLOCKS) revert OutsideWindow();
        r.status = Status.Expired;
        refunds[r.consumer] += fee;
        emit RequestExpired(requestId);
    }

    function withdrawRefund(address payable to, uint256 amount) external {
        uint256 balance = refunds[msg.sender];
        if (amount == 0 || amount > balance) revert NothingToWithdraw();
        refunds[msg.sender] = balance - amount;
        _send(to, amount);
    }

    /// @notice Sends earned fees to the operator. Fees of unanswered requests are not included.
    function withdraw() external {
        uint256 amount = earned;
        if (amount == 0) revert NothingToWithdraw();
        earned = 0;
        _send(operator, amount);
    }

    function randomnessOf(uint256 requestId) external view returns (uint256) {
        if (requests[requestId].status != Status.Fulfilled) revert NotFulfilled();
        return results[requestId];
    }

    function statusOf(uint256 requestId) external view returns (Status) {
        return requests[requestId].status;
    }

    /// @notice What the operator signs. The request block's hash is not known when the request is sent.
    function messageOf(uint256 requestId) external view returns (bytes32) {
        return _message(requestId, requests[requestId]);
    }

    function publicKey() public view returns (uint256[4] memory) {
        return [pk0, pk1, pk2, pk3];
    }

    /// @notice How many key shares exist. 0 for a single signer.
    function shareCount() external view returns (uint256) {
        return shareKeys.length;
    }

    /// @notice Public key of key share `index`, counted from 1 as the nodes count them.
    function shareKey(uint256 index) external view returns (uint256[4] memory) {
        return shareKeys[index - 1];
    }

    function _message(uint256 requestId, Request storage r) private view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), requestId, r.consumer, blockhash(r.requestBlock)));
    }

    /// @dev Reverts if the callback would get less than its allowance, so a submitter cannot make it fail
    ///      on purpose by sending too little gas. No return data is copied, so a large revert costs nothing.
    function _callback(address consumer, uint256 requestId, uint256 randomness) private returns (bool ok) {
        bytes memory data = abi.encodeCall(IRandomnessConsumer.onRandomness, (requestId, randomness));
        uint256 available = gasleft();
        if (available < GAS_RESERVE) revert NotEnoughGas();
        available -= GAS_RESERVE;
        if (available - available / 64 < CALLBACK_GAS) revert NotEnoughGas();
        assembly ("memory-safe") {
            ok := call(CALLBACK_GAS, consumer, 0, add(data, 0x20), mload(data), 0, 0)
        }
    }

    function _send(address payable to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IRandomnessConsumer, RandomnessOracle} from "../RandomnessOracle.sol";
import {ITeleporterMessenger, ITeleporterReceiver, TeleporterFeeInfo, TeleporterMessageInput} from "./ITeleporter.sol";

/// @title IcmRandomnessAdapter: the oracle on Fuji, reachable from one Avalanche L1 over ICM.
/// @notice Lives on the Fuji C-Chain next to RandomnessOracle. An audit sampler on the L1 sends a request over ICM;
///         this contract files it with the oracle and pays the oracle fee from its own balance (the audit office
///         prepays it). When the oracle nodes answer, anyone may forward the answer back over ICM together with the
///         BLS signature and the hash of the request's block, so the L1 can check the signature itself against the
///         oracle's public key. Forwarding is open to anyone because the signature is the authority: it must hash
///         to the number the oracle stored, and the L1 checks it again with a pairing.
/// @dev Only messages from `remoteSampler` on `remoteBlockchainID`, delivered by `messenger`, are accepted. The
///      remote is set once by the deployer (the L1 contract is deployed after this one) and cannot change.
contract IcmRandomnessAdapter is IRandomnessConsumer, ITeleporterReceiver {
    /// @notice Gas the L1 gets to check the signature, derive the sample and store it.
    uint256 public constant RETURN_GAS_LIMIT = 1_000_000;

    struct Pending {
        uint256 remoteAuditId;
        bytes32 commitment;
        bytes32 requestBlockHash;
        uint256 randomness;
        bool answered;
        bool forwarded;
    }

    RandomnessOracle public immutable oracle;
    ITeleporterMessenger public immutable messenger;
    bytes32 public immutable remoteBlockchainID;
    address public immutable owner;
    address public remoteSampler;

    /// @notice What is known about each oracle request this adapter made, by oracle request id.
    mapping(uint256 => Pending) public pending;
    /// @notice The oracle request filed for an L1 audit id, or 0.
    mapping(uint256 => uint256) public requestOfRemoteAudit;

    error NotOwner();
    error RemoteAlreadySet();
    error NotMessenger();
    error WrongSource();
    error AlreadyRequested();
    error NotOracle();
    error NotAnswered();
    error AlreadyForwarded();
    error WrongSignature();
    error TransferFailed();

    event RemoteSet(bytes32 indexed blockchainID, address indexed sampler);
    event RemoteRequestFiled(uint256 indexed remoteAuditId, uint256 indexed oracleRequestId, bytes32 commitment);
    event OracleAnswered(uint256 indexed oracleRequestId, uint256 randomness, bytes32 requestBlockHash);
    event AnswerForwarded(uint256 indexed remoteAuditId, uint256 indexed oracleRequestId, bytes32 messageID);

    constructor(RandomnessOracle oracle_, ITeleporterMessenger messenger_, bytes32 remoteBlockchainID_) {
        oracle = oracle_;
        messenger = messenger_;
        remoteBlockchainID = remoteBlockchainID_;
        owner = msg.sender;
    }

    /// @notice Oracle fees are paid from this balance.
    receive() external payable {}

    function setRemoteSampler(address sampler) external {
        if (msg.sender != owner) revert NotOwner();
        if (remoteSampler != address(0)) revert RemoteAlreadySet();
        remoteSampler = sampler;
        emit RemoteSet(remoteBlockchainID, sampler);
    }

    /// @notice ICM delivery of an audit request from the L1: `abi.encode(auditId, commitment)`.
    function receiveTeleporterMessage(bytes32 sourceBlockchainID, address originSenderAddress, bytes calldata message)
        external
    {
        if (msg.sender != address(messenger)) revert NotMessenger();
        if (sourceBlockchainID != remoteBlockchainID || originSenderAddress != remoteSampler) revert WrongSource();
        (uint256 auditId, bytes32 commitment) = abi.decode(message, (uint256, bytes32));
        if (requestOfRemoteAudit[auditId] != 0) revert AlreadyRequested();

        uint256 requestId = oracle.requestRandomness{value: oracle.fee()}();
        requestOfRemoteAudit[auditId] = requestId;
        Pending storage p = pending[requestId];
        p.remoteAuditId = auditId;
        p.commitment = commitment;
        emit RemoteRequestFiled(auditId, requestId, commitment);
    }

    /// @notice The oracle's callback. Stores the number and the hash of the request's block; the hash is part of
    ///         the signed message and stops being readable 256 blocks later.
    function onRandomness(uint256 requestId, uint256 randomness) external {
        if (msg.sender != address(oracle)) revert NotOracle();
        _record(requestId, randomness);
    }

    /// @notice Sends the answer to the L1 with the signature the nodes submitted to the oracle.
    /// @param signature The BLS signature from the oracle's `fulfill` transaction. It must hash to the stored number.
    function forward(uint256 requestId, uint256[2] calldata signature) external returns (bytes32 messageID) {
        Pending storage p = pending[requestId];
        if (!p.answered) _recordLate(requestId);
        if (p.forwarded) revert AlreadyForwarded();
        if (uint256(keccak256(abi.encode(signature))) != p.randomness) revert WrongSignature();
        p.forwarded = true;

        messageID = messenger.sendCrossChainMessage(
            TeleporterMessageInput({
                destinationBlockchainID: remoteBlockchainID,
                destinationAddress: remoteSampler,
                feeInfo: TeleporterFeeInfo(address(0), 0),
                requiredGasLimit: RETURN_GAS_LIMIT,
                allowedRelayerAddresses: new address[](0),
                message: abi.encode(p.remoteAuditId, requestId, p.requestBlockHash, signature)
            })
        );
        emit AnswerForwarded(p.remoteAuditId, requestId, messageID);
    }

    /// @notice Closes an oracle request nobody answered and takes its fee back into this balance.
    function reclaim(uint256 requestId) external {
        if (oracle.statusOf(requestId) == RandomnessOracle.Status.Pending) oracle.expire(requestId);
        oracle.withdrawRefund(payable(address(this)), oracle.fee());
    }

    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev For an answer whose callback failed: the number comes from the oracle, the block hash must still be
    ///      readable (within 256 blocks of the request).
    function _recordLate(uint256 requestId) private {
        if (pending[requestId].remoteAuditId == 0) revert NotAnswered();
        _record(requestId, oracle.randomnessOf(requestId));
        if (pending[requestId].requestBlockHash == bytes32(0)) revert NotAnswered();
    }

    function _record(uint256 requestId, uint256 randomness) private {
        Pending storage p = pending[requestId];
        if (p.remoteAuditId == 0 || p.answered) return;
        (, uint64 requestBlock,) = oracle.requests(requestId);
        p.requestBlockHash = blockhash(requestBlock);
        p.randomness = randomness;
        p.answered = true;
        emit OracleAnswered(requestId, randomness, p.requestBlockHash);
    }
}

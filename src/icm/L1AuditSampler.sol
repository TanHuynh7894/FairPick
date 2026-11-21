// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {BLS} from "../BLS.sol";
import {ITeleporterMessenger, ITeleporterReceiver, TeleporterFeeInfo, TeleporterMessageInput} from "./ITeleporter.sol";

/// @title L1AuditSampler: audit sampling on the fairpick L1, with the number coming from the oracle on Fuji.
/// @notice The audit office's own chain. An auditor announces a receipt list (hash, receipt count, sample size and
///         the one treasurer wallet allowed to request); that treasurer requests the draw, and the request goes over
///         ICM to the adapter on Fuji, which files it with RandomnessOracle. The answer comes back over ICM with the
///         oracle's BLS signature and the hash of the Fuji block of the request. This contract rebuilds the message
///         the oracle nodes signed, checks the signature against the oracle's public key with a pairing, and only
///         then derives and stores the receipts to check. The L1's own validator never picks the number, so it
///         cannot steer the sample by choosing block contents.
/// @dev The pick rule is the same as AuditSampler.pick on Fuji, and a test checks they agree. A list is drawn once
///      per announcement. Same rules as AuditSampler for announce; no fee on this chain (gas is the L1's token).
contract L1AuditSampler is ITeleporterReceiver {
    uint32 public constant MAX_ITEMS = 1_000_000;
    uint16 public constant MAX_SAMPLE = 32;
    uint256 public constant MAX_LABEL = 64;
    /// @notice Gas the Fuji adapter gets to file the request with the oracle.
    uint256 public constant REQUEST_GAS_LIMIT = 500_000;

    struct Announcement {
        address requester;
        uint32 itemCount;
        uint16 sampleSize;
    }

    struct Audit {
        address requester;
        uint32 itemCount;
        uint16 sampleSize;
        bool settled;
        address auditor;
        bytes32 fileHash;
        /// The request id on the Fuji oracle, and the hash of the Fuji block it was made in.
        uint256 oracleRequestId;
        bytes32 requestBlockHash;
        uint256[2] signature;
        uint256 seed;
        uint32[] picks;
        string label;
    }

    ITeleporterMessenger public immutable messenger;
    bytes32 public immutable fujiBlockchainID;
    /// @notice What the oracle nodes sign includes the chain id, the oracle and the consumer (the adapter).
    uint256 public immutable fujiChainId;
    address public immutable fujiOracle;
    address public immutable owner;
    uint256 private immutable pk0;
    uint256 private immutable pk1;
    uint256 private immutable pk2;
    uint256 private immutable pk3;
    address public adapter;

    uint256 public auditCount;
    mapping(uint256 => Audit) private _audits;
    mapping(address auditor => mapping(bytes32 fileHash => Announcement)) public announcements;
    /// @notice The audit of an announcement, by `listKey(auditor, fileHash)`, or 0.
    mapping(bytes32 => uint256) public auditOfList;
    /// @notice Each oracle answer settles one audit at most.
    mapping(uint256 => uint256) public auditOfOracleRequest;

    error NotOwner();
    error AdapterAlreadySet();
    error BadPublicKey();
    error BadSample();
    error BadRequester();
    error LabelTooLong();
    error AlreadyAnnounced();
    error NotAnnounced();
    error AlreadyAudited(uint256 auditId);
    error NotMessenger();
    error WrongSource();
    error UnknownAudit();
    error AlreadySettled();
    error AnswerReused();
    error BadSignature();
    error NotSettled();

    event AdapterSet(address indexed adapter);
    event ListAnnounced(
        address indexed auditor,
        bytes32 indexed fileHash,
        address indexed requester,
        bytes32 commitment,
        uint32 itemCount,
        uint16 sampleSize
    );
    event AuditRequested(
        uint256 indexed auditId, address indexed requester, bytes32 indexed fileHash, address auditor, bytes32 messageID
    );
    event AuditPicked(
        uint256 indexed auditId, uint256 indexed oracleRequestId, uint256 seed, bytes32 requestBlockHash, uint32[] picks
    );

    constructor(
        ITeleporterMessenger messenger_,
        bytes32 fujiBlockchainID_,
        uint256 fujiChainId_,
        address fujiOracle_,
        uint256[4] memory oraclePublicKey_
    ) {
        if (!BLS.isValidPublicKey(oraclePublicKey_)) revert BadPublicKey();
        messenger = messenger_;
        fujiBlockchainID = fujiBlockchainID_;
        fujiChainId = fujiChainId_;
        fujiOracle = fujiOracle_;
        owner = msg.sender;
        (pk0, pk1, pk2, pk3) = (oraclePublicKey_[0], oraclePublicKey_[1], oraclePublicKey_[2], oraclePublicKey_[3]);
    }

    /// @notice Set once by the deployer: the adapter on Fuji is deployed first and named here.
    function setAdapter(address adapter_) external {
        if (msg.sender != owner) revert NotOwner();
        if (adapter != address(0)) revert AdapterAlreadySet();
        adapter = adapter_;
        emit AdapterSet(adapter_);
    }

    /// @notice The caller, as auditor, fixes the list, the sample size and the one wallet that may request.
    function announce(bytes32 fileHash, uint32 itemCount, uint16 sampleSize, address requester) external {
        if (sampleSize == 0 || sampleSize > MAX_SAMPLE || itemCount > MAX_ITEMS || sampleSize > itemCount) revert BadSample();
        if (requester == address(0)) revert BadRequester();
        Announcement storage a = announcements[msg.sender][fileHash];
        if (a.requester != address(0)) revert AlreadyAnnounced();
        (a.requester, a.itemCount, a.sampleSize) = (requester, itemCount, sampleSize);
        emit ListAnnounced(msg.sender, fileHash, requester, commitment(fileHash, itemCount), itemCount, sampleSize);
    }

    /// @notice The named treasurer requests the draw. The request leaves for Fuji over ICM.
    function requestAudit(bytes32 fileHash, address auditor, string calldata label) external returns (uint256 auditId) {
        Announcement memory announced = announcements[auditor][fileHash];
        if (announced.requester != msg.sender) revert NotAnnounced();
        if (bytes(label).length > MAX_LABEL) revert LabelTooLong();
        bytes32 key = listKey(auditor, fileHash);
        if (auditOfList[key] != 0) revert AlreadyAudited(auditOfList[key]);

        auditId = ++auditCount;
        auditOfList[key] = auditId;
        Audit storage a = _audits[auditId];
        a.requester = msg.sender;
        a.itemCount = announced.itemCount;
        a.sampleSize = announced.sampleSize;
        a.auditor = auditor;
        a.fileHash = fileHash;
        a.label = label;

        bytes32 messageID = messenger.sendCrossChainMessage(
            TeleporterMessageInput({
                destinationBlockchainID: fujiBlockchainID,
                destinationAddress: adapter,
                feeInfo: TeleporterFeeInfo(address(0), 0),
                requiredGasLimit: REQUEST_GAS_LIMIT,
                allowedRelayerAddresses: new address[](0),
                message: abi.encode(auditId, commitment(fileHash, announced.itemCount))
            })
        );
        emit AuditRequested(auditId, msg.sender, fileHash, auditor, messageID);
    }

    /// @notice ICM delivery of the oracle's answer: `abi.encode(auditId, oracleRequestId, requestBlockHash, signature)`.
    function receiveTeleporterMessage(bytes32 sourceBlockchainID, address originSenderAddress, bytes calldata message)
        external
    {
        if (msg.sender != address(messenger)) revert NotMessenger();
        if (sourceBlockchainID != fujiBlockchainID || originSenderAddress != adapter) revert WrongSource();
        (uint256 auditId, uint256 oracleRequestId, bytes32 requestBlockHash, uint256[2] memory signature) =
            abi.decode(message, (uint256, uint256, bytes32, uint256[2]));
        Audit storage a = _audits[auditId];
        if (a.requester == address(0)) revert UnknownAudit();
        if (a.settled) revert AlreadySettled();
        if (auditOfOracleRequest[oracleRequestId] != 0) revert AnswerReused();
        if (!BLS.verify(oraclePublicKey(), oracleMessage(oracleRequestId, requestBlockHash), signature)) {
            revert BadSignature();
        }

        uint256 seed = uint256(keccak256(abi.encode(signature)));
        auditOfOracleRequest[oracleRequestId] = auditId;
        a.settled = true;
        a.oracleRequestId = oracleRequestId;
        a.requestBlockHash = requestBlockHash;
        a.signature = signature;
        a.seed = seed;
        a.picks = pick(seed, a.itemCount, a.sampleSize);
        emit AuditPicked(auditId, oracleRequestId, seed, requestBlockHash, a.picks);
    }

    /// @notice The message the oracle nodes sign for a request the adapter made on Fuji (RandomnessOracle._message).
    function oracleMessage(uint256 oracleRequestId, bytes32 requestBlockHash) public view returns (bytes32) {
        return keccak256(abi.encode(fujiChainId, fujiOracle, oracleRequestId, adapter, requestBlockHash));
    }

    function oraclePublicKey() public view returns (uint256[4] memory) {
        return [pk0, pk1, pk2, pk3];
    }

    function audits(uint256 auditId) external view returns (Audit memory) {
        return _audits[auditId];
    }

    /// @notice The receipts to check, 1-based, in draw order. Stored when the answer arrived.
    function sampleOf(uint256 auditId) external view returns (uint32[] memory) {
        if (!_audits[auditId].settled) revert NotSettled();
        return _audits[auditId].picks;
    }

    function listKey(address auditor, bytes32 fileHash) public pure returns (bytes32) {
        return keccak256(abi.encode(auditor, fileHash));
    }

    function commitment(bytes32 fileHash, uint32 itemCount) public pure returns (bytes32) {
        return keccak256(abi.encode(fileHash, itemCount));
    }

    /// @notice Same rule as AuditSampler.pick: draw i is keccak256(seed, i, try) mod itemCount + 1, retried on a repeat.
    function pick(uint256 seed, uint32 itemCount, uint16 sampleSize) public pure returns (uint32[] memory picks) {
        if (sampleSize == 0 || sampleSize > MAX_SAMPLE || sampleSize > itemCount) revert BadSample();
        picks = new uint32[](sampleSize);
        for (uint256 i; i < sampleSize; i++) {
            for (uint256 t;; t++) {
                uint32 candidate = uint32(uint256(keccak256(abi.encode(seed, i, t))) % itemCount) + 1;
                bool seen;
                for (uint256 j; j < i; j++) {
                    if (picks[j] == candidate) {
                        seen = true;
                        break;
                    }
                }
                if (!seen) {
                    picks[i] = candidate;
                    break;
                }
            }
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IRandomnessConsumer, RandomnessOracle} from "./RandomnessOracle.sol";

/// @title AuditSampler: picks which receipts of a list get audited, with a pick nobody chose.
/// @notice An auditor announces a receipt list: its hash, its receipt count, how many receipts to check, and the
///         one address allowed to ask for the draw. That address (a club or fund treasurer) then pays the oracle
///         fee, and the oracle's number fixes which receipts the auditor checks. The list itself stays off-chain.
///
///         The announcement is what an auditor anchors on. A draw exists only for a list an auditor announced,
///         only for the requester they named, and only once per announcement, so a stranger who knows the hash
///         cannot use the draw up, and a treasurer cannot draw variants of a list the auditor did not announce.
///         The only way to a further draw is an earlier one that nobody answered within the oracle's window and
///         that was refunded; it is numbered (`draw` 2, 3, ...).
///
///         Anyone can be an auditor, including the requester. An audit whose auditor is its own requester has no
///         independent anchor, and the page says so.
/// @dev Same three rules as any consumer of the oracle: the callback only stores the seed; `settle` finishes if
///      the callback failed; an expired request is refunded and never redrawn by this contract.
contract AuditSampler is IRandomnessConsumer {
    uint32 public constant MAX_ITEMS = 1_000_000;
    uint16 public constant MAX_SAMPLE = 32;
    uint256 public constant MAX_LABEL = 64;

    struct Announcement {
        address requester;
        uint32 itemCount;
        uint16 sampleSize;
    }

    struct Audit {
        address requester;
        uint32 itemCount;
        uint16 sampleSize;
        /// 1 for the first request under this announcement. Higher only after an unanswered draw was refunded.
        uint32 draw;
        bool settled;
        bool refunded;
        address auditor;
        bool reported;
        /// Set by the auditor's report: bit i says the i-th receipt of `sampleOf` was not found.
        uint32 missing;
        /// keccak256 of the list's canonical bytes (see README, "The list hash").
        bytes32 fileHash;
        uint256 seed;
        string label;
    }

    RandomnessOracle public immutable oracle;
    mapping(uint256 => Audit) private _audits;
    /// @notice What an auditor announced for a file hash. `requester` is zero if they announced nothing.
    mapping(address auditor => mapping(bytes32 fileHash => Announcement)) public announcements;
    /// @notice How many lists an auditor has announced, so one announcement can be put in context.
    mapping(address => uint32) public announcedBy;
    /// @notice The latest audit under an announcement, by `listKey(auditor, fileHash)`, or 0.
    mapping(bytes32 => uint256) public auditOfList;
    /// @notice How many draws were requested under an announcement, refunded ones included.
    mapping(bytes32 => uint32) public drawsOfList;
    /// @notice How many draws the same file hash has had under any auditor.
    mapping(bytes32 => uint32) public drawsOfFile;
    /// @notice How many audits an address has requested.
    mapping(address => uint32) public auditsBy;

    error NotOracle();
    error NotRefundable();
    error BadSample();
    error BadRequester();
    error LabelTooLong();
    error NotSettled();
    error AlreadyAnnounced();
    error NotAnnounced();
    error AlreadyAudited(uint256 auditId);
    error NotAuditor();
    error AlreadyReported();
    error BadReport();

    event ListAnnounced(
        address indexed auditor,
        bytes32 indexed fileHash,
        address indexed requester,
        bytes32 commitment,
        uint32 itemCount,
        uint16 sampleSize
    );
    event AuditRequested(
        uint256 indexed requestId, address indexed requester, bytes32 indexed fileHash, address auditor, uint32 draw
    );
    event AuditPicked(uint256 indexed requestId, uint256 seed);
    event AuditReported(uint256 indexed requestId, address indexed auditor, uint32 missing);

    constructor(RandomnessOracle oracle_) {
        oracle = oracle_;
    }

    /// @notice The caller, as auditor, fixes what will be audited and who may ask for the draw. It cannot be
    ///         changed afterwards, and the same auditor cannot announce the same file hash twice.
    /// @param fileHash keccak256 of the receipt list's canonical bytes.
    /// @param itemCount Number of receipts in the list, numbered 1..itemCount.
    /// @param sampleSize How many receipts to audit, at most MAX_SAMPLE.
    /// @param requester The only address whose `requestAudit` will be accepted for this announcement.
    function announce(bytes32 fileHash, uint32 itemCount, uint16 sampleSize, address requester) external {
        if (sampleSize == 0 || sampleSize > MAX_SAMPLE || itemCount > MAX_ITEMS || sampleSize > itemCount) revert BadSample();
        if (requester == address(0)) revert BadRequester();
        Announcement storage a = announcements[msg.sender][fileHash];
        if (a.requester != address(0)) revert AlreadyAnnounced();
        a.requester = requester;
        a.itemCount = itemCount;
        a.sampleSize = sampleSize;
        announcedBy[msg.sender]++;
        emit ListAnnounced(msg.sender, fileHash, requester, commitment(fileHash, itemCount), itemCount, sampleSize);
    }

    /// @notice Asks the oracle for the draw of a list `auditor` announced for the caller. Count and sample size are
    ///         the announced ones.
    /// @param label A short public name for the list. No personal data.
    function requestAudit(bytes32 fileHash, address auditor, string calldata label)
        external
        payable
        returns (uint256 requestId)
    {
        Announcement memory announced = announcements[auditor][fileHash];
        if (announced.requester != msg.sender) revert NotAnnounced();
        if (bytes(label).length > MAX_LABEL) revert LabelTooLong();
        bytes32 key = listKey(auditor, fileHash);
        uint256 previous = auditOfList[key];
        if (previous != 0 && !_audits[previous].refunded) revert AlreadyAudited(previous);

        requestId = oracle.requestRandomness{value: msg.value}();
        uint32 draw = ++drawsOfList[key];
        auditOfList[key] = requestId;
        drawsOfFile[fileHash]++;
        auditsBy[msg.sender]++;
        Audit storage a = _audits[requestId];
        a.requester = msg.sender;
        a.itemCount = announced.itemCount;
        a.sampleSize = announced.sampleSize;
        a.draw = draw;
        a.auditor = auditor;
        a.fileHash = fileHash;
        a.label = label;
        emit AuditRequested(requestId, msg.sender, fileHash, auditor, draw);
    }

    /// @notice The auditor records what they found, once: which of the picked receipts were missing.
    /// @param missing Bit i set means the i-th receipt of `sampleOf(requestId)` was not found. 0 means all found.
    function report(uint256 requestId, uint32 missing) external {
        Audit storage a = _audits[requestId];
        if (msg.sender != a.auditor) revert NotAuditor();
        if (!a.settled) revert NotSettled();
        if (a.reported) revert AlreadyReported();
        if (missing >> a.sampleSize != 0) revert BadReport();
        a.reported = true;
        a.missing = missing;
        emit AuditReported(requestId, msg.sender, missing);
    }

    function onRandomness(uint256 requestId, uint256 randomness) external {
        if (msg.sender != address(oracle)) revert NotOracle();
        _settle(requestId, randomness);
    }

    /// @notice Anyone may finish an audit whose callback failed. Reverts if the oracle has no result yet.
    function settle(uint256 requestId) external {
        _settle(requestId, oracle.randomnessOf(requestId));
    }

    /// @notice Closes an expired request if needed and pays the fee back to the requester.
    function refund(uint256 requestId) external {
        Audit storage a = _audits[requestId];
        if (a.requester == address(0) || a.refunded || a.settled) revert NotRefundable();
        a.refunded = true;
        RandomnessOracle.Status status = oracle.statusOf(requestId);
        if (status == RandomnessOracle.Status.Pending) {
            oracle.expire(requestId);
        } else if (status != RandomnessOracle.Status.Expired) {
            revert NotRefundable();
        }
        oracle.withdrawRefund(payable(a.requester), oracle.fee());
    }

    /// @notice Everything stored about one audit.
    function audits(uint256 requestId) external view returns (Audit memory) {
        return _audits[requestId];
    }

    /// @notice What one announcement is filed under: the auditor and the file hash together.
    function listKey(address auditor, bytes32 fileHash) public pure returns (bytes32) {
        return keccak256(abi.encode(auditor, fileHash));
    }

    /// @notice One value that stands for the list: its bytes and its receipt count together.
    /// @dev Someone holding a file recomputes this from the file alone, by hashing it and counting its rows.
    ///      A file with 45 rows therefore cannot pass for a commitment made with a count of 40.
    function commitment(bytes32 fileHash, uint32 itemCount) public pure returns (bytes32) {
        return keccak256(abi.encode(fileHash, itemCount));
    }

    function commitmentOf(uint256 requestId) external view returns (bytes32) {
        Audit storage a = _audits[requestId];
        return commitment(a.fileHash, a.itemCount);
    }

    /// @notice The receipts to audit, 1-based, in the order they were drawn. Distinct, each in 1..itemCount.
    function sampleOf(uint256 requestId) external view returns (uint32[] memory picks) {
        Audit storage a = _audits[requestId];
        if (!a.settled) revert NotSettled();
        return pick(a.seed, a.itemCount, a.sampleSize);
    }

    /// @notice The pick for a seed, so a list holder can recompute it off-chain and compare.
    /// @dev Draw i is keccak256(seed, i, try) mod itemCount, retried on a repeat. Each draw is off uniform by less
    ///      than itemCount / 2^256, so a whole sample by less than sampleSize * itemCount / 2^256: under 2^-231
    ///      at the largest sizes allowed.
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

    function _settle(uint256 requestId, uint256 randomness) private {
        Audit storage a = _audits[requestId];
        if (a.settled || a.requester == address(0)) return;
        a.settled = true;
        a.seed = randomness;
        emit AuditPicked(requestId, randomness);
    }
}

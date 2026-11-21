// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev The part of Avalanche's TeleporterMessenger (ICM) that FairPick uses. The messenger is deployed at
///      0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf on the Fuji C-Chain and on the fairpick L1.
struct TeleporterFeeInfo {
    address feeTokenAddress;
    uint256 amount;
}

struct TeleporterMessageInput {
    bytes32 destinationBlockchainID;
    address destinationAddress;
    TeleporterFeeInfo feeInfo;
    uint256 requiredGasLimit;
    address[] allowedRelayerAddresses;
    bytes message;
}

interface ITeleporterMessenger {
    function sendCrossChainMessage(TeleporterMessageInput calldata messageInput) external returns (bytes32 messageID);
}

interface ITeleporterReceiver {
    function receiveTeleporterMessage(bytes32 sourceBlockchainID, address originSenderAddress, bytes calldata message)
        external;
}

# The `fairpick` L1

The audit office's own chain: chainId 510103, token FPK, blockchainID `24ttXXTxYDu7QNNMbdMkmjiZkBB5zYN5qQikNWTr3REqcibFYg`, subnetID `xhPrD6175hcsC8WRTb1e64c7agEkcBmkLA1YFtuTVxi42dXmj`. Subnet-EVM v1.15.3, sovereign L1 (ACP-77) with a proof-of-authority validator manager.

- [`genesis.json`](genesis.json): the chain's genesis, byte for byte what the P-Chain stores (sha256 `cc5535bb…8163315`).
- [`upgrade.json`](upgrade.json): a network upgrade that switched on the transaction allow-list at unix time 1795199165 (21 Nov 2026 01:26 VN). Every validator must load the same file, or it forks off.

## What the precompiles enforce, and why

| Precompile | Address | Enforces | Since |
|---|---|---|---|
| Warp | `0x0200000000000000000000000000000000000005` | The validator signs outgoing messages; incoming ones are checked against the sender chain's validators. ICM (Teleporter) runs on it | genesis |
| TxAllowList | `0x0200000000000000000000000000000000000002` | Only listed wallets can send any transaction. The node refuses others before they reach a block: `cannot issue transaction from non-allow listed address` | upgrade.json |

**Why.** The audit office decides who files audits for its member funds. On this chain only the office's treasurers, auditors and the ICM relayer can send transactions, so a stranger cannot file audits under a fund's name, spam the sampler, or spend FPK. On Fuji anyone can call a contract, and the allow-list of a contract does not stop transactions from reaching the chain. The admin adds a treasurer when a fund joins and removes it when it leaves (`setEnabled`, `setNone`), shown by [`scripts/l1-permissions.sh`](../scripts/l1-permissions.sh).

Roles now (`readAllowList(address)`: 0 none, 1 enabled, 2 admin):

| Wallet | Who | Role |
|---|---|---|
| `0x8e19042500d59CB3DceFC508221af9630337Fa75` | Audit office: auditor on the L1, operator of the oracle on Fuji | admin |
| `0x7855c958eC2e104D358aBAd285b50e7C759547F9` | Team ops key, owner of the validator manager | admin |
| `0x05431B6a89398994B65Fa8cc71d94afa57298639` | Treasurer | enabled |
| `0x474044236309DC089A92c5AB9A3daF853831F1DC` | ICM relayer (delivers the oracle's answers) | enabled |
| `0x9D75a7fF8DA5B07BF624C2e5B17208f33fcc36C5` | Genesis FPK holder | enabled |
| `0xA5DD2Ff4bF0b01308cE1E50C0767C3Ae7Be3302A` | Treasurer 2: enabled, filed audit 3, removed (below) | none |

### Permission demo, 21 Nov 2026 ([log](../docs/evidence/l1/permissions.log), `OUTSIDER_KEY=… ./scripts/l1-permissions.sh`)

| Step | Result on the L1 |
|---|---|
| Outsider `0x2cC6…a77E` (holds 1 FPK) sends `requestAudit` | refused by the node: `cannot issue transaction from non-allow listed address` |
| Admin `setEnabled(0xA5DD…302A)`, a treasurer wallet made for the demo | `0x97b142a57c803e95b882952324e692f450f6939f15e4a27f65b1c53f376ac356` |
| Admin sends it 1 FPK for gas | `0x7708ac8bd0b1a9092f66f70d2246c37663683ef642e9f6e56ce0bb75dd64098b` |
| The new treasurer files audit 3 (`requestAudit`, ICM send to Fuji) | `0x23d2a972dd35624ea208048d6f32721b9e295422ec28316f1f30921c55a99dfd`; answered on Fuji, receipts 5, 14, 1 stored on the L1 in `0xdd2680375da0d62286cca90c8007d4fcbdaf43b43e8be09cf4a4e9cd5564dd93` |
| Admin `setNone(0xA5DD…302A)`, offboarded | `0x4de92efdba82bd475abf164899c0ebf6cb36cb7f71ec0eb6ddb9c8846a2b0aef` |
| The same wallet sends `requestAudit` again | refused by the node: `cannot issue transaction from non-allow listed address` |

In this run the wallet's try before it was enabled hit its empty balance first (`insufficient funds`); the script now sends the gas before that try. The Fuji side of audit 3 is in the main README's run table (run 3).

No fee manager or contract-deployer allow-list is set: gas follows the genesis fee config (min base fee 1 gwei FPK), and an enabled wallet may deploy contracts.

## How to check it

From anywhere, on the public Fuji P-Chain:

```sh
P=https://api.avax-test.network/ext/bc/P
curl -s -X POST -H 'content-type:application/json' --data '{"jsonrpc":"2.0","id":1,"method":"platform.getSubnet","params":{"subnetID":"xhPrD6175hcsC8WRTb1e64c7agEkcBmkLA1YFtuTVxi42dXmj"}}' $P
#   managerChainID = 24ttXX… (this L1), managerAddress = 0x0feedc0de…: converted to an L1
curl -s -X POST -H 'content-type:application/json' --data '{"jsonrpc":"2.0","id":1,"method":"platform.getCurrentValidators","params":{"subnetID":"xhPrD6175hcsC8WRTb1e64c7agEkcBmkLA1YFtuTVxi42dXmj"}}' $P
#   one validator, NodeID-QLF4neeFGhSaD3KNtzB6poha5KNTLU3iL, weight 100
curl -s -X POST -H 'content-type:application/json' --data '{"jsonrpc":"2.0","id":1,"method":"platform.getTx","params":{"txID":"24ttXXTxYDu7QNNMbdMkmjiZkBB5zYN5qQikNWTr3REqcibFYg","encoding":"json"}}' $P \
  | python3 -c 'import json,sys,base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["result"]["tx"]["unsignedTx"]["genesisData"]))' | cmp - l1/genesis.json && echo same genesis
```

The blockchainID is the ID of the CreateChainTx, so `platform.getTx` on it returns the genesis. The upgrade file is not on the P-Chain: it lives in the node's chain config. On the L1's RPC (local to the team) `eth_getActiveRulesAt` lists `txAllowListConfig` with timestamp 1795199165, and `readAllowList` returns the roles above. On Fuji, the incoming ICM messages in the main [README](../README.md#own-l1-fairpick-and-icm) carry Warp signatures of this L1's validator.

## Limits

- One validator, on a team laptop. If it stops, the L1 stops.
- The RPC is on localhost. Judges see the L1 through the P-Chain and through the ICM messages on Fuji, not directly.
- Proof of authority: the validator manager and the allow-list admin are team keys.
- The validator's P-Chain balance pays a fee per second and needs topping up about daily.
- Live since 21 Nov 2026; the allow-list since 01:26 VN that day.

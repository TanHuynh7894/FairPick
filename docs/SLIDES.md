# FairPick: slide outline (10 slides)

Text ready to paste. Numbers are from the README and the Fuji deployment of 19 Nov 2026.

## 1. Title
**FairPick**
Which receipts get audited, picked by a signature nobody can choose.
Team1 Vietnam UniHack 2026 · Avalanche · TSC-teamsolocode

## 2. The problem
- A club or charity fund keeps dozens of receipts. Nobody checks all of them, so someone picks a few.
- If the treasurer picks, the receipts that would not survive a check stay out of the sample.
- Bank statements are already public: MB's Thiện Nguyện app reports more than 7,750 campaigns and over 2 million users (The Investor, Sept 2025). A statement shows money leaving an account, not what it was spent on.

## 3. The solution, in one sentence
The auditor announces the receipt list by its hash, the treasurer requests the sample, and two of three oracle nodes sign a number that decides which receipts get checked, once per list.

## 4. How it works (diagram)
Auditor → `announce(hash, count, sample, treasurer)` → AuditSampler
Treasurer → `requestAudit(hash, auditor)` + 0.01 AVAX → AuditSampler → RandomnessOracle
Nodes (any 2 of 3) → sign the request, including the request block's hash → `fulfill` → pairing check on chain → number → receipts
Browser → repeats the pairing check, the hash check and the pick, with no server in between

Use the sequence diagram in the README, "How it works".

## 5. Demo screenshots
- `docs/img/d-audits.jpg`: "Receipts to check · 4 of 35" with item and amount in VND.
- `docs/img/d-verify.jpg`: VALID · MATCH · MATCH, signed by key shares 1 and 2, AUDITOR RESULT · 4 OF 4 FOUND.
- `docs/img/d-refused.jpg`: ALREADY DRAWN · AUDIT #5.

## 6. Why on chain, why Avalanche (measured)
- On chain: the list's hash is fixed before the sample, the contract checks the signature, one sample per list, and nobody can edit the record afterwards.
- An accepted Avalanche block is final in about a second, so the request's block hash can be signed at once. Measured on Fuji: answers 3 to 6 blocks after the request, 5.4 to 7.2 s, with all nodes up.
- The on-chain check of an answer was charged 226,318 to 235,555 gas: 0.0017 AVAX at today's mainnet base fee of 7.5 nAVAX.
- The page reads through the Avalanche Data API. The contracts need only precompiles 0x05 to 0x08, so they run on an Avalanche L1, where Chainlink VRF is not offered. Our own L1 `fairpick` (chainId 510103) now gets its audit samples from the Fuji oracle over ICM, request and answer both executed on 21 Nov; the L1 re-checks the BLS signature itself.

## 7. Where the money comes from
- The requester pays a flat oracle fee: 0.01 AVAX on testnet, about six times the answer's gas.
- The fee goes to the operator and pays the nodes' gas. No token, no yield, no fundraising.
- A real service would bill funds in VND, off chain. Not validated with any customer yet.

## 8. Vietnamese law
- Decree 93/2021/NĐ-CP: individuals raising voluntary contributions open a separate account per campaign (Art. 17.2); organisations and individuals publish receipts and spending (Arts. 14, 19). FairPick supports an audit. It does not replace those duties.
- Crypto is not a lawful means of payment in Vietnam (State Bank of Vietnam). FairPick pays for no goods or wages in AVAX; amounts in receipts are in VND; fees run on testnet only.
- Receipts stay in the browser. On chain: a hash, counts, a short public name (Personal Data Protection Law 91/2025/QH15).
- Audit sampling only: nobody is paid for being picked. A pick decides what an auditor looks at. The same oracle can pick a committee or jury (Group pick, built) or assign tasks (not built).
- Compared with: Chainlink VRF (strong, but C-Chain only, no Avalanche L1), drand (BLS12-381 by default; C-Chain has no precompile for it), RANDAO (`block.prevrandao` is the constant 1 on Avalanche).

## 9. What is mock, and the limits
- Fuji testnet. All wallets are the team's. Receipt lists and auditor results are invented.
- Three node processes on one laptop. The key was split by one dealer; no distributed key generation.
- The recording signs with two Fuji test keys in the dev server, so no wallet popup is filmed.
- The announcement is only as good as the auditor's independence. A sample is not an audit: FairPick fixes which receipts get looked at, not whether they are genuine.
- Contracts not audited.

## 10. Team, links, contracts
- TSC (Team Solo Code)
- Repo: https://github.com/TSC-teamsolocode/randomness
- RandomnessOracle `0xa4c1019b76EE5bEB9aFe641AAcf164b787b037Dd`
- AuditSampler `0x415eaC3a64111E68DB8136660CD7Ff06F9F4f654`
- RandomnessBeacon `0x60198D44a183d313B5EAa432F85D184cab9F217C`
- All verified on Routescan (testnet.snowtrace.io)

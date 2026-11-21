# Demo flows

Record on Fuji, against the live contracts in the README. The local demo has background traffic and made-up list names, which reads badly on camera.

## Recording settings

- Browser viewport 1280×720 at device scale factor 1.5, so the video is 1920×1080. Playwright: `newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, recordVideo: { dir, size: { width: 1920, height: 1080 } } })`.
- Captions are burned in as a bottom bar: the recording script overlays them on the page (a fixed `div` at the bottom, 28 px white text on a black bar, set with `page.evaluate` before each beat), so they are part of every frame. One caption per beat, as written below.
- Verdicts on screen are at least 18 px: the refusal banners (FILE CHANGED, ALREADY DRAWN, NOT ANNOUNCED) and the AUDITOR RESULT banner are full-width with 20 px titles (about 30 px in the 1080p video) and 15 px text; the latest audit's receipt rows are 18 px with 21 px numbers. Do not zoom out.
- Nothing outside the app on camera except two explorer shots of at most 4 s each. No file picker: lists come from the `Example lists…` menu. No wallet popup: the dev server signs with the two Fuji test keys from `dashboard/.env.local`, labelled `TREASURER · TEST KEY` and `AUDITOR · TEST KEY` in the sign-in sheet. No terminal.
- Silent. Total 2:10 to 2:40.

## Pre-record checklist

```sh
./scripts/fuji-nodes.sh                          # off camera, in its own terminal: the three nodes
./scripts/pre-record.sh                          # checks and restages everything below; must end with "ready to record"
cd dashboard && npm run dev -- --port 5174       # restart after pre-record.sh, so the page picks up .env.local
```

What `pre-record.sh` checks, and fixes where it can:
1. Nodes 1 to 3 answer on ports 8701 to 8703.
2. Each node wallet and the auditor wallet hold more than 0.0001 AVAX (one answer costs about 0.00000004 AVAX on Fuji).
3. The treasurer `0x7588…Fd95` holds one fee (0.01 AVAX) plus gas. If not, it calls `withdraw()` on the oracle and tops the treasurer up from the operator wallet.
4. The list for the request beat, `examples/receipts-clb-sach-quy-3.csv` (20 receipts, sample 3), is announced by the auditor `0xE46D…3183` for the treasurer and not drawn yet. If it is not announced, the script announces it.
5. Writes `VITE_NODE_URLS`, `VITE_AUDITOR` and `VITE_TEST_KEYS` to `dashboard/.env.local` (mode 600, git-ignored). The keys come from `.env.demo`, also git-ignored. They are Fuji test keys, read by the dev server only; `npm run build` refuses to run while they are set.

After a take that sent the request, that list is used up. Restage with a spare and pick that name in the menu next take:

```sh
LIST=examples/receipts-clb-bong-ro-mua-giai-2026.csv ./scripts/pre-record.sh        # "CLB Bóng rổ · mùa giải 2026", 16 receipts
LIST=examples/receipts-hoi-sinh-vien-kinh-te-thang-11.csv ./scripts/pre-record.sh   # "Hội sinh viên Kinh tế · tháng 11", 22 receipts
```

After recording: `./scripts/pre-record.sh --clean` removes the test keys from `dashboard/.env.local`.

On screen before the first frame: `http://127.0.0.1:5174/#oracle`, signed out, the latest audit is #5 (Quỹ từ thiện Ấm Áp, 4 of 35). Two tabs prepared for the explorer shots: the answer transaction of the new audit (open it from the sheet's `Answer tx` link during the take) and the refused stranger request [0x8b00740f…](https://testnet.snowtrace.io/tx/0x8b00740f870ef3c2f8f15a81bc87f5390c1abce1da8a4c8e69b6346eadd3709e).

## Video: beats and captions (about 2:34)

| Time | On screen | Clicks | Caption |
|---|---|---|---|
| 0:00 | Audits page, latest audit with its receipt rows | 0 | Fuji testnet. Team wallets, invented receipts, three nodes on one laptop. Nobody wins anything. |
| 0:08 | Hold on the four rows: number, item, amount in VND | 0 | 35 receipts, 4 get checked. Who picks them? Not the treasurer. |
| 0:18 | `SIGN IN` → `TREASURER · TEST KEY`. `NEW AUDIT` → `Example lists…` → `CLB Sách · quý 3`. Hash, "20 receipts" and ANNOUNCED BY THE AUDITOR appear | 4 | The auditor locked this list by its hash and named this wallet. |
| 0:36 | `REQUEST · 0.01 AVAX`. "Waiting for the signature", then the three rows | 1 | Two of three nodes sign. About six seconds. |
| 0:55 | `VERIFY` → `VERIFY SIGNATURE`: VALID, MATCH, MATCH, "Signed by key shares 1 and 2" | 2 | Your browser repeats the contract's check. |
| 1:12 | Same sheet, `Example lists…` → `CLB Sách · quý 3 (one amount edited)`: FILE CHANGED banner | 1 | Change one amount and it shows. |
| 1:25 | `CLOSE`, `NEW AUDIT`, the same list: ALREADY DRAWN · AUDIT #6 banner | 3 | Ask again? The contract refuses. |
| 1:38 | Explorer tab, 4 s: the stranger's request, status Fail | 0 | A stranger tried to draw an announced list. Refused on chain. |
| 1:42 | Back in the app: `SIGN OUT`, `SIGN IN` → `AUDITOR · TEST KEY`, `VERIFY` on the new audit: "You are the auditor" | 3 | The auditor checks the three receipts. |
| 1:55 | `RECORD · 3 OF 3 FOUND`: AUDITOR RESULT · 3 OF 3 FOUND banner | 1 | The result goes on chain too. |
| 2:05 | `Answer tx` link → explorer, 4 s: success, gas used | 1 | About 230k gas charged. 0.0017 AVAX at mainnet price. |
| 2:09 | Back in the app: `GROUP PICK`, round 0, SEED READY, 3/3 members | 1 | No oracle? A committee makes the seed. |
| 2:20 | `AUDITS`, scroll to the bottom: oracle and sampler addresses, "any 2 of 3 key shares" | 1 | Live on Avalanche Fuji. Audit sampling only. |
| 2:34 | End | | |

Optional, if a take has time to spare: stop node 1 off camera before the 0:36 beat (`kill $(cat logs/node1.pid)`). The answer then takes about 4 s longer and the sheet says "Signed by key shares 2 and 3". Caption: "Node 1 is off. Two others still sign." Start it again with `ONLY=1 ./scripts/fuji-nodes.sh` afterwards.

The full sequence runs headless with Playwright and the test keys; a dry run on 19 Nov produced audit #5 this way (5.8 s from request to answer).

## The same flows, step by step

### 1. See a pick and verify it
URL: `#oracle`
1. Latest audit: "RECEIPTS TO CHECK · 4 OF 35", list name, one row per picked receipt with item and amount, and "announced by auditor 0xE46D…".
2. `All audits` table: list, receipts to check, time, status (PICKED, ALL FOUND, RECEIPT MISSING).
3. `VERIFY` on the latest audit, or click a row. The sheet shows the picked rows, `LIST MATCHES`, who announced the list (`AUDITOR, BEFORE THE DRAW`), `DRAWN ONCE`, "Audits by this wallet", "Lists this auditor announced", and the auditor's result if recorded.
4. `VERIFY SIGNATURE` → "Nobody chose these receipts." and `VALID` (BLS pairing), `MATCH` (keccak of the signature), `MATCH` (receipts recomputed from the number). With the nodes reachable: "Signed by key shares 1 and 2", checked against the share keys in the oracle.
5. `DOWNLOAD CSV` saves the committed bytes. `COPY LINK` gives `…/#oracle/5`.
6. A copy somebody was sent: drop it on the sheet, or `CHECK A FILE`, or pick it in `Example lists…`. A changed copy shows FILE CHANGED.

### 2. Announce, then request
1. Auditor: `SIGN IN`, `NEW AUDIT` → `I AM THE AUDITOR`. Choose the list, the sample size and the treasurer's wallet → `ANNOUNCE THIS LIST`.
2. Treasurer: `SIGN IN`, `NEW AUDIT` → `I HOLD THE FUND`. Choose the same list. The auditor's address is filled in. ANNOUNCED BY THE AUDITOR with the count and sample size.
3. `REQUEST · 0.01 AVAX`. The top of the page shows "Waiting for the signature", then the picked rows, in about 6 s.
4. The same list again: ALREADY DRAWN · AUDIT #N and `OPEN AUDIT #N`. A list nobody announced: NOT ANNOUNCED. A list announced for someone else: NOT ANNOUNCED FOR THIS WALLET.
5. Auditor: open the audit, mark any receipt not found, `RECORD`. The audit reads ALL FOUND or RECEIPT MISSING.

### 3. Group pick (no node)
URL: `#beacon`
1. `NEW ROUND`: join 1 min, reveal 1 min, deposit, min members 2. Optional: paste member addresses, one per line.
2. Open the round → `JOIN · <deposit>` with each member wallet. A wallet that is not on the list is told so.
3. After the join time: `REVEAL` with each wallet.
4. `FINALIZE` → `SEED READY` and the seed. "From this seed, pick 3 of 12" turns it into committee members.
5. `CLAIM <deposit>`.

On Fuji, round 0 is a finished round of three listed members.

### 4. Account, Developer, Admin
- `#account`: my audits with their picks, refunds, my group picks.
- `#developer`: follow a consumer contract, every number the oracle has answered, a sample consumer contract (`COPY`), a command line for `request-audit.sh`.
- `#admin` (operator wallet; the tab shows only for it): fees to withdraw, profit per answer, books `BALANCED`, node wallets, how the key is split.

### Local, with sample data

```sh
DASHBOARD_PORT=5174 ./scripts/dashboard-demo.sh      # anvil, 3 nodes, background audits; http://127.0.0.1:5174
```

The sign-in sheet lists 10 dev accounts; the one tagged `OPERATOR` opens Admin.

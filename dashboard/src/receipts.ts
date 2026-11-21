// Receipt lists stay in the browser. Only their hash and their count go on chain, so the page keeps the text by hash
// to show which receipts were picked, and anyone with the same file can check it is the list that was committed to.
import type { Hex } from 'viem';
import { canonicalList, commitmentFor, describeList, hashList, parseCsv, type ReceiptList } from '../../node/src/list';
import sampleCsv from '../../examples/receipts-clb-tinh-nguyen-q3-2026.csv?raw';
import classCsv from '../../examples/receipts-quy-lop-k66-thang-10.csv?raw';
import campCsv from '../../examples/receipts-doan-khoa-cntt-hoi-trai.csv?raw';
import guitarCsv from '../../examples/receipts-clb-guitar-hoc-ky-1.csv?raw';
import bookCsv from '../../examples/receipts-clb-sach-quy-3.csv?raw';
import charityCsv from '../../examples/receipts-quy-tu-thien-am-ap-dot-3.csv?raw';
import editedCsv from '../../examples/edited-receipts-clb-sach-quy-3.csv?raw';
import ballCsv from '../../examples/receipts-clb-bong-ro-mua-giai-2026.csv?raw';
import economicsCsv from '../../examples/receipts-hoi-sinh-vien-kinh-te-thang-11.csv?raw';

export { canonicalList, commitmentFor, describeList, hashList, parseCsv, type ReceiptList };


export const SAMPLE = { name: 'CLB Tình nguyện · Q3/2026', csv: sampleCsv };

/** The invented lists from examples/, so a list can be tried without a file. The last is a tampered copy. */
export const EXAMPLES = [
  { name: 'CLB Sách · quý 3', csv: bookCsv },
  { name: 'Quỹ từ thiện Ấm Áp · đợt 3', csv: charityCsv },
  { name: 'CLB Bóng rổ · mùa giải 2026', csv: ballCsv },
  { name: 'Hội sinh viên Kinh tế · tháng 11', csv: economicsCsv },
  SAMPLE,
  { name: 'Quỹ lớp K66 · tháng 10', csv: classCsv },
  { name: 'Đoàn khoa CNTT · Hội trại', csv: campCsv },
  { name: 'CLB Guitar · học kỳ 1', csv: guitarCsv },
  { name: 'CLB Sách · quý 3 (one amount edited)', csv: editedCsv },
];

const key = (fileHash: Hex) => `fairpick:list:${fileHash.toLowerCase()}`;
const MAX_STORED = 256_000;

// The example lists from examples/ are built in, so their audits show receipts without loading a file.
const memory = new Map<string, string>([sampleCsv, classCsv, campCsv, guitarCsv, bookCsv, charityCsv, ballCsv, economicsCsv].map((csv) => [hashList(csv).toLowerCase(), canonicalList(csv)]));

/** Keeps the canonical text under its file hash, in this browser only. */
export function storeList(text: string): Hex {
  const canonical = canonicalList(text);
  const fileHash = hashList(canonical);
  if (canonical.length <= MAX_STORED) {
    try {
      localStorage.setItem(key(fileHash), canonical);
    } catch {
      // Private mode or full storage: the list is only shown for this visit.
    }
  }
  memory.set(fileHash.toLowerCase(), canonical);
  return fileHash;
}

/** The canonical text of a list this browser holds: exactly the bytes whose hash was committed. */
export function listText(fileHash: Hex): string | null {
  const known = memory.get(fileHash.toLowerCase());
  if (known !== undefined) return known;
  try {
    return localStorage.getItem(key(fileHash));
  } catch {
    return null;
  }
}

export function loadList(fileHash: Hex): ReceiptList | null {
  const text = listText(fileHash);
  return text === null ? null : parseCsv(text);
}

export type ListMatch =
  | { kind: 'match' }
  /** The bytes are the committed ones, but the file holds another number of receipts than the audit declared. */
  | { kind: 'count'; rows: number }
  | { kind: 'different' };

/** Does this file stand behind the audit's commitment, which covers the file hash and the receipt count together? */
export function matchList(text: string, audit: { fileHash: Hex; itemCount: number }): ListMatch {
  const file = describeList(text);
  if (file.commitment === commitmentFor(audit.fileHash, audit.itemCount)) return { kind: 'match' };
  return file.fileHash.toLowerCase() === audit.fileHash.toLowerCase() ? { kind: 'count', rows: file.itemCount } : { kind: 'different' };
}

const ITEM = /item|description|content|detail|nội dung|noi dung|khoản|khoan|diễn giải|dien giai/i;
const AMOUNT = /amount|vnd|số tiền|so tien|thành tiền|thanh tien/i;

/** Which column says what was bought and which says how much, by header name, or else a guess from the first row. */
export function receiptColumns(list: ReceiptList): { item: number; amount: number } {
  const item = list.header.findIndex((h) => ITEM.test(h));
  const amount = list.header.findIndex((h) => AMOUNT.test(h));
  const first = list.rows[0] ?? [];
  const longest = first.reduce((best, cell, i) => (/^[\d\s.,-]*$/.test(cell) || cell.length <= (first[best]?.length ?? -1) ? best : i), -1);
  return { item: item >= 0 ? item : longest, amount };
}

/** One picked receipt in two fields, for places with no room for the whole row. */
export function receiptSummary(list: ReceiptList, receiptNo: number): { item: string; amount: number | null } | null {
  const row = list.rows[receiptNo - 1];
  if (!row) return null;
  const { item, amount } = receiptColumns(list);
  const digits = amount >= 0 ? (row[amount] ?? '').replace(/[\s.,]/g, '') : '';
  return { item: item >= 0 ? row[item] ?? '' : '', amount: /^\d+$/.test(digits) ? Number(digits) : null };
}

/** Saves the committed bytes as a file, so an auditor can be sent exactly what was hashed. */
export function downloadList(fileHash: Hex, name: string): boolean {
  const text = listText(fileHash);
  if (text === null) return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

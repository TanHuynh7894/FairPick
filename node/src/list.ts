// A receipt list as FairPick commits to it. Shared by the page and the command line, so both get the same hash.
import { encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';

export interface ReceiptList {
  header: string[];
  rows: string[][];
}

/**
 * The bytes that get hashed. The same list saved by different programs differs in ways nobody sees: Excel puts a
 * byte-order mark in front and ends lines with CRLF, editors add or drop the last newline. Those are removed, and
 * nothing else: a changed character inside the list is a different list.
 */
export function canonicalList(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

/** keccak256 of the canonical bytes, as UTF-8. This is `fileHash` in AuditSampler. */
export const hashList = (text: string): Hex => keccak256(toBytes(canonicalList(text)));

/** AuditSampler.commitment: the file hash and the receipt count as one value. */
export const commitmentFor = (fileHash: Hex, itemCount: number): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [fileHash, itemCount]));

/** Comma, semicolon or tab, whichever the header line uses most. Excel picks by the computer's region. */
function delimiterOf(text: string): string {
  const firstLine = text.slice(0, (text.search(/[\r\n]/) + 1 || text.length + 1) - 1);
  const count = (c: string) => firstLine.split(c).length - 1;
  return [',', ';', '\t'].reduce((best, c) => (count(c) > count(best) ? c : best));
}

/**
 * Enough CSV for exported spreadsheets: quoted fields with separators, line breaks or doubled quotes, CRLF or LF.
 * The first line is the header, and every later line that is not blank is one receipt: that count is `itemCount`.
 */
export function parseCsv(input: string): ReceiptList {
  const text = canonicalList(input);
  const delimiter = delimiterOf(text);
  const lines: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') {
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) lines.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) lines.push(row);
  const [header = [], ...rows] = lines;
  return { header, rows };
}

/** Everything the contract is given about a list, from the file alone. */
export function describeList(text: string) {
  const fileHash = hashList(text);
  const itemCount = parseCsv(text).rows.length;
  return { fileHash, itemCount, commitment: commitmentFor(fileHash, itemCount) };
}

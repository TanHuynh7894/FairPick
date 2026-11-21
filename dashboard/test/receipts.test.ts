import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalList, commitmentFor, describeList, hashList, listText, loadList, matchList, parseCsv, receiptColumns, receiptSummary, SAMPLE, storeList } from '../src/receipts';

const SAMPLE_HASH = '0xb54d0d8ecdc16be01c8e274c34105c35bd8e7ff30edf8230d47ba9c579b77457';
const PLAIN = 'no,item,amount_vnd\n1,"Gạo, 50 kg",900000\n2,Áo ấm,4800000';
const bytes = (text: string) => [...new TextEncoder().encode(text)];

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes, CRLF and blank lines', () => {
    const list = parseCsv('no,item,amount\r\n1,"Gạo, 50 kg",900000\r\n\r\n2,"Áo ""ấm""",4800000\n');
    expect(list.header).toEqual(['no', 'item', 'amount']);
    expect(list.rows).toEqual([['1', 'Gạo, 50 kg', '900000'], ['2', 'Áo "ấm"', '4800000']]);
  });
  it('keeps a line break inside a quoted field in that field', () => {
    expect(parseCsv('no,item\n1,"two\nlines"\n2,x').rows).toEqual([['1', 'two\nlines'], ['2', 'x']]);
  });
  it('reads semicolon and tab files, which Excel writes in regions that use a decimal comma', () => {
    expect(parseCsv('no;item;amount\n1;"Gạo; 50 kg";900000\n2;Áo ấm;4800000').rows).toEqual([['1', 'Gạo; 50 kg', '900000'], ['2', 'Áo ấm', '4800000']]);
    expect(parseCsv('no\titem\n1\tGạo, 50 kg').rows).toEqual([['1', 'Gạo, 50 kg']]);
  });
});

describe('the list hash', () => {
  it('is pinned for the example list', () => {
    // npm run list-hash -- ../examples/receipts-clb-tinh-nguyen-q3-2026.csv  (in node/)
    expect(hashList(SAMPLE.csv)).toBe(SAMPLE_HASH);
    expect(describeList(SAMPLE.csv)).toEqual({ fileHash: SAMPLE_HASH, itemCount: 40, commitment: commitmentFor(SAMPLE_HASH, 40) });
  });

  it('is the same for the file as Excel saves it: byte-order mark, CRLF, a last empty line', () => {
    const excel = `﻿${PLAIN.replace(/\n/g, '\r\n')}\r\n`;
    expect(bytes(excel).slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
    expect(hashList(excel)).toBe(hashList(PLAIN));
    expect(describeList(excel)).toEqual(describeList(PLAIN));
  });

  it('is the same with or without the last newline, with old Mac line ends, and after a round trip through Excel', () => {
    expect(hashList(`${PLAIN}\n`)).toBe(hashList(PLAIN));
    expect(hashList(`${PLAIN}\n\n\n`)).toBe(hashList(PLAIN));
    expect(hashList(PLAIN.replace(/\n/g, '\r'))).toBe(hashList(PLAIN));
    // The example as a Windows spreadsheet would export it.
    const exported = `﻿${canonicalList(SAMPLE.csv).replace(/\n/g, '\r\n')}\r\n`;
    expect(hashList(exported)).toBe(SAMPLE_HASH);
    expect(parseCsv(exported).rows).toHaveLength(40);
  });

  it('is the hash of exactly the canonical bytes, so the committed file can be handed over and re-hashed', () => {
    const canonical = canonicalList(`﻿${PLAIN}\r\n`);
    expect(canonical).toBe(PLAIN);
    expect(canonicalList(canonical)).toBe(canonical);
    // The example file on disk differs from its canonical form only by the newline at its end.
    const onDisk = readFileSync(new URL('../../examples/receipts-clb-tinh-nguyen-q3-2026.csv', import.meta.url), 'utf8');
    expect(onDisk).toBe(`${canonicalList(onDisk)}\n`);
  });

  it('changes when anything inside the list changes', () => {
    expect(hashList(PLAIN.replace('900000', '900001'))).not.toBe(hashList(PLAIN));
    expect(hashList(PLAIN.replace('Áo ấm', 'Áo ấm '))).not.toBe(hashList(PLAIN));
    expect(hashList(PLAIN.replace('\n2,', '\n\n2,'))).not.toBe(hashList(PLAIN));
  });
});

describe('matching a file against an audit', () => {
  const audit = { fileHash: hashList(PLAIN), itemCount: 2 };
  it('accepts the committed list however it was saved', () => {
    expect(matchList(`﻿${PLAIN.replace(/\n/g, '\r\n')}\r\n`, audit)).toEqual({ kind: 'match' });
  });
  it('tells a count that was declared too low from a different file', () => {
    // The treasurer sent the right bytes but said 1 receipt, so receipt 2 could never be picked.
    expect(matchList(PLAIN, { ...audit, itemCount: 1 })).toEqual({ kind: 'count', rows: 2 });
    expect(matchList(PLAIN.replace('900000', '100000'), audit)).toEqual({ kind: 'different' });
  });
  it('binds the count into the commitment', () => {
    expect(commitmentFor(audit.fileHash, 2)).not.toBe(commitmentFor(audit.fileHash, 3));
    expect(commitmentFor(audit.fileHash, 2)).toBe(describeList(PLAIN).commitment);
  });
});

describe('receipt lists in the browser', () => {
  it('finds a stored list by its hash, as canonical text, and nothing for an unknown hash', () => {
    const hash = storeList('﻿no,item\r\n1,test\r\n');
    expect(hash).toBe(hashList('no,item\n1,test'));
    expect(listText(hash)).toBe('no,item\n1,test');
    expect(loadList(hash)?.rows).toEqual([['1', 'test']]);
    expect(loadList(`0x${'11'.repeat(32)}`)).toBeNull();
  });
  it('has the example lists built in', () => {
    expect(loadList(SAMPLE_HASH)?.rows).toHaveLength(40);
  });
});

describe('a picked receipt in words', () => {
  const list = parseCsv(SAMPLE.csv);
  it('finds the item and amount columns by their headers', () => {
    expect(receiptColumns(list)).toEqual({ item: 2, amount: 3 });
    expect(receiptSummary(list, 4)).toEqual({ item: 'Thuê xe 29 chỗ Hà Nội – Hà Giang', amount: 6500000 });
  });
  it('reads amounts written with separators, and gives no amount when there is none', () => {
    expect(receiptSummary(parseCsv('stt;nội dung;số tiền\n1;Thuê xe;6.500.000'), 1)).toEqual({ item: 'Thuê xe', amount: 6500000 });
    expect(receiptSummary(parseCsv('a,b\n1,Thuê xe'), 1)).toEqual({ item: 'Thuê xe', amount: null });
  });
  it('gives nothing for a receipt number the file does not have', () => {
    expect(receiptSummary(list, 41)).toBeNull();
  });
});

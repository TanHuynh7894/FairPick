// Prints what FairPick commits to for a receipt list: npm run list-hash -- ../examples/receipts-....csv
import { readFileSync } from 'node:fs';
import { describeList } from '../src/list';

const path = process.argv[2];
if (!path) throw new Error('usage: list-hash <file.csv>');
const { fileHash, itemCount, commitment } = describeList(readFileSync(path, 'utf8'));
console.log(`file hash   ${fileHash}`);
console.log(`receipts    ${itemCount}`);
console.log(`commitment  ${commitment}`);

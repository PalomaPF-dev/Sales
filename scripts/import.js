// 現行管理表(Excel)のCLI取込: npm run import -- <file1.xlsx> [file2.xlsx ...] [--replace]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import { importWorkbook } from '../server/importer.js';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('使い方: npm run import -- <管理表.xlsx> [追加ファイル...] [--replace]');
  process.exit(1);
}

if (replace) {
  db.exec('DELETE FROM application_items; DELETE FROM approvals; DELETE FROM applications; DELETE FROM deals; DELETE FROM import_batches;');
  console.log('既存の案件データを削除しました。');
}

for (const f of files) {
  const buf = readFileSync(f);
  const { batchId, count } = importWorkbook(buf, path.basename(f), null);
  console.log(`取込完了: ${path.basename(f)} → ${count}行 (batch #${batchId})`);
}

const total = db.prepare('SELECT COUNT(*) AS c FROM deals').get().c;
console.log(`deals 合計: ${total}行`);

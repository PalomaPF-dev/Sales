// 現行管理表(Excel)のCLI取込
//   ローカル: npm run import -- <file1.xlsx> [file2.xlsx ...] [--replace]
//   Turso本番: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を設定して同じコマンドを実行
//
// ※ Vercelのサーバーレス関数はリクエストボディに上限（約4.5MB）があるため、
//    数MB規模の管理表は画面アップロードではなくこのCLIから投入してください。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { db, initDb, isTurso } from '../server/db.js';
import { importWorkbook } from '../server/importer.js';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('使い方: npm run import -- <管理表.xlsx> [追加ファイル...] [--replace]');
  process.exit(1);
}

await initDb();
console.log(`接続先: ${isTurso ? 'Turso (' + process.env.TURSO_DATABASE_URL + ')' : 'ローカルSQLite'}`);

if (replace) {
  for (const sql of [
    'DELETE FROM application_items', 'DELETE FROM approvals', 'DELETE FROM applications',
    'DELETE FROM deals', 'DELETE FROM import_batches',
  ]) {
    await db.run(sql);
  }
  console.log('既存の案件データを削除しました。');
}

for (const f of files) {
  const name = path.basename(f);
  const buf = readFileSync(f);
  process.stdout.write(`取込中: ${name} ... `);
  const { batchId, count } = await importWorkbook(buf, name, null, (n) => {
    process.stdout.write(`\r取込中: ${name} ... ${n.toLocaleString()}行`);
  });
  console.log(`\r取込完了: ${name} → ${count.toLocaleString()}行 (batch #${batchId})          `);
}

const { c } = await db.get('SELECT COUNT(*) AS c FROM deals');
console.log(`deals 合計: ${Number(c).toLocaleString()}行`);
db.close?.();

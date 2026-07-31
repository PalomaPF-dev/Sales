// DBバックアップ
//   ローカルSQLite: VACUUM INTO でアプリを止めずに一貫性のあるコピーを作成
//   Turso        : 全テーブルをJSONへエクスポート（Turso自体のPITRとは別の論理バックアップ）
//
//   npm run backup [出力先ディレクトリ]
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] || process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14); // 保持世代数

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const TABLES = ['price_types', 'users', 'settings', 'approval_rules', 'import_batches',
  'deals', 'applications', 'application_items', 'approvals'];

let dest;
if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  const { db, initDb } = await import('../server/db.js');
  await initDb();
  const dump = { exportedAt: new Date().toISOString(), source: 'turso', tables: {} };
  for (const t of TABLES) {
    dump.tables[t] = await db.all(`SELECT * FROM ${t}`);
    console.log(`  ${t}: ${dump.tables[t].length.toLocaleString()}行`);
  }
  dest = path.join(OUT_DIR, `app-${stamp}.json`);
  writeFileSync(dest, JSON.stringify(dump));
  db.close?.();
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  dest = path.join(OUT_DIR, `app-${stamp}.db`);
  const raw = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });
  raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  raw.close();
}

console.log(`バックアップを作成しました: ${dest} (${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);

// 古い世代を削除
const files = readdirSync(OUT_DIR)
  .filter((f) => f.startsWith('app-') && (f.endsWith('.db') || f.endsWith('.json')))
  .sort()
  .reverse();
for (const f of files.slice(KEEP)) {
  unlinkSync(path.join(OUT_DIR, f));
  console.log(`古いバックアップを削除しました: ${f}`);
}

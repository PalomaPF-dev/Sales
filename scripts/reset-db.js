// DBを初期化（データ削除→マスタ再seed）
//   ローカル: npm run reset-db      … DBファイルごと削除して作り直す
//   本番(PG) : npm run reset-db      … 全テーブルの中身を削除して再seed
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  const { db, initDb } = await import('../server/db.js');
  await initDb();
  for (const sql of [
    'DELETE FROM application_items', 'DELETE FROM approvals', 'DELETE FROM applications',
    'DELETE FROM deals', 'DELETE FROM import_batches',
    'DELETE FROM approval_rules', 'DELETE FROM settings', 'DELETE FROM users', 'DELETE FROM price_types',
  ]) {
    await db.run(sql);
  }
  // seedを再実行するためモジュールキャッシュを迂回して初期化し直す
  const fresh = await import(`../server/db.js?reset=${Date.now()}`);
  await fresh.initDb();
  console.log('PostgreSQL のDBを初期化しました。');
  db.close?.();
} else {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  for (const f of ['app.db', 'app.db-wal', 'app.db-shm']) {
    rmSync(path.join(DATA_DIR, f), { force: true });
  }
  const { initDb } = await import('../server/db.js');
  await initDb();
  console.log('ローカルDBを初期化しました。');
}

// DBを初期化（データ削除→マスタ再seed）: npm run reset-db
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
for (const f of ['app.db', 'app.db-wal', 'app.db-shm']) {
  rmSync(path.join(DATA_DIR, f), { force: true });
}
await import('../server/db.js');
console.log('DBを初期化しました。');

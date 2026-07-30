// ローカル / コンテナ / systemd での起動エントリポイント
import { createApp } from './app.js';
import { initDb, db } from './db.js';

await initDb();

const app = createApp({ serveStatic: true });
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log(`起動しました: http://${host}:${port}（DB: ${db.kind}）`);
  if (!process.env.BASIC_AUTH_USER) {
    console.warn('警告: BASIC_AUTH_USER/PASS が未設定です。公開環境ではアクセス保護を設定してください。');
  }
});

// コンテナ環境での安全な停止
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} を受信しました。停止します。`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}

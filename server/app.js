// Expressアプリの組み立て。
// ローカル/コンテナは server/index.js から、Vercelは api/index.js から読み込まれる。
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api } from './api.js';
import { basicAuth, securityHeaders } from './auth.js';
import { db, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ serveStatic = true } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true); // リバースプロキシ / Vercel 配下での運用を想定
  app.use(securityHeaders);

  // 監視用（認証不要・DB接続まで確認）
  app.get('/api/health', async (req, res) => {
    try {
      await initDb();
      const row = await db.get('SELECT COUNT(*) AS deals FROM deals');
      res.json({
        status: 'ok',
        db: db.kind,
        deals: Number(row.deals),
        uptime: Math.round(process.uptime()),
      });
    } catch (e) {
      res.status(503).json({ status: 'error', error: e.message });
    }
  });

  app.use(basicAuth);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', api);

  // ビルド済みフロントエンド（client/dist）を配信。
  // Vercelでは静的ファイルをCDNが直接返すため serveStatic=false で読み込まない。
  if (serveStatic) {
    const dist = path.join(__dirname, '..', 'client', 'dist');
    if (existsSync(dist)) {
      app.use(express.static(dist, { maxAge: '1h', index: false }));
      app.use((req, res, next) => {
        if (req.method === 'GET' && !req.path.startsWith('/api')) {
          return res.sendFile(path.join(dist, 'index.html'));
        }
        next();
      });
    } else {
      console.warn('client/dist が見つかりません。`npm run build` を実行してください。');
    }
  }

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'サーバーエラー' });
  });

  return app;
}

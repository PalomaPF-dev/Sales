// Vercel Functions のエントリポイント。
// vercel.json のリライトにより /api/* のリクエストがここに集約される。
// 静的ファイル（client/dist）はVercelのCDNが直接配信するため serveStatic は無効。
import { createApp } from '../server/app.js';

export default createApp({ serveStatic: false });

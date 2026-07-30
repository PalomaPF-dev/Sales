import { timingSafeEqual } from 'node:crypto';

// 公開環境に置く際のアクセス保護。
// BASIC_AUTH_USER / BASIC_AUTH_PASS が設定されている場合のみ有効になり、
// 未設定（社内ネットワーク限定など）では素通しする。
// ※これはアプリ全体への入口を塞ぐ簡易保護であり、
//   個人単位の認証（SSO等）の代替ではない。
export function basicAuth(req, res, next) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();

  // ヘルスチェックは監視サービスから認証なしで到達できる必要がある
  if (req.path === '/api/health') return next();

  const header = req.header('authorization') || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep >= 0 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), pass)) {
      return next();
    }
  }
  // realm はHTTPヘッダー値のためASCIIのみ（非ASCIIはNodeがヘッダー設定時に例外を投げる）
  res.set('WWW-Authenticate', 'Basic realm="Sales Pricing System", charset="UTF-8"');
  res.status(401).type('text/plain; charset=utf-8').send('認証が必要です');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
}

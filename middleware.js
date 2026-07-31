// Vercel Edge Middleware
//
// 静的ファイル（HTML/JS/CSS）はVercelのCDNが直接配信するため、
// Express側の認証（server/auth.js）だけでは画面ファイルが保護されない。
// このミドルウェアは静的ファイルを含む全リクエストの手前で動作し、
// アプリ全体を社内限定公開にする。
//
// BASIC_AUTH_USER / BASIC_AUTH_PASS が未設定の場合は素通しする。

export const config = {
  // 全パスに適用（Vercel内部の静的アセットのみ除外）
  matcher: '/((?!_vercel/).*)',
};

export default function middleware(request) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return;

  // 監視サービスから認証なしで到達できる必要がある
  const { pathname } = new URL(request.url);
  if (pathname === '/api/health') return;

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = decodeBase64Utf8(header.slice(6));
    } catch {
      decoded = '';
    }
    const sep = decoded.indexOf(':');
    if (sep >= 0 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), pass)) {
      return;
    }
  }

  return new Response('認証が必要です', {
    status: 401,
    headers: {
      // realm はHTTPヘッダー値のためASCIIのみ
      'WWW-Authenticate': 'Basic realm="Sales Pricing System", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

/**
 * Basic認証の値を復号する。
 *
 * atob はバイト列をそのまま文字コードとして扱うため、
 * 日本語を含むパスワードだと文字化けし、UTF-8として復号するExpress側
 * （server/auth.js）と判定が食い違ってしまう。
 * WWW-Authenticate に charset="UTF-8" を宣言している以上、こちらもUTF-8で読む。
 */
function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// 長さの差で早期returnしないよう、比較回数を揃える
function safeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  let diff = sa.length ^ sb.length;
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

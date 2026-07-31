import { db } from './db.js';
import { generateToken, hashToken } from './passwords.js';

export const COOKIE_NAME = 'sales_session';

// セッションの有効期間（8時間）。業務時間内は再ログイン不要で、放置後は失効する。
const SESSION_HOURS = 8;

const iso = (d) => d.toISOString();

/** ログイン成功時にセッションを作成し、Cookieに入れるトークンを返す */
export async function createSession(userId) {
  const token = generateToken();
  const nowDate = new Date();
  const expires = new Date(nowDate.getTime() + SESSION_HOURS * 3600 * 1000);
  await db.run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)',
    [hashToken(token), userId, iso(nowDate), iso(expires), iso(nowDate)]
  );
  // 期限切れセッションの掃除（頻度は低くてよいので確率的に実行）
  if (Math.random() < 0.05) {
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [iso(nowDate)]).catch(() => {});
  }
  return { token, expires };
}

/** Cookieのトークンからユーザーを引く。無効・期限切れなら null */
export async function resolveSession(token) {
  if (!token) return null;
  const row = await db.get(
    `SELECT s.id AS sid, s.expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    [hashToken(token)]
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.run('DELETE FROM sessions WHERE id = ?', [row.sid]).catch(() => {});
    return null;
  }
  if (!row.active) return null;
  return row;
}

export async function destroySession(token) {
  if (!token) return;
  await db.run('DELETE FROM sessions WHERE id = ?', [hashToken(token)]).catch(() => {});
}

/** パスワード変更時など、そのユーザーの全セッションを無効化する */
export async function destroyUserSessions(userId) {
  await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]).catch(() => {});
}

/** Cookieヘッダーから値を取り出す（cookie-parser を入れずに済ませる） */
export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function setSessionCookie(req, res, token, expires) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',           // JavaScriptから読めないようにする（XSS対策）
    'SameSite=Lax',       // 外部サイトからのCSRFを防ぐ
    `Expires=${expires.toUTCString()}`,
  ];
  if (isSecure(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(req, res) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (isSecure(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

// HTTPS配信かどうか。VercelなどのプロキシではX-Forwarded-Protoを見る。
function isSecure(req) {
  if (process.env.NODE_ENV === 'test') return false;
  const proto = req.headers?.['x-forwarded-proto'];
  if (proto) return String(proto).split(',')[0].trim() === 'https';
  return Boolean(req.secure) || Boolean(process.env.VERCEL);
}

// 送信元IPごとのログイン試行の制限。
//
// 利用者ごとのロック（users.failed_attempts / locked_until）は
// 「1つのアカウントに何度も試す」形を止めるが、
// 「多数のアカウントに1回ずつ試す」形（パスワードスプレー）は
// どのアカウントも上限に達しないため素通しになる。
// 送信元でも数えることでそこを塞ぐ。
//
// サーバーレスではリクエストごとに別プロセスになりメモリを共有できないため、
// 回数はDBに持つ（login_attempts テーブル）。
import { db } from './db.js';

// 数える期間と上限。営業所がまとめて同じグローバルIPから接続する構成でも
// 巻き込まないよう、利用者ごとの上限（5回）よりかなり緩くしてある。
// 30回の失敗は、利用者ごとの上限から見て最低6アカウントが試された状態を意味する。
const WINDOW_MINUTES = Number(process.env.LOGIN_IP_WINDOW_MINUTES || 15);
const MAX_FAILED = Number(process.env.LOGIN_IP_MAX_FAILED || 30);
const LOCK_MINUTES = Number(process.env.LOGIN_IP_LOCK_MINUTES || 15);

const iso = (ms) => new Date(ms).toISOString();

/**
 * 送信元のアドレス。
 *
 * このアプリは trust proxy を有効にしているため、req.ip は
 * X-Forwarded-For の左端＝送信者が自由に書ける値になる。
 * それを数えても1リクエストごとに別IPを名乗られて意味をなさないので、
 * 手前の基盤が必ず上書きするヘッダーを優先する。
 *
 *   x-vercel-forwarded-for : Vercelが設定する（利用者側からは詐称できない）
 *   x-real-ip              : nginx等のリバースプロキシが設定する
 *   socket.remoteAddress   : 直接公開している場合
 *
 * リバースプロキシを挟む自前運用では、そのプロキシが x-real-ip を
 * 必ず上書きする設定になっていることが前提になる。
 */
export function clientIp(req) {
  const first = (v) => (v ? String(Array.isArray(v) ? v[0] : v).split(',')[0].trim() : '');
  const raw = first(req.headers?.['x-vercel-forwarded-for'])
    || first(req.headers?.['x-real-ip'])
    || req.socket?.remoteAddress
    || '';
  // IPv4射影アドレス（::ffff:203.0.113.1）は素のIPv4として扱い、
  // 経路によって別々に数えられてしまうのを防ぐ
  const ip = String(raw).replace(/^::ffff:/i, '').trim().toLowerCase();
  return ip.slice(0, 45);   // IPv6の最大長。想定外に長い値はここで切る
}

/**
 * この送信元が制限中かを返す。制限中なら { retryAfterSec, until }、そうでなければ null。
 *
 * 記録が読めない（テーブルが無い等）ときは制限なしとして扱う。
 * ログインそのものを止めてしまうより、制限が効かない方が影響が小さい。
 */
export async function checkLoginThrottle(scope, req) {
  const ip = clientIp(req);
  if (!ip) return null;
  const row = await db.get(
    'SELECT locked_until FROM login_attempts WHERE scope = ? AND ip = ?', [scope, ip]
  ).catch(() => null);
  if (!row?.locked_until) return null;

  const until = new Date(row.locked_until).getTime();
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  return { retryAfterSec: Math.ceil((until - Date.now()) / 1000), until: row.locked_until };
}

/**
 * 失敗を1回記録する。上限に達したらこの送信元を一定時間止める。
 *
 * 成功しても回数は消さない。消す作りにすると、有効な資格情報を1つ持つ相手が
 * 自分のログインを挟むだけで何度でも数え直せてしまう。
 * 期間（既定15分）が過ぎれば自然に数え直しになる。
 */
export async function recordLoginFailure(scope, req) {
  const ip = clientIp(req);
  if (!ip) return;
  const nowMs = Date.now();

  const row = await db.get(
    'SELECT failed_attempts, window_started_at FROM login_attempts WHERE scope = ? AND ip = ?',
    [scope, ip]
  ).catch(() => null);

  const startedMs = row ? new Date(row.window_started_at).getTime() : NaN;
  const inWindow = Number.isFinite(startedMs) && startedMs > nowMs - WINDOW_MINUTES * 60_000;

  const failed = inWindow ? Number(row.failed_attempts || 0) + 1 : 1;
  const windowStartedAt = inWindow ? row.window_started_at : iso(nowMs);
  const lockedUntil = failed >= MAX_FAILED ? iso(nowMs + LOCK_MINUTES * 60_000) : null;

  await db.run(
    `INSERT INTO login_attempts (scope, ip, failed_attempts, window_started_at, locked_until)
     VALUES (?,?,?,?,?)
     ON CONFLICT (scope, ip) DO UPDATE SET
       failed_attempts = excluded.failed_attempts,
       window_started_at = excluded.window_started_at,
       locked_until = excluded.locked_until`,
    [scope, ip, failed, windowStartedAt, lockedUntil]
  ).catch((e) => {
    console.error('[loginThrottle] 失敗回数を記録できませんでした:', e?.message || e);
  });

  if (lockedUntil) {
    console.warn(
      `[loginThrottle] ${scope}: ${ip} からの失敗が${failed}回に達したため ${lockedUntil} まで停止します`
    );
  }

  // 古い記録の掃除。頻度は低くてよいので確率的に実行する（session.js と同じ考え方）
  if (Math.random() < 0.02) {
    const cutoff = iso(nowMs - Math.max(WINDOW_MINUTES, LOCK_MINUTES) * 60_000);
    await db.run(
      'DELETE FROM login_attempts WHERE window_started_at < ? AND (locked_until IS NULL OR locked_until < ?)',
      [cutoff, iso(nowMs)]
    ).catch(() => {});
  }
}

import { db } from './db.js';

/**
 * 通知。
 * アプリ内通知は常にDBへ記録し、NOTIFY_WEBHOOK_URL が設定されていれば
 * 外部（Teams / Slack 等の Incoming Webhook）にも送る。
 * Webhookの失敗で業務処理を止めないよう、エラーは握りつぶしてログに残す。
 */
export async function notify(userIds, { kind, title, body, link }) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  if (!ids.length) return;

  const now = new Date().toISOString();
  await db.batch(ids.map((userId) => ({
    sql: 'INSERT INTO notifications (user_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?)',
    params: [userId, kind, title, body ?? null, link ?? null, now],
  })));

  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const text = [title, body, link && base ? `${base}${link}` : null].filter(Boolean).join('\n');
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn(`通知Webhookの送信に失敗しました: ${e.message}`);
  }
}

/** 指定した役割のユーザーIDを引く（承認者の宛先解決に使う） */
export async function usersByRole(role, branch) {
  const rows = branch
    ? await db.all('SELECT id FROM users WHERE role = ? AND branch = ? AND active = 1', [role, branch])
    : await db.all('SELECT id FROM users WHERE role = ? AND active = 1', [role]);
  return rows.map((r) => r.id);
}

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

/**
 * その段階を決裁できるユーザーIDを引く。
 * 管理者は権限としては決裁できるが、運用上の決裁者ではないため宛先に含めない
 * （含めると全支店の承認依頼が管理者に流れ込む）。決裁者として扱いたい場合は
 * 管理画面で決裁権限を明示的に付ける。
 */
export async function approversFor(step, branch) {
  if (step === 'planning') {
    const rows = await db.all('SELECT id FROM users WHERE active = 1 AND can_approve_planning = 1');
    return rows.map((r) => r.id);
  }
  const rows = await db.all(
    'SELECT id, branch, approve_branches FROM users WHERE active = 1 AND can_approve_branch = 1'
  );
  return rows
    .filter((u) => {
      const allowed = String(u.approve_branches || '').split(',').map((s) => s.trim()).filter(Boolean);
      return allowed.length ? allowed.includes(branch) : u.branch === branch;
    })
    .map((r) => r.id);
}

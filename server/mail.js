// メール送信。業務ポータルと同じ Resend を使う。
//
// 環境変数（Vercelのプロジェクト設定）:
//   RESEND_API_KEY … 送信に使う鍵。未設定なら送らない（アプリは通常どおり動く）
//   MAIL_FROM      … 差出人（既定: 値上げ単価管理 <noreply@paloma-pf.com>）
//   APP_ORIGIN     … メール内のリンクの宛先（既定: https://sales.paloma-pf.com）
//   MAIL_NOTIFY_TO … 追加の通知先。回答担当者のメール設定に足して送る（カンマ区切り）

export const appOrigin = () =>
  (process.env.APP_ORIGIN || 'https://sales.paloma-pf.com').replace(/\/+$/, '');

/** 表示用に危ない文字を落とす（メールはHTMLで送るため） */
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * メールを送る。鍵が無いときや送信に失敗したときは、記録だけ残して false を返す。
 * 呼び出し側の処理（問い合わせの保存など）は止めない。
 */
export async function sendMail({ to, subject, html }) {
  const key = (process.env.RESEND_API_KEY || '').trim();
  const list = (Array.isArray(to) ? to : [to])
    .map((v) => String(v ?? '').trim())
    .filter((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
  if (!list.length) return false;
  if (!key) {
    console.warn('[mail] RESEND_API_KEY が未設定のため通知メールを送りません:', subject);
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || '値上げ単価管理 <noreply@paloma-pf.com>',
        to: list,
        subject,
        html,
      }),
    });
    if (!r.ok) {
      console.warn('[mail] 送信に失敗しました', r.status, (await r.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[mail] 送信でエラー', e?.message ?? e);
    return false;
  }
}

/** 新しい問い合わせの通知メール（本社 営業企画部の回答担当者あて） */
export function inquiryMail(row) {
  const url = `${appOrigin()}/contact?inquiry=${row.id}`;
  const subject = `【値上げ単価管理】お問い合わせ（${row.category}）${row.name} さん`;
  const html = `
    <p>値上げ単価管理アプリに、新しいお問い合わせが届きました。</p>
    <table cellpadding="6" style="border-collapse:collapse;font-size:14px">
      <tr><th align="left">送信者</th><td>${esc(row.name)}（${esc(row.login_id ?? 'IDなし')}）</td></tr>
      <tr><th align="left">分類</th><td>${esc(row.category)}</td></tr>
      <tr><th align="left" valign="top">内容</th>
          <td style="white-space:pre-wrap">${esc(row.message)}</td></tr>
    </table>
    <p><a href="${url}"
          style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;
                 border-radius:8px;text-decoration:none;font-weight:600">
      アプリで回答する
    </a></p>
    <p style="color:#64748b;font-size:12px">
      回答はアプリの「お問い合わせ」画面で行います。回答すると、送信者の画面に知らせが出ます。<br>
      ${url}
    </p>`;
  return { subject, html };
}

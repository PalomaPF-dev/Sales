// メール送信。業務ポータルと同じ Resend を使う。
//
// 環境変数（Vercelのプロジェクト設定）:
//   RESEND_API_KEY … 送信に使う鍵。未設定なら送らない（アプリは通常どおり動く）
//   MAIL_FROM      … 差出人（既定: 価格改定進捗 <noreply@paloma-pf.com>）
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
  if (!list.length) return { ok: false, error: '宛先のメールアドレスがありません' };
  if (!key) {
    console.warn('[mail] RESEND_API_KEY が未設定のため通知メールを送りません:', subject);
    return { ok: false, error: 'RESEND_API_KEY が設定されていません' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: mailFrom(), to: list, subject, html }),
    });
    const text = (await r.text()).slice(0, 400);
    if (!r.ok) {
      console.warn('[mail] 送信に失敗しました', r.status, text);
      return { ok: false, error: `${r.status} ${resendMessage(text)}`, to: list };
    }
    return { ok: true, to: list };
  } catch (e) {
    console.warn('[mail] 送信でエラー', e?.message ?? e);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 差出人。Resendで認証済みのドメインである必要がある */
export const mailFrom = () =>
  process.env.MAIL_FROM || '価格改定進捗 <noreply@paloma-pf.com>';

/** Resendの応答から、画面に出す短い理由を取り出す */
function resendMessage(text) {
  try {
    const j = JSON.parse(text);
    return String(j.message ?? j.error ?? text);
  } catch {
    return text;
  }
}

/** 所属の表示（支店（部署）／営業所（室）／役職）。空の項目は出さない */
const affiliation = (row) => [row?.branch, row?.office, row?.title]
  .map((v) => String(v ?? '').trim()).filter(Boolean).join('　／　') || '—';

/**
 * 問い合わせの中身を並べた表と、回答へ進むボタン。
 * 通知メールと、設定画面からのテスト送信で同じものを使う。
 * テストで届く見た目が本番と違うと、何が届くのか確かめられないため。
 */
function inquiryBody(row, url, destLabel) {
  const th = 'text-align:left;padding:6px 14px 6px 0;color:#707070;'
    + 'font-weight:600;white-space:nowrap;vertical-align:top';
  const td = 'padding:6px 0;color:#333333;vertical-align:top';
  return `
    <table cellpadding="0" cellspacing="0"
           style="border-collapse:collapse;font-size:14px;line-height:1.7">
      <tr><th style="${th}">送信者</th>
          <td style="${td}"><strong>${esc(row.name)}</strong>${
            row.login_id ? `（${esc(row.login_id)}）` : ''}</td></tr>
      <tr><th style="${th}">所属</th>
          <td style="${td}">${esc(affiliation(row))}</td></tr>
      <tr><th style="${th}">宛先</th><td style="${td}">${esc(destLabel)}</td></tr>
      <tr><th style="${th}">分類</th><td style="${td}">${esc(row.category)}</td></tr>
      <tr><th style="${th}">内容</th>
          <td style="${td}">
            <div style="white-space:pre-wrap;background:#f7f7f5;border:1px solid #eeeeee;
                        border-radius:8px;padding:12px 14px;max-width:560px">${
              esc(row.message)}</div>
          </td></tr>
    </table>
    <p style="margin:20px 0 8px">
      <a href="${url}"
         style="display:inline-block;background:#dc000c;color:#fff;padding:10px 18px;
                border-radius:8px;text-decoration:none;font-weight:600">
        アプリで回答する
      </a>
    </p>
    <p style="color:#707070;font-size:12px;line-height:1.7;margin:0">
      ボタンが押せないときは、次のURLを開いてください。この1件を枠で示し、
      回答欄まで移動します。<br>
      <a href="${url}" style="color:#0b5ca8">${esc(url)}</a><br>
      回答すると、送信者の画面に知らせが出ます。
    </p>`;
}

/**
 * 設定を確かめるためのテストメール。
 * 実際の通知と同じ体裁の見本を入れて、何が届くのかを確かめられるようにする。
 */
export function testMail(byName, by = {}) {
  const subject = '【価格改定進捗】メール通知のテスト';
  const sample = {
    name: byName,
    login_id: by.login_id ?? null,
    branch: by.branch ?? '（支店名）',
    office: by.office ?? '（営業所名）',
    title: by.title ?? '（役職）',
    category: '集計・数字の見方',
    message: 'これは見本です。実際のお問い合わせでは、送られた本文がここに入ります。',
  };
  const html = `
    <p>価格改定進捗管理アプリからのテストメールです。</p>
    <p>このメールが届いていれば、お問い合わせが入ったときの通知も同じ経路で届きます。
       実際には、次のような内容が届きます。</p>
    <div style="border:1px solid #e5e5e5;border-radius:10px;padding:16px 18px;margin:16px 0">
      <p style="margin:0 0 12px;color:#707070;font-size:12px">― ここから見本 ―</p>
      ${inquiryBody(sample, `${appOrigin()}/contact`, '営業本部内のこと')}
    </div>
    <p style="color:#707070;font-size:12px">
      送信者: ${esc(byName)}<br>
      差出人: ${esc(mailFrom())}<br>
      アプリ: ${esc(appOrigin())}
    </p>`;
  return { subject, html };
}

/** 新しい問い合わせの通知メール（本社 営業企画部・管理者あて） */
export function inquiryMail(row) {
  const url = `${appOrigin()}/contact?inquiry=${row.id}`;
  // 宛先（アプリのこと＝管理者／営業本部内のこと＝営業企画部）。
  // 件名だけで自分宛かどうかと、誰からかが分かるようにする
  const destLabel = row.dest === 'sales' ? '営業本部内のこと' : 'アプリのこと';
  const who = [String(row.branch ?? '').trim(), String(row.name ?? '').trim()]
    .filter(Boolean).join(' ');
  const subject = `【価格改定進捗／${destLabel}】お問い合わせ（${row.category}）${who} さん`;
  const html = `
    <p>価格改定進捗管理アプリに、新しいお問い合わせが届きました。</p>
    ${inquiryBody(row, url, destLabel)}`;
  return { subject, html };
}

// 自動取込（社内PCのスクリプト）の受け口。
//
// 出荷明細・売上高のファイルは社内の共有フォルダに置かれ、クラウド（Vercel）からは
// 見えない。そこで社内PCのタスクスケジューラが平日の昼にスクリプト
// （client/auto-import）を動かし、画面と同じ読み取りコードでファイルを読んで、
// 画面と同じ取込のAPIへ送る。ここではその本人確認と、結果の通知を受け持つ。
//
// 環境変数（Vercelのプロジェクト設定）:
//   AUTO_IMPORT_KEY  … 自動取込の鍵。スクリプトは X-Import-Key ヘッダーで送る。
//                      32文字以上。未設定なら自動取込は受け付けない
//   AUTO_IMPORT_USER … 取込を行う利用者のログインID。管理者（または開発者）で、
//                      有効な利用者であること。取込履歴の「取込者」にこの名前が出る
//
// 鍵で入れるのは、取込に要る経路だけ（AUTO_IMPORT_PATHS）。
// 鍵が漏れても、案件の書き換えや利用者の管理まではできないようにするため。
import { createHash, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { sendMail, appOrigin } from './mail.js';

/** 鍵の最短の長さ。推測で当てられないよう、短い鍵は設定されていても使わない */
const MIN_KEY_LENGTH = 32;

/** 鍵で入れる経路（方法とパス）。これ以外は鍵では通さない */
const AUTO_IMPORT_PATHS = [
  ['GET', /^\/auto-import\/check$/],
  ['POST', /^\/auto-import\/report$/],
  // 出荷明細（出荷実績の色分け）
  ['GET', /^\/ship-color\/rules$/],
  ['GET', /^\/ship-color\/batches$/],
  ['POST', /^\/ship-color\/import\/start$/],
  ['POST', /^\/ship-color\/import\/\d+\/(rows|finish)$/],
  // 売上高（日次・月次）
  ['GET', /^\/survey-import\/workdays$/],
  ['POST', /^\/survey-import\/(start|chunk|finish)$/],
];

const ADMIN_ROLES = ['admin', 'developer'];

const digest = (v) => createHash('sha256').update(String(v), 'utf8').digest();

/**
 * 自動取込の利用者かどうか。この利用者は画面からはログインさせない
 * （パスワードを持たないので、初回ログインの設定でIDを知る人に取られないように）。
 */
export const isAutoImportLogin = (loginId) => {
  const id = String(process.env.AUTO_IMPORT_USER ?? '').trim();
  return Boolean(id) && String(loginId ?? '').trim() === id;
};

/** 鍵での呼び出しかどうか（ヘッダーがあれば、正しくなくても鍵での呼び出しとして扱う） */
export const hasImportKey = (req) => req.get('x-import-key') != null;

/**
 * 鍵を確かめ、取込を行う利用者を返す。
 * 断るときは { status, error }。設定の不備は鍵の誤りと分けて伝える
 * （社内PC側で「鍵が違う」のか「アプリの設定が足りない」のかを見分けられるように）。
 */
export async function resolveImportKey(req) {
  const key = String(process.env.AUTO_IMPORT_KEY ?? '').trim();
  if (!key) {
    return { status: 503, error: '自動取込の鍵（AUTO_IMPORT_KEY）がアプリに設定されていません' };
  }
  if (key.length < MIN_KEY_LENGTH) {
    return { status: 503, error: `AUTO_IMPORT_KEY が短すぎます（${MIN_KEY_LENGTH}文字以上にしてください）` };
  }
  // 長さの違いで早く返らないよう、ハッシュにそろえてから比べる
  if (!timingSafeEqual(digest(req.get('x-import-key')), digest(key))) {
    return { status: 401, error: '自動取込の鍵が違います' };
  }
  if (!AUTO_IMPORT_PATHS.some(([m, re]) => m === req.method && re.test(req.path))) {
    return { status: 403, error: '自動取込の鍵では、この操作はできません' };
  }
  const loginId = String(process.env.AUTO_IMPORT_USER ?? '').trim();
  if (!loginId) {
    return { status: 503, error: '取込を行う利用者（AUTO_IMPORT_USER）がアプリに設定されていません' };
  }
  const user = await db.get('SELECT * FROM users WHERE login_id = ? AND active = 1', [loginId]);
  if (!user) {
    return { status: 503, error: `AUTO_IMPORT_USER の「${loginId}」が見つからないか、停止中です` };
  }
  if (!ADMIN_ROLES.includes(user.role)) {
    return { status: 503, error: `AUTO_IMPORT_USER の「${loginId}」を管理者にしてください（取込は管理者だけができます）` };
  }
  // 自動取込の利用者は画面からログインしないので、仮パスワードのままでも通す
  return { user: { ...user, must_change_password: 0 } };
}

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 「2026-10-12T03:00:00Z」→「10/12 12:00」（日本時間） */
const jstShort = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
};

const lines = (v) => (Array.isArray(v) ? v : [])
  .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200).map((x) => x.slice(0, 1000));

/** 通知の宛先。メールを登録している管理者と、MAIL_NOTIFY_TO */
async function recipients() {
  const admins = await db.all(
    `SELECT email FROM users
      WHERE active = 1 AND email IS NOT NULL AND email <> '' AND role = 'admin'`);
  const extra = String(process.env.MAIL_NOTIFY_TO ?? '').split(',');
  return [...admins.map((u) => u.email), ...extra].map((v) => String(v ?? '').trim()).filter(Boolean);
}

function reportMail(r) {
  const state = r.ok ? '完了' : 'エラーあり';
  const subject = `【価格改定進捗】自動取込 ${state}（${jstShort(r.at)}）`;
  const li = (x) => `<li style="margin:2px 0">${esc(x)}</li>`;
  const html = `
    <p>社内PCの自動取込が${r.ok ? '終わりました' : '終わりましたが、取り込めなかったものがあります'}。</p>
    ${r.errors.length ? `
      <p style="margin:12px 0 4px;color:#dc000c;font-weight:600">取り込めなかったもの</p>
      <ul style="margin:0;padding-left:20px;color:#dc000c">${r.errors.map(li).join('')}</ul>` : ''}
    <p style="margin:12px 0 4px;font-weight:600">内容</p>
    <ul style="margin:0;padding-left:20px">${(r.lines.length ? r.lines : ['取り込むものはありませんでした']).map(li).join('')}</ul>
    <p style="color:#707070;font-size:12px;margin-top:16px">
      実行したPC: ${esc(r.host || '不明')}／取込者: ${esc(r.by)}<br>
      アプリ: <a href="${appOrigin()}" style="color:#0b5ca8">${esc(appOrigin())}</a>
    </p>`;
  return { subject, html };
}

/**
 * 画面・APIを api ルーターへ取り付ける。
 * 鍵の確かめは api.js の認証の入口で行う（resolveImportKey）。ここは鍵で入った呼び出しだけを受ける。
 */
export function mountAutoImport(api, { wrap }) {
  const requireKey = (req, res) => {
    if (req.viaImportKey) return true;
    res.status(403).json({ error: '自動取込のスクリプトからだけ使えます' });
    return false;
  };

  // 社内PCで設定を確かめるときに使う（つながるか・鍵が合うか・誰として取り込むか）
  api.get('/auto-import/check', wrap(async (req, res) => {
    if (!requireKey(req, res)) return;
    res.json({
      ok: true,
      user: { loginId: req.user.login_id, name: req.user.name, role: req.user.role },
      mail: Boolean((process.env.RESEND_API_KEY || '').trim()),
      mailTo: (await recipients()).length,
    });
  }));

  // 1回の実行の結果。最後の実行として残し、メールで知らせる
  api.post('/auto-import/report', wrap(async (req, res) => {
    if (!requireKey(req, res)) return;
    const body = req.body ?? {};
    const r = {
      at: new Date().toISOString(),
      ok: body.ok === true,
      lines: lines(body.lines),
      errors: lines(body.errors),
      host: String(body.host ?? '').slice(0, 100),
      by: req.user.name,
    };
    await db.run(
      `INSERT INTO settings (key, value) VALUES ('auto_import_last', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(r)]);
    // 既定は毎回送る。うまくいった日も届くことで、PCが止まっている（メールが来ない）ことに気づける
    const notify = body.notify === 'error' ? 'error' : 'always';
    if (notify === 'error' && r.ok) return res.json({ saved: true, mailed: false });
    const to = await recipients();
    if (!to.length) return res.json({ saved: true, mailed: false, error: '通知の宛先がありません' });
    const m = await sendMail({ to, ...reportMail(r) });
    res.json({ saved: true, mailed: m.ok, to: to.length, error: m.ok ? undefined : m.error });
  }));
}

/** 管理者画面「連携の状況」に出す、自動取込の状態 */
export async function autoImportStatus() {
  const key = String(process.env.AUTO_IMPORT_KEY ?? '').trim();
  const user = String(process.env.AUTO_IMPORT_USER ?? '').trim();
  const hint = 'Vercel → Settings → Environment Variables に AUTO_IMPORT_KEY と AUTO_IMPORT_USER。'
    + '社内PCの設定は client/auto-import/README.md。設定後は再デプロイが必要です';
  if (!key || !user || key.length < MIN_KEY_LENGTH) {
    return {
      key: 'autoImport',
      name: '自動取込（社内PCから出荷明細・売上高）',
      ok: false,
      detail: !key || !user
        ? '未設定。出荷明細・売上高は画面から取り込みます'
        : `AUTO_IMPORT_KEY が短すぎます（${MIN_KEY_LENGTH}文字以上）`,
      hint,
    };
  }
  let last = null;
  try {
    const row = await db.get("SELECT value FROM settings WHERE key = 'auto_import_last'");
    last = row?.value ? JSON.parse(row.value) : null;
  } catch { /* 記録が読めなければ「まだ動いていない」として出す */ }
  return {
    key: 'autoImport',
    name: '自動取込（社内PCから出荷明細・売上高）',
    ok: true,
    // 最後の実行が失敗していれば、ここでも気づけるようにする
    detail: !last
      ? `設定済み（取込者: ${user}）。まだ一度も実行されていません`
      : `最後の実行: ${jstShort(last.at)}（${last.ok ? '完了' : 'エラーあり'}・${last.host || 'PC不明'}）`
        + (last.errors?.length ? `　${last.errors.slice(0, 2).join(' / ')}` : ''),
    hint,
  };
}

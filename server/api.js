import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import multer from 'multer';
import XLSX from 'xlsx';
import { db, initDb } from './db.js';
import { sendMail, inquiryMail, testMail, mailFrom } from './mail.js';
import {
  addBatchCount, assertNotDuplicate, buildRow, createBatch, importWorkbook,
  isSkippableRow, summarizeWarnings, upsertRows, validateMapping,
} from './importer.js';
import { FIELDS } from './fields.js';
import { hashPassword, verifyPassword, generateTempPassword, validatePassword, isLegacyHash } from './passwords.js';
import {
  COOKIE_NAME, createSession, resolveSession, destroySession, destroyUserSessions,
  readCookie, setSessionCookie, clearSessionCookie,
} from './session.js';
import {
  buildExportTable, buildWorkbook, buildDashboardWorkbook,
  buildTotalsSheet, TOTALS_SHEET_NAME, TOTALS_SHEET_WIDTHS,
} from './export.js';
import {
  deleteAttachment, fetchAttachment, fileBucket, isFileStoreConfigured, putAttachment,
} from './fileStore.js';
import { comparePref } from './prefOrder.js';
import { workdayPlan } from './workdays.js';
import {
  KUBUNS, findStandardPrice, loadStandardIndex, matchStandardModel,
  parseStandardWorkbook, replaceStandardPrices,
} from './standardPrices.js';

export const api = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// 分割取込で1回に送る行数。JSONにして数百KBに収まる大きさにする
const IMPORT_CHUNK_ROWS = 500;

// サーバーでExcelファイルを作って返せる上限。
// サーバーレス（Vercel）は1回の応答が約4.5MBまでのため、それに収まる件数にする。
// これを超える件数は /deals/export-rows の分割出力でブラウザ側が組み立てる。
const EXPORT_MAX_ROWS = Number(process.env.EXPORT_MAX_ROWS)
  || (process.env.VERCEL ? 6000 : 100000);

const nv = (v) => (v === undefined ? null : v);
const now = () => new Date().toISOString();

/**
 * 氏名の突合に使う「スペースを取り除いた形」を作るSQL。
 * 名簿は「山田 太郎」、価格調査（毎日更新）は「山田　太郎」のように
 * 姓名の間の空白が半角・全角・無しで揺れるため、そこを無視して突き合わせる。
 */
const nameKey = (col) => `replace(replace(replace(${col}, ' ', ''), '　', ''), '\t', '')`;

/**
 * ユーザーの氏名を、価格調査（毎日更新）の営業担当者の表記へ揃える。
 * 空白を除いた形が同じなら、案件データ側の書き方に合わせて名簿側を直す。
 * 取込のたびに呼び、名簿と案件の担当者名がずれ続けないようにする。
 */
async function alignUserNamesToDeals() {
  try {
    const r = await db.run(`
      UPDATE users SET name = m.dname
        FROM (SELECT ${nameKey('sales_person')} AS k, MIN(sales_person) AS dname
                FROM deals
               WHERE sales_person IS NOT NULL AND sales_person <> ''
               GROUP BY ${nameKey('sales_person')}) m
       WHERE ${nameKey('users.name')} = m.k AND users.name <> m.dname`);
    return Number(r?.changes ?? 0);
  } catch {
    return 0;   // 案件が空のときなど。揃えられなくても取込は続ける
  }
}
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (v == null ? 0 : Number(v));

// 非同期ハンドラのエラーをExpressのエラーハンドラへ渡す
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * 数字のIDを受ける経路の見張り。
 *
 * PostgreSQLはinteger列に数字以外を渡すとエラーになるため、
 * /deals/summary のような古いURLを開かれると500になってしまう
 * （SQLiteでは該当なしとして扱われるので、本番だけで起きる）。
 * 経路に入る前にはじいて「見つかりません」を返す。
 */
for (const name of ['id', 'batchId']) {
  api.param(name, (req, res, next, value) => {
    if (!/^\d+$/.test(String(value))) return res.status(404).json({ error: '見つかりません' });
    next();
  });
}

/**
 * 開発用のログイン省略。
 * DEV_LOGIN_AS=<ログインID> を指定すると、そのユーザーとしてログイン済みとして扱う。
 *
 * 本番で有効になると認証が丸ごと無効化されてしまうため、
 * サーバーレス環境（Vercel）と NODE_ENV=production では明示的に拒否する。
 */
const DEV_LOGIN_AS = (() => {
  const value = process.env.DEV_LOGIN_AS;
  if (!value) return null;
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    console.error('DEV_LOGIN_AS は本番環境では使用できません。無視します。');
    return null;
  }
  console.warn(
    `\n*** 開発モード: 認証を省略し「${value}」としてログイン済みとして扱います。***\n` +
    '*** 本番環境では DEV_LOGIN_AS を設定しないでください。 ***\n'
  );
  return value;
})();

/**
 * 認証の無効化。
 *
 * DISABLE_AUTH=true を設定すると、ログインを求めずに全員が同じユーザーとして操作する。
 * 動作確認用の設定であり、有効にするとURLを知っている人は誰でも価格データを
 * 閲覧・変更でき、誰が変更したのかも記録されない。
 *
 * 本番（Vercel / NODE_ENV=production）では設定されていても無視する。
 * 取り違えて設定したときに、価格データが認証なしで公開されてしまうため。
 */
const AUTH_DISABLED = (() => {
  if (String(process.env.DISABLE_AUTH ?? '').toLowerCase() !== 'true') return false;
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    console.error(
      '\n*** DISABLE_AUTH は本番環境では使用できません。無視してログインを求めます。***\n' +
      '*** 認証を止めたい場合は本番以外の環境で行ってください。***\n'
    );
    return false;
  }
  console.warn(
    '\n*** 警告: DISABLE_AUTH=true のため認証が無効です。***\n' +
    '*** URLを知っている全員が価格データを閲覧・変更でき、変更者も記録されません。***\n' +
    '*** 社外から到達できる環境では設定を解除してください。***\n'
  );
  return true;
})();

/** 認証無効時に全員が名乗るユーザー（管理者→本社の順で選ぶ） */
async function fallbackUser() {
  return db.get(
    `SELECT * FROM users WHERE active = 1
     ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END, id LIMIT 1`);
}

// ---- 認証（ログインID/パスワード + セッションCookie） ----
api.use(wrap(async (req, res, next) => {
  await initDb();
  if (AUTH_DISABLED) {
    req.user = await fallbackUser();
    if (req.user) {
      req.user.must_change_password = 0;
      return next();
    }
    console.warn('DISABLE_AUTH が有効ですが、有効なユーザーが1人も居ません。');
  }
  if (DEV_LOGIN_AS) {
    req.user = await db.get('SELECT * FROM users WHERE login_id = ? AND active = 1', [DEV_LOGIN_AS]);
    if (req.user) {
      req.user.must_change_password = 0; // 開発時はパスワード変更を求めない
      return next();
    }
    console.warn(`DEV_LOGIN_AS="${DEV_LOGIN_AS}" に該当するユーザーが見つかりません。`);
  }
  req.sessionToken = readCookie(req, COOKIE_NAME);
  req.user = await resolveSession(req.sessionToken);
  next();
}));

// ログイン前に到達してよいパス。これ以外は既定で拒否する。
// 個別のハンドラに requireLogin を書き忘れても素通りしないようにするための関門。
const PUBLIC_PATHS = new Set([
  '/login', '/login/setup', '/logout', '/me', '/setup/status', '/setup', '/admin-recovery',
  // 問い合わせは「ログインできない」の分類だけ未ログインで受ける（ハンドラ側で判定）
  '/inquiries',
]);

api.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!req.user) return res.status(401).json({ error: 'ログインしてください' });
  // 仮パスワードのままでは、パスワード変更以外の操作をさせない
  if (req.user.must_change_password && req.path !== '/password') {
    return res.status(403).json({ error: 'パスワードの変更が必要です', mustChangePassword: true });
  }
  next();
});

// 閲覧専用（共通ID）は書き込みを一切通さない。
// 画面で欄を隠すだけだと、URLを直接叩かれたときに素通りしてしまうため、
// 個々のハンドラに書き忘れても止まるよう、ここでまとめて拒否する。
// パスワードの変更も通さない（共通IDのため、1人が変えると全員が入れなくなる）。
api.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (!req.user || !isViewerRole(req.user.role)) return next();
  if (viewerMayWrite(req.path)) return next();
  res.status(403).json({ error: '閲覧専用のため、この操作はできません' });
});

function requireLogin(req, res) {
  if (!req.user) {
    res.status(401).json({ error: 'ログインしてください' });
    return false;
  }
  // 仮パスワードのまま業務操作をさせない
  if (req.user.must_change_password && !req.allowWhileMustChange) {
    res.status(403).json({ error: 'パスワードの変更が必要です', mustChangePassword: true });
    return false;
  }
  return true;
}

/**
 * 閲覧専用。共通IDを配って「見るだけ」にしてもらうための権限。
 * 画面から入力の欄を隠すだけでは足りない（URLを直接叩けば通ってしまう）ため、
 * サーバー側でも書き込みをまとめて止める。
 */
const isViewerRole = (role) => role === 'viewer';

/**
 * 実績原価まで含めて、すべての情報を見られる権限。
 *
 * 原価は社外秘のため、本社（営業部・製品企画部）と管理者・開発者だけに出す。
 * 支店・営業所の担当者と閲覧専用には出さない
 * （閲覧専用は以前ここに含めていたが、配る人数ぶん原価が広がってしまう）。
 */
const canSeeAllInfo = (role) => isAdminRole(role) || role === 'planning';

/** 閲覧専用でも通す書き込み。ログアウトと、お問い合わせの送信・既読だけ */
function viewerMayWrite(path) {
  return path === '/logout'
    || path === '/inquiries'
    || path === '/inquiries/delete'
    || /^\/inquiries\/mine\/\d+\/read$/.test(path)
    || /^\/inquiries\/\d+$/.test(path)
    // お知らせは読むだけ。既読にする操作は閲覧専用でも通す
    || path === '/announcements/read-all'
    || /^\/announcements\/\d+\/read$/.test(path);
}

/**
 * 管理者相当かどうか。
 * 開発者は管理者と同じ操作に加えて、取込で入った列の修正だけができる
 * （その判定は buildDealUpdate 側で行う）。
 */
const isAdminRole = (role) => role === 'admin' || role === 'developer';

function requireRole(req, res, roles) {
  if (!requireLogin(req, res)) return false;
  if (!roles.includes(req.user.role) && !isAdminRole(req.user.role)) {
    res.status(403).json({ error: 'この操作の権限がありません' });
    return false;
  }
  return true;
}

/** 管理者だけが触れる操作（ユーザー管理・決裁者設定） */
/**
 * 問い合わせの宛先。話の中身で分ける。
 *   app   … アプリの仕様・不具合のこと → 管理者が受ける
 *   sales … 営業本部内のこと（価格・交渉の進め方など）→ 営業部・製品企画部（本社）が受ける
 *
 * notify … 届いたときにメールを送る相手の権限
 * staff  … 一覧で見て回答できる権限。管理者はどちらも見られる（運用の面倒を見るため）
 */
const INQUIRY_DESTS = {
  app: {
    label: 'アプリのこと（管理者へ）',
    notify: ['admin', 'developer'],
    staff: ['admin', 'developer'],
  },
  sales: {
    label: '営業本部内のこと（営業部・製品企画部へ）',
    notify: ['planning'],
    staff: ['planning', 'admin', 'developer'],
  },
};
const destOf = (v) => (INQUIRY_DESTS[String(v ?? '')] ? String(v) : 'app');

/** 問い合わせの回答担当。宛先ごとに決まる。どれか1つでも受け持つなら一覧を出す */
const INQUIRY_ROLES = [...new Set(Object.values(INQUIRY_DESTS).flatMap((d) => d.staff))];
const isInquiryStaff = (role) => INQUIRY_ROLES.includes(String(role ?? ''));
/** その人が受け持つ宛先（一覧に出す範囲） */
const destsFor = (role) => Object.keys(INQUIRY_DESTS)
  .filter((k) => INQUIRY_DESTS[k].staff.includes(String(role ?? '')));

function requireInquiryStaff(req, res) {
  if (!requireLogin(req, res)) return false;
  if (!isInquiryStaff(req.user.role)) {
    res.status(403).json({ error: 'この操作は本社（営業部・製品企画部）と管理者のみ実行できます' });
    return false;
  }
  return true;
}

/**
 * 届いた問い合わせを回答担当者へメールで知らせる。
 * メールを設定している本社・管理者が宛先。送れなくても問い合わせの受付は続ける。
 */
async function notifyInquiry(row) {
  try {
    // 宛先（アプリのこと＝管理者／営業本部内のこと＝営業部・製品企画部）ごとに送り先を変える
    const roles = INQUIRY_DESTS[destOf(row.dest)].notify;
    const staff = await db.all(
      `SELECT email FROM users
        WHERE active = 1 AND email IS NOT NULL AND email <> ''
          AND role IN (${roles.map(() => '?').join(',')})`, roles);
    const extra = String(process.env.MAIL_NOTIFY_TO ?? '').split(',');
    const to = [...staff.map((u) => u.email), ...extra];
    const { subject, html } = inquiryMail(row);
    await sendMail({ to, subject, html });
  } catch (e) {
    console.warn('[inquiry] 通知メールを送れませんでした', e?.message ?? e);
  }
}

function requireAdmin(req, res) {
  if (!requireLogin(req, res)) return false;
  if (!isAdminRole(req.user.role)) {
    res.status(403).json({ error: 'この操作は管理者のみ実行できます' });
    return false;
  }
  return true;
}

// ---- ログイン / ログアウト ----

// 連続失敗時のロック設定
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/**
 * 利用者に見せる時刻。
 *
 * サーバーの時計はVercelではUTCのため、そのまま整形すると
 * 「あと何分待てばよいか」が9時間ずれて伝わってしまう。
 * 国内利用のアプリなので日本時間で表示する（DISPLAY_TZ で変更可）。
 */
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'Asia/Tokyo';
const localTime = (value) => new Date(value).toLocaleTimeString('ja-JP', {
  hour: '2-digit', minute: '2-digit', timeZone: DISPLAY_TZ,
});

const publicUser = (u) => ({
  id: u.id, name: u.name, role: u.role, branch: u.branch, office: u.office,
  loginId: u.login_id, mustChangePassword: Boolean(u.must_change_password),
  // 認証が無効な状態を画面側で気づけるようにする
  authDisabled: AUTH_DISABLED || undefined,
});

// ---- 初期セットアップ ----
// パスワードを持つユーザーが1人も居ない間だけ、ブラウザから最初の管理者を設定できる。
// 誰か1人でも設定された時点で完全に閉じるため、後から悪用されることはない。

async function needsSetup() {
  const { c } = await db.get('SELECT COUNT(*) AS c FROM users WHERE password_hash IS NOT NULL');
  return Number(c) === 0;
}

api.get('/setup/status', wrap(async (req, res) => {
  const open = await needsSetup();
  res.json({
    needsSetup: open,
    // 初期設定の対象は管理者・本社のみ（POST側の制限と揃える）
    candidates: open
      ? await db.all(
          `SELECT login_id, name, role FROM users
           WHERE active = 1 AND login_id IS NOT NULL AND role IN ('admin','planning')
           ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, id`)
      : [],
  });
}));

api.post('/setup', wrap(async (req, res) => {
  if (!await needsSetup()) {
    return res.status(410).json({ error: '初期設定は完了しています。ログイン画面からお進みください' });
  }
  const loginId = String(req.body?.loginId ?? '').trim();
  const password = String(req.body?.password ?? '');
  const user = await db.get('SELECT * FROM users WHERE login_id = ? AND active = 1', [loginId]);
  if (!user) return res.status(400).json({ error: '対象のユーザーが見つかりません' });
  if (!['admin', 'planning'].includes(user.role)) {
    return res.status(400).json({ error: '最初の設定は管理者または本社のユーザーに対して行ってください' });
  }
  const problem = validatePassword(password);
  if (problem) return res.status(400).json({ error: problem });

  await db.run(
    `UPDATE users SET password_hash = ?, must_change_password = 0,
            failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`,
    [await hashPassword(password), now(), user.id]);

  // そのままログインした状態にして、続けて操作できるようにする
  const { token, expires } = await createSession(user.id);
  setSessionCookie(req, res, token, expires);
  console.warn(`初期セットアップが完了しました（${user.login_id} / ${user.name}）。以降この画面は無効になります。`);
  res.status(201).json(publicUser({ ...user, must_change_password: 0 }));
}));

api.post('/login', wrap(async (req, res) => {
  const loginId = String(req.body?.loginId ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!loginId || !password) {
    return res.status(400).json({ error: 'ログインIDとパスワードを入力してください' });
  }

  const user = await db.get('SELECT * FROM users WHERE login_id = ?', [loginId]);

  // ユーザーの有無を推測されないよう、失敗時の応答は区別しない
  const deny = () => res.status(401).json({ error: 'ログインIDまたはパスワードが違います' });

  if (!user || !user.active) {
    await verifyPassword(password, null); // 応答時間を揃える
    return deny();
  }
  // パスワード未設定＝初回ログイン。ポータルと同じく、パスワード設定へ誘導する
  if (!user.password_hash) {
    return res.status(409).json({
      needsSetup: true,
      error: '初回ログインのため、パスワードの設定が必要です',
    });
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return res.status(423).json({
      error: `ログインの試行回数が上限を超えました。${localTime(user.locked_until)}以降に再度お試しください`,
    });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const failed = Number(user.failed_attempts || 0) + 1;
    const lockUntil = failed >= MAX_FAILED
      ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString()
      : null;
    await db.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?',
      [failed, lockUntil, user.id]);
    return deny();
  }

  await db.run(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?',
    [now(), user.id]
  );
  // 旧方式(scrypt)のまま残っているハッシュは、ログイン成功時に現行方式へ入れ替える。
  // 利用者に再設定を求めずに移行できる。
  if (isLegacyHash(user.password_hash)) {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?',
      [await hashPassword(password), user.id]);
  }
  const { token, expires } = await createSession(user.id);
  setSessionCookie(req, res, token, expires);
  res.json(publicUser(user));
}));

/**
 * 初回パスワード設定（ポータルと同じ仕様）。
 * パスワードが未設定のユーザーだけが、自分でパスワードを決めてそのままログインする。
 * 仮パスワードの発行・伝達をやめるための入口で、ログイン画面の
 * 「初めてログインする方はこちら」から使う。
 */
api.post('/login/setup', wrap(async (req, res) => {
  const loginId = String(req.body?.loginId ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!loginId || !password) {
    return res.status(400).json({ error: '社員番号とパスワードを入力してください' });
  }
  const problem = validatePassword(password);
  if (problem) return res.status(400).json({ error: problem });

  const user = await db.get('SELECT * FROM users WHERE login_id = ? AND active = 1', [loginId]);
  if (!user) {
    return res.status(404).json({ error: '社員番号が見つかりません。管理者にお問い合わせください' });
  }
  if (user.password_hash) {
    return res.status(409).json({ error: '既に設定済みです。通常のログインをお使いください' });
  }
  await db.run(
    `UPDATE users SET password_hash = ?, must_change_password = 0,
            failed_attempts = 0, locked_until = NULL, last_login_at = ?
      WHERE id = ? AND password_hash IS NULL`,
    [await hashPassword(password), now(), user.id]
  );
  // 競合（同時に2回設定された）を防ぐため、設定できたかを読み直して確かめる
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  const { token, expires } = await createSession(user.id);
  setSessionCookie(req, res, token, expires);
  res.json(publicUser({ ...fresh, must_change_password: 0 }));
}));

api.post('/logout', wrap(async (req, res) => {
  await destroySession(req.sessionToken);
  clearSessionCookie(req, res);
  res.json({ ok: true });
}));

api.get('/me', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'ログインしてください' });
  res.json(publicUser(req.user));
}));

// ---- 管理者の復旧（締め出されたときの最後の手段） ----

/**
 * 管理者アカウントを作り直す。
 *
 * 通常は `npm run set-password` で復旧するが、ターミナルを使えない運用では
 * 本番で管理者に入れなくなると手が無くなる。そのための逃げ道。
 *
 * ADMIN_RECOVERY_TOKEN を設定したときだけ開く。この環境変数を設定できるのは
 * Vercelの設定を触れる人だけなので、DATABASE_URL を設定できる人と同じ範囲に収まる。
 * 使い終わったら環境変数を消して閉じること（応答にもその旨を書いて返す）。
 */
const MIN_RECOVERY_TOKEN_LENGTH = 24;

api.get('/admin-recovery', wrap(async (req, res) => {
  const expected = process.env.ADMIN_RECOVERY_TOKEN || '';

  // 未設定のときは機能そのものを隠す（存在を知られないように404）
  if (!expected) return res.status(404).json({ error: '見つかりません' });

  if (expected.length < MIN_RECOVERY_TOKEN_LENGTH) {
    console.error('ADMIN_RECOVERY_TOKEN が短すぎます。復旧は行いません。');
    return res.status(500).json({
      error: `ADMIN_RECOVERY_TOKEN は${MIN_RECOVERY_TOKEN_LENGTH}文字以上にしてください`,
    });
  }

  const given = String(req.query?.token ?? '');
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn('管理者復旧: 合言葉が一致しませんでした');
    return res.status(404).json({ error: '見つかりません' });
  }

  const loginId = String(req.query?.loginId ?? '').trim();
  const name = String(req.query?.name ?? '').trim() || loginId;
  if (!loginId) {
    return res.status(400).json({ error: 'loginId を指定してください（例: ?loginId=devadmin&name=開発者）' });
  }

  const password = generateTempPassword();
  const hash = await hashPassword(password);
  const existing = await db.get('SELECT * FROM users WHERE login_id = ?', [loginId]);

  let action;
  if (existing) {
    // 役割も管理者へ引き上げる。締め出されている状況なので、
    // 権限が足りないまま入れても復旧にならない。
    await db.run(
      `UPDATE users SET password_hash = ?, role = 'admin', active = 1,
              must_change_password = 1, failed_attempts = 0, locked_until = NULL
         WHERE id = ?`, [hash, existing.id]);
    await destroyUserSessions(existing.id);
    action = 'reset';
  } else {
    await db.run(
      `INSERT INTO users (name, role, branch, office, active, login_id,
                          password_hash, must_change_password)
       VALUES (?, 'admin', NULL, NULL, 1, ?, ?, 1)`, [name, loginId, hash]);
    action = 'created';
  }

  console.warn(
    `*** 管理者復旧を実行しました（${action}: ${loginId}）。***\n` +
    '*** 使い終わったら ADMIN_RECOVERY_TOKEN を削除してください。***');

  res.json({
    ok: true,
    action,
    loginId,
    tempPassword: password,
    note: '初回ログイン時にパスワードの変更が求められます。'
        + '完了したら Vercel の ADMIN_RECOVERY_TOKEN を削除して、この入口を閉じてください。',
  });
}));

// パスワード変更（本人のみ。仮パスワード状態でも実行できる）
api.post('/password', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'ログインしてください' });
  const current = String(req.body?.currentPassword ?? '');
  const next = String(req.body?.newPassword ?? '');

  if (!await verifyPassword(current, req.user.password_hash)) {
    return res.status(401).json({ error: '現在のパスワードが違います' });
  }
  const problem = validatePassword(next);
  if (problem) return res.status(400).json({ error: problem });
  if (current === next) return res.status(400).json({ error: '現在と異なるパスワードを設定してください' });

  await db.run(
    'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
    [await hashPassword(next), req.user.id]
  );
  // 変更前のセッションは全て無効化し、この端末だけ再発行する
  await destroyUserSessions(req.user.id);
  const { token, expires } = await createSession(req.user.id);
  setSessionCookie(req, res, token, expires);
  res.json({ ok: true });
}));

// ---- ユーザー管理（管理者のみ） ----

const ROLES = ['sales', 'branch_manager', 'wide_area', 'planning', 'admin', 'developer', 'viewer'];
// 名簿では日本語で書かれることが多いため、権限名の表記ゆれを吸収する。
// planning は本社の受け持ち（営業部・製品企画部）を指す内部名
const ROLE_ALIASES = {
  '営業担当者': 'sales', '営業': 'sales', '担当者': 'sales', 'sales': 'sales',
  '支店長': 'branch_manager', 'branch_manager': 'branch_manager',
  '広域担当': 'wide_area', '広域': 'wide_area', 'wide_area': 'wide_area',
  // 「営業部」は営業担当者と紛らわしいので入れない（名簿では「本社」と書いてもらう）
  '本社': 'planning', '製品企画部': 'planning', '営業企画部': 'planning',
  '企画': 'planning', 'planning': 'planning',
  '管理者': 'admin', 'admin': 'admin',
  '開発者': 'developer', 'developer': 'developer',
  '閲覧専用': 'viewer', '閲覧': 'viewer', '閲覧のみ': 'viewer', 'viewer': 'viewer',
};

/** 権限の日本語表記（一覧の出力用。取り込み直せるよう ROLE_ALIASES と揃える） */
const ROLE_LABELS = {
  sales: '営業担当者',
  branch_manager: '支店長',
  wide_area: '広域担当',
  planning: '本社',
  admin: '管理者',
  developer: '開発者',
  viewer: '閲覧専用',
};

function parseRole(v) {
  const s = String(v ?? '').trim();
  return ROLE_ALIASES[s] || (ROLES.includes(s) ? s : null);
}

/** メールアドレスの形（打ち間違いで通知が届かないのを防ぐ程度の確認） */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const badEmail = (v) => {
  const s = String(v ?? '').trim();
  return s !== '' && !EMAIL_RE.test(s);
};

/** 「〇/✓/1/true/はい/有」などを真偽値として読む */
function parseFlag(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return false;
  return ['1', 'true', 'yes', 'y', 'o', '○', '〇', '◯', '✓', 'はい', '有', '可', 'あり'].includes(s);
}

api.get('/admin/users', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  // 各利用者に何件見えるかも返す。
  // 支店・営業所の表記が案件データと合っていないと0件になり、
  // 本人からは「何も出ない」としか分からないため、管理側で気づけるようにする。
  // 案件の件数は「支店ごと」「担当者ごと」に1回だけ数え、人との突き合わせは
  // ここで行う。1人ずつ数え直すと17万件を人数ぶん走査してしまい、
  // 一覧が出るまでに20秒以上かかっていた（数え直しは3回の集計で済む）
  const [rows, all, byBranch, byPerson] = await Promise.all([
    db.all(`
      SELECT u.id, u.name, u.role, u.branch, u.office, u.title, u.email, u.active, u.login_id,
             u.last_login_at, u.must_change_password, u.locked_until,
             CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
             -- いまログインしたままの端末の数。共通IDが何人に渡っているかの目安になる
             (SELECT COUNT(*) FROM sessions s
               WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
        FROM users u ORDER BY u.id`, [now()]),
    db.get('SELECT COUNT(*) AS c FROM deals'),
    db.all(`SELECT branch, COUNT(*) AS c FROM deals
             WHERE branch IS NOT NULL AND branch <> '' GROUP BY branch`),
    db.all(`SELECT ${nameKey('sales_person')} AS k, COUNT(*) AS c
              FROM deals
             WHERE sales_person IS NOT NULL AND sales_person <> ''
             GROUP BY ${nameKey('sales_person')}`),
  ]);
  const total = Number(all?.c ?? 0);
  const branchCount = new Map(byBranch.map((r) => [r.branch, Number(r.c)]));
  const personCount = new Map(byPerson.map((r) => [r.k, Number(r.c)]));
  // 突合の鍵はSQL側と同じ（姓名の間の空白の違いを無視する）
  const key = (v) => String(v ?? '').replace(/[\s　]/g, '');
  const ALL_BRANCHES = ['admin', 'developer', 'planning', 'branch_manager', 'wide_area'];
  // 閲覧専用は支店にかかわらず全社（閲覧範囲の判定と揃える）
  const seesAll = (u) => ALL_BRANCHES.includes(u.role) || isViewerRole(u.role);
  res.json(rows.map((u) => ({
    ...u,
    visible_deals: seesAll(u) ? total : (branchCount.get(u.branch) ?? 0),
    person_deals: personCount.get(key(u.name)) ?? 0,
  })));
}));

api.post('/admin/users', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, role, branch, office, title, email, loginId } = req.body || {};
  if (!name || !role || !loginId) {
    return res.status(400).json({ error: '氏名・権限・ログインID（社員番号）は必須です' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: '権限の指定が不正です' });
  }
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(loginId)) {
    return res.status(400).json({ error: 'ログインIDは半角英数字・._- の3〜32文字で指定してください' });
  }
  if (badEmail(email)) {
    return res.status(400).json({ error: 'メールアドレスの形が正しくありません' });
  }
  const dup = await db.get('SELECT id FROM users WHERE login_id = ?', [loginId]);
  if (dup) return res.status(409).json({ error: 'そのログインIDは既に使われています' });

  // パスワードは発行しない。本人が初回ログイン時に「パスワード設定」から自分で決める
  const { lastInsertRowid } = await db.run(
    `INSERT INTO users (name, role, branch, office, title, email, login_id, password_hash, must_change_password)
     VALUES (?,?,?,?,?,?,?,NULL,0)`,
    [name, role, nv(branch), nv(office), nv(title), nv(email), loginId]
  );
  res.status(201).json({ id: Number(lastInsertRowid), loginId });
}));

// パスワードを未設定に戻す（忘れたとき用）。仮パスワードは発行せず、
// 本人がログイン画面の「パスワード設定」からもう一度自分で決める
api.post('/admin/users/:id/reset-password', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  await db.run(
    `UPDATE users SET password_hash = NULL, must_change_password = 0,
            failed_attempts = 0, locked_until = NULL WHERE id = ?`,
    [user.id]
  );
  await destroyUserSessions(user.id); // 既存のログインを打ち切る
  res.json({ ok: true, id: user.id, loginId: user.login_id });
}));

/**
 * その人のログインを全部打ち切る（全端末からログアウト）。
 *
 * 共通IDを個人ごとのIDへ切り替えるとき、パスワードを変えただけでは
 * すでに開いている端末はそのまま使えてしまう。ここで一度に断ち切る。
 * 端末を失くしたときにも使う。パスワードは変えないので、
 * 本人はこれまでのパスワードで入り直せる。
 */
api.post('/admin/users/:id/logout-all', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  await destroyUserSessions(user.id);
  res.json({ ok: true, id: user.id, loginId: user.login_id });
}));

api.patch('/admin/users/:id', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  if ('role' in (req.body || {}) && !ROLES.includes(String(req.body.role))) {
    return res.status(400).json({ error: '権限の指定が不正です' });
  }
  if (badEmail(req.body?.email)) {
    return res.status(400).json({ error: 'メールアドレスの形が正しくありません' });
  }
  const sets = [];
  const params = [];
  for (const [field, col] of [['name', 'name'], ['role', 'role'], ['branch', 'branch'],
    ['office', 'office'], ['title', 'title'], ['email', 'email']]) {
    if (field in (req.body || {})) { sets.push(`${col} = ?`); params.push(nv(req.body[field])); }
  }
  if ('loginId' in (req.body || {})) {
    const loginId = String(req.body.loginId ?? '').trim();
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(loginId)) {
      return res.status(400).json({ error: 'ログインIDは半角英数字・._- の3〜32文字で指定してください' });
    }
    const dup = await db.get('SELECT id FROM users WHERE login_id = ? AND id <> ?', [loginId, user.id]);
    if (dup) return res.status(409).json({ error: 'そのログインIDは既に使われています' });
    sets.push('login_id = ?');
    params.push(loginId);
  }
  if ('active' in (req.body || {})) {
    if (Number(req.params.id) === req.user.id && !req.body.active) {
      return res.status(400).json({ error: '自分自身を無効化することはできません' });
    }
    sets.push('active = ?');
    params.push(req.body.active ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: '更新項目がありません' });
  params.push(user.id);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  if (req.body?.active === false) await destroyUserSessions(user.id);
  res.json(await db.get(
    `SELECT id, name, role, branch, office, title, email, active, login_id, last_login_at,
             CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS has_password
     FROM users WHERE id = ?`, [user.id]));
}));

/**
 * 外部連携の状況。
 *
 * 環境変数はVercelの画面でしか設定できず、設定したつもりが効いていない、
 * という食い違いが起きやすい。ターミナルを使わずに確かめられるよう、
 * 「今この本番で何が有効か」を管理者だけに見せる。
 *
 * 鍵やパスワードそのものは返さない。有効か無効かと、
 * 判断の材料になる範囲（発行元・末尾の数文字など）だけにとどめる。
 */
api.get('/admin/status', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const hasBasic = Boolean(process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS);

  // お問い合わせの通知メール。鍵の有無と、実際に届く宛先の数を見せる
  const hasMailKey = Boolean((process.env.RESEND_API_KEY || '').trim());
  const staffMails = await db.get(
    `SELECT COUNT(*) AS c FROM users
      WHERE active = 1 AND email IS NOT NULL AND email <> ''
        AND role IN (${INQUIRY_ROLES.map(() => '?').join(',')})`, INQUIRY_ROLES).catch(() => null);
  const extraMails = String(process.env.MAIL_NOTIFY_TO ?? '')
    .split(',').map((v) => v.trim()).filter(Boolean);
  const mailTo = Number(staffMails?.c ?? 0) + extraMails.length;

  // 添付の実際の保管先。設定だけでなく既存データの内訳も見せる
  // （切り替え前に保存したものはDBに残るため）
  const attach = await db.get(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN blob_url IS NOT NULL AND blob_url <> '' THEN 1 ELSE 0 END) AS on_blob
      FROM attachments`).catch(() => null);

  res.json({
    platform: process.env.VERCEL ? 'vercel' : 'self',
    db: db.kind,
    items: [
      {
        // サイト全体の遮断はVercel側（Deployment Protection）で行う。
        // アプリのBasic認証はVercelでは /api にしか掛からない
        // （画面のファイルはCDNが直接返し、サーバーを通らないため）。
        key: 'basic',
        name: 'URLを知っている人からの遮断',
        ok: hasBasic,
        detail: hasBasic
          ? `アプリ側のBasic認証が有効（利用者名: ${process.env.BASIC_AUTH_USER}）。`
            + 'ただしVercelでは /api にしか掛かりません'
          : '未設定。個人ごとのログインで守っています（未ログインでは価格データは出ません）',
        hint: 'サイト全体を1つのパスワードで囲うときは、Vercel → Settings →'
          + ' Deployment Protection → Password Protection（独自ドメインにも掛かります）',
      },
      {
        key: 'files',
        name: '添付ファイルの保管先（Supabase Storage）',
        ok: isFileStoreConfigured(),
        detail: isFileStoreConfigured()
          ? `Supabaseの保管庫「${fileBucket()}」に保存します`
            + `（登録済み ${num(attach?.total)}件のうち ${num(attach?.on_blob)}件が保管庫）`
          : `未設定のためデータベースに保存します（登録済み ${num(attach?.total)}件）`,
        hint: 'Vercel → Settings → Environment Variables に SUPABASE_SERVICE_ROLE_KEY'
          + '（保管庫の名前を変えるときは SUPABASE_BUCKET）。設定後は再デプロイが必要です',
      },
      {
        key: 'mail',
        name: 'お問い合わせの通知メール（Resend）',
        ok: hasMailKey && mailTo > 0,
        detail: !hasMailKey
          ? 'RESEND_API_KEY が未設定のため、通知メールは送られません（お問い合わせの受付とアプリ内での回答は通常どおり動きます）'
          : mailTo === 0
            ? '鍵は設定済みですが、宛先が0件です。本社（営業部・製品企画部）・管理者にメールを登録してください'
            : `有効（宛先 ${mailTo}件 / 差出人: ${process.env.MAIL_FROM || '価格改定進捗 <noreply@paloma-pf.com>'}）`,
        hint: 'Vercel → Settings → Environment Variables に RESEND_API_KEY'
          + '（任意で MAIL_FROM / APP_ORIGIN / MAIL_NOTIFY_TO）。設定後は再デプロイが必要です',
      },
    ],
  });
}));

/**
 * メール通知のテスト送信。
 *
 * 鍵が正しいかどうかは、実際に送ってみないと分からない
 * （設定されていても、失効した鍵や別アカウントの鍵だと拒まれる）。
 * 管理者が自分のメール宛に1通送り、Resendの応答をそのまま画面に返す。
 */
api.post('/admin/mail-test', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const own = String(req.user.email ?? '').trim();
  const extra = String(process.env.MAIL_NOTIFY_TO ?? '')
    .split(',').map((v) => v.trim()).filter(Boolean);
  const to = own || extra[0];
  if (!to) {
    return res.status(400).json({
      error: 'ご自身のメールが未登録です。ユーザー一覧の「編集」でメールを入れてからお試しください',
    });
  }
  const { subject, html } = testMail(req.user.name, req.user);
  const r = await sendMail({ to, subject, html });
  if (!r.ok) {
    return res.status(502).json({ error: `送信できませんでした: ${r.error}`, to, from: mailFrom() });
  }
  res.json({ ok: true, to, from: mailFrom() });
}));

/**
 * 取込データの点検。
 *
 * 支店・営業所・担当者・器具区分名は名前が入る欄で、数字だけの値が
 * 入っていたら取込時の列ズレや入力ミスの可能性が高い
 * （例: 営業所に「24000」）。壊れた値は絞り込みの選択肢にも紛れ込むため、
 * 見つけて直せるよう、疑わしい値と件数を管理者に見せる。
 */
api.get('/admin/data-check', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;

  // 名前として疑わしい値:
  //  ・数字で始まる（「24000」「10:プロパン会社」= 業種などのコード付き値の紛れ込み）
  //  ・日本語（かな・カナ・漢字）を1文字も含まない（「TA」「LP」などの記号だけの値）
  const suspicious = (raw) => {
    const s = String(raw).trim();
    if (/^[0-9０-９]/.test(s)) return true;
    return !/[぀-ヿ㐀-鿿豈-﫿々〆]/.test(s);
  };

  const findings = [];
  for (const [col, label, param] of [
    ['branch', '支店', 'branch'],
    ['office', '営業所', 'office'],
    ['sales_person', '担当者', 'person'],
    ['equip_name', '器具区分名', 'equip'],
  ]) {
    // 値の種類は少ない（営業所名など）ので、まとめて数えてから手元で判定する
    const rows = await db.all(`
      SELECT ${col} AS value, COUNT(*) AS deals
        FROM deals
       WHERE ${col} IS NOT NULL AND ${col} <> ''
       GROUP BY ${col}`);
    for (const r of rows) {
      if (suspicious(r.value)) {
        findings.push({ column: col, label, param, value: r.value, deals: Number(r.deals) });
      }
    }
  }
  findings.sort((a, b) => b.deals - a.deals);

  // 法人名が空の案件。過去の取込で入り込むと一覧の絞り込みに「(空白)」として出て、
  // どの法人の案件なのか分からない行になる。件数を出して消せるようにする。
  const blank = await db.get(BLANK_CORP_COUNT_SQL);
  res.json({ findings, blankCorp: Number(blank?.n ?? 0) });
}));

/**
 * 法人名が実質「空」の案件を選ぶ条件。
 *
 * 実績ファイルは集計ソフトの出力で、法人グループの付いていない行は
 * コードも名前も「(空白)」という文字で入ってくる。空文字と同じに扱う。
 */
const BLANK_CORP_WHERE = `corp_name IS NULL OR TRIM(corp_name) = ''
  OR REPLACE(REPLACE(TRIM(corp_name), '（', '('), '）', ')')
     IN ('(空白)', '(blank)', '(Blank)', '(BLANK)', '空白', '-', '－', '―', 'ー')`;
const BLANK_CORP_COUNT_SQL = `SELECT COUNT(*) AS n FROM deals WHERE ${BLANK_CORP_WHERE}`;

/**
 * 法人名が空の案件をまとめて消す。
 *
 * 案件一覧は出荷実績（法人×品目）が土台なので、法人名の無い行は行き先が無い。
 * 取込時にも掃除しているが、過去の取込で入り込んだ分をその場で消せるようにする。
 */
api.post('/admin/cleanup-blank-corp', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  for (const sql of [
    `DELETE FROM attachments WHERE deal_id IN (SELECT id FROM deals WHERE ${BLANK_CORP_WHERE})`,
    `DELETE FROM notifications WHERE deal_id IN (SELECT id FROM deals WHERE ${BLANK_CORP_WHERE})`,
  ]) {
    try { await db.run(sql); } catch { /* 無ければ何もしない */ }
  }
  invalidateMetaCache();
  const r = await db.run(`DELETE FROM deals WHERE ${BLANK_CORP_WHERE}`);
  const { total } = await db.get('SELECT COUNT(*) AS total FROM deals');
  try { await db.run('VACUUM deals'); } catch { /* 自動VACUUMに任せる */ }
  res.json({ removed: Number(r?.changes ?? 0), total: Number(total) });
}));

// ---- 全国基準価格表（マスター） ----

/**
 * 基準価格表のExcelを取り込んでマスターを差し替える。
 * ファイルは小さい（数十器種）のでそのまま受け取る。
 */
api.post('/admin/standard-prices', upload.single('file'), wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'ファイルを選択してください' });
  let rows;
  try {
    rows = parseStandardWorkbook(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const count = await replaceStandardPrices(rows, decodeUploadName(req.file.originalname), req.user.id);
  const models = new Set(rows.map((r) => `${r.region}:${r.model_key}`)).size;
  res.json({ count, models, regions: [...new Set(rows.map((r) => r.region))] });
}));

/** マスターの一覧。器種ごとに区分の単価を並べて返す */
api.get('/standard-prices', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const rows = await db.all(`
    SELECT region, category, model_gas_code, model_name, kubun, current_price, target_price
      FROM standard_prices ORDER BY region, id`);
  const meta = await db.get("SELECT value FROM settings WHERE key = 'standard_prices_meta'");
  res.json({ rows, kubuns: KUBUNS, meta: meta ? JSON.parse(meta.value) : null });
}));

/**
 * 案件データに出てくる担当者の一覧。
 *
 * 管理表には担当者コードが無く氏名しか入っていないため、氏名で名寄せする。
 * 案件一覧の担当者絞り込みも氏名で効くので、登録するユーザーの氏名は
 * 案件データの表記とそろえる必要がある。
 */
api.get('/admin/deal-persons', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const rows = await db.all(`
    SELECT sales_person AS name,
           MAX(branch) AS branch,
           MAX(office) AS office,
           COUNT(*)    AS deals
      FROM deals
     WHERE sales_person IS NOT NULL AND sales_person <> ''
     GROUP BY sales_person
     ORDER BY COUNT(*) DESC`);

  const users = await db.all('SELECT id, name, login_id, role, active FROM users');
  const byName = new Map(users.map((u) => [u.name, u]));
  const usedLoginIds = new Set(users.map((u) => u.login_id).filter(Boolean));

  // ログインIDは管理表から作れない（氏名の読みが定まらない）ため、
  // 連番の候補を出して画面で直せるようにする。
  let seq = 0;
  const nextSuggestion = () => {
    let candidate;
    do {
      seq += 1;
      candidate = `sales${String(seq).padStart(3, '0')}`;
    } while (usedLoginIds.has(candidate));
    usedLoginIds.add(candidate);
    return candidate;
  };

  res.json(rows.map((r) => {
    const existing = byName.get(r.name);
    return {
      name: r.name,
      branch: r.branch,
      office: r.office,
      deals: Number(r.deals),
      registered: Boolean(existing),
      existingLoginId: existing?.login_id ?? null,
      existingRole: existing?.role ?? null,
      suggestedLoginId: existing ? null : nextSuggestion(),
    };
  }));
}));

/**
 * 案件データの担当者をまとめて営業担当者として登録する。
 * 氏名が既に登録されている人は作らない（重複した利用者ができてしまうため）。
 */
api.post('/admin/deal-persons', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const list = Array.isArray(req.body?.people) ? req.body.people : null;
  if (!list?.length) return res.status(400).json({ error: '登録する担当者を指定してください' });
  if (list.length > 500) return res.status(400).json({ error: '一度に登録できるのは500名までです' });

  const created = [];
  const skipped = [];
  const errors = [];

  // 同じ要求の中での重複も弾く
  const seenNames = new Set();
  const seenLoginIds = new Set();

  for (const item of list) {
    const name = String(item?.name ?? '').trim();
    const loginId = String(item?.loginId ?? '').trim();
    if (!name) { errors.push({ message: '氏名が空の行があります' }); continue; }

    if (seenNames.has(name)) { skipped.push({ name, message: '同じ氏名が重複しています' }); continue; }
    seenNames.add(name);

    if (!/^[A-Za-z0-9._-]{3,32}$/.test(loginId)) {
      errors.push({ name, message: 'ログインIDは半角英数字・._- の3〜32文字で指定してください' });
      continue;
    }
    if (seenLoginIds.has(loginId)) {
      errors.push({ name, message: `ログインID ${loginId} が重複しています` });
      continue;
    }
    seenLoginIds.add(loginId);

    const byName = await db.get('SELECT id, login_id FROM users WHERE name = ?', [name]);
    if (byName) {
      skipped.push({ name, message: `既に登録済みです（${byName.login_id ?? 'IDなし'}）` });
      continue;
    }
    const byLoginId = await db.get('SELECT id FROM users WHERE login_id = ?', [loginId]);
    if (byLoginId) {
      errors.push({ name, message: `ログインID ${loginId} は既に使われています` });
      continue;
    }

    // パスワードは発行しない。本人が初回ログイン時に「パスワード設定」から自分で決める
    await db.run(
      `INSERT INTO users (name, role, branch, office, login_id, password_hash, must_change_password)
       VALUES (?, 'sales', ?, ?, ?, NULL, 0)`,
      [name, nv(item?.branch) || null, nv(item?.office) || null, loginId]);
    created.push({ name, loginId });
  }

  console.warn(`案件データの担当者を登録しました（追加 ${created.length}名 / 見送り ${skipped.length}名 / エラー ${errors.length}件）`);
  res.json({ created, skipped, errors });
}));

/**
 * ユーザーが残した記録の件数。
 * これらが残っている人を消すと「誰がやったか」が辿れなくなるため、削除を止める材料にする。
 */
async function userRecordCounts(userId) {
  const one = async (sql) => Number((await db.get(sql, [userId]))?.c ?? 0);
  const [logs, corps, batches, files] = await Promise.all([
    one('SELECT COUNT(*) AS c FROM negotiation_logs WHERE user_id = ?'),
    one('SELECT COUNT(*) AS c FROM corp_negotiations WHERE updated_by = ?'),
    one('SELECT COUNT(*) AS c FROM import_batches WHERE imported_by = ?'),
    one('SELECT COUNT(*) AS c FROM attachments WHERE uploaded_by = ?'),
  ]);
  return { logs, corps, batches, files, total: logs + corps + batches + files };
}

api.delete('/admin/users/:id', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  if (user.id === req.user.id) {
    return res.status(400).json({ error: '自分自身を削除することはできません' });
  }

  // 実際には、削除できるのは管理者本人だけで自分自身は消せないため、
  // 少なくとも実行者が管理者として残る。ここはその前提が崩れたときの保険。
  if (user.role === 'admin') {
    const { c } = await db.get(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", [user.id]);
    if (Number(c) === 0) {
      return res.status(400).json({ error: '管理者が居なくなるため、最後の管理者は削除できません' });
    }
  }

  // 記録を残している人は消さない。消すと交渉履歴や取込の実行者が辿れなくなる。
  const counts = await userRecordCounts(user.id);
  if (counts.total > 0) {
    const detail = [
      counts.logs && `交渉履歴 ${counts.logs}件`,
      counts.corps && `法人の交渉情報 ${counts.corps}件`,
      counts.batches && `Excel取込 ${counts.batches}件`,
      counts.files && `添付ファイル ${counts.files}件`,
    ].filter(Boolean).join('・');
    return res.status(409).json({
      error: `${user.name} には記録が残っているため削除できません（${detail}）。`
           + '「停止」にすればログインできなくなり、記録は残ります',
      canDeactivate: true,
    });
  }

  await destroyUserSessions(user.id);
  await db.run('DELETE FROM users WHERE id = ?', [user.id]);
  console.warn(`ユーザーを削除しました（${user.login_id ?? '—'} / ${user.name}）`);
  res.json({ ok: true, deleted: { id: user.id, name: user.name, loginId: user.login_id } });
}));

/**
 * ユーザーの一括削除。設定画面でチェックした人をまとめて消す。
 * 判定は1件削除と同じ（自分自身・最後の管理者・記録の残っている人は消さない）。
 * 消せない人が混ざっていても全体は止めず、理由を添えて返す。
 */
api.post('/admin/users/bulk-delete', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return res.status(400).json({ error: '削除するユーザーを選んでください' });
  if (ids.length > 500) return res.status(400).json({ error: '一度に削除できるのは500名までです' });

  const deleted = [];
  const skipped = [];
  for (const id of ids) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) { skipped.push({ id, name: `ID ${id}`, message: '見つかりません' }); continue; }
    if (user.id === req.user.id) {
      skipped.push({ id, name: user.name, message: '自分自身は削除できません' });
      continue;
    }
    if (user.role === 'admin') {
      // ループの途中で管理者を消していくため、残りは毎回数え直す
      const { c } = await db.get(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", [user.id]);
      if (Number(c) === 0) {
        skipped.push({ id, name: user.name, message: '最後の管理者は削除できません' });
        continue;
      }
    }
    const counts = await userRecordCounts(user.id);
    if (counts.total > 0) {
      const detail = [
        counts.logs && `交渉履歴 ${counts.logs}件`,
        counts.corps && `法人の交渉情報 ${counts.corps}件`,
        counts.batches && `Excel取込 ${counts.batches}件`,
        counts.files && `添付ファイル ${counts.files}件`,
      ].filter(Boolean).join('・');
      skipped.push({ id, name: user.name, message: `記録が残っているため削除できません（${detail}）。停止をお使いください` });
      continue;
    }
    await destroyUserSessions(user.id);
    await db.run('DELETE FROM users WHERE id = ?', [user.id]);
    deleted.push({ id: user.id, name: user.name, loginId: user.login_id });
  }
  if (deleted.length) {
    console.warn(`ユーザーを一括削除しました（${deleted.length}名: ${deleted.map((d) => d.loginId ?? d.name).join(', ')}）`);
  }
  res.json({ deleted, skipped });
}));

// ---- お問い合わせ（ポータルと同じ仕様） ----
//
//   POST /inquiries        … 送信。ログイン中は分類を選んで送る。
//                            未ログインは分類「ログインできない」だけ受け付ける
//                            （ログイン画面の「管理者への問い合わせ」用）。
//   GET  /inquiries        … 管理者向けの一覧（未対応を上に）。
//   GET  /inquiries/mine   … 本人の履歴と回答。未読の回答数も返す。
//   PATCH /inquiries/:id   … 管理者の対応。{status} か {reply}（回答すると対応済み＋本人未読）。
//   PATCH /inquiries/mine/:id/read … 本人が回答を既読にする。

/**
 * 問い合わせ分類（画面の選択肢と一致させる）。宛先ごとに分ける。
 * アプリの使い方や不具合は管理者、値決めや交渉の進め方は営業部・製品企画部が受ける。
 */
const INQUIRY_CATEGORIES_BY_DEST = {
  app: [
    'ログインできない',
    'アプリのエラー・不具合',
    'アカウント・権限（支店／営業所／担当）',
    '操作方法について',
    '機能の要望・改善',
    'その他（アプリ）',
  ],
  sales: [
    '価格・単価について',
    '値上げ交渉の進め方',
    '取込データの内容について',
    '集計・数字の見方',
    'その他（営業本部）',
  ],
};
const INQUIRY_CATEGORIES = Object.values(INQUIRY_CATEGORIES_BY_DEST).flat();

// 送信のレート制限（同一IP 10分5回。ポータルの /api/contact と同じ）
const INQUIRY_RL = new Map();
function inquiryRateLimited(ip) {
  const nowMs = Date.now();
  const WIN = 10 * 60 * 1000;
  const MAX = 5;
  const arr = (INQUIRY_RL.get(ip) || []).filter((t) => nowMs - t < WIN);
  if (arr.length >= MAX) { INQUIRY_RL.set(ip, arr); return true; }
  arr.push(nowMs);
  INQUIRY_RL.set(ip, arr);
  return false;
}

api.post('/inquiries', wrap(async (req, res) => {
  const body = req.body || {};
  // ハニーポット（画面には見えない欄）。値が入っていたら機械の送信とみなし、
  // 通ったように見せて保存しない（ポータルと同じ）
  if (String(body.website ?? '').trim() !== '') return res.json({ ok: true });

  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown';
  if (inquiryRateLimited(ip)) {
    return res.status(429).json({ error: '送信回数が多すぎます。時間をおいて再度お試しください' });
  }

  const category = String(body.category ?? '').trim();
  const message = String(body.message ?? '').trim();
  const dest = destOf(body.dest);
  if (!INQUIRY_CATEGORIES_BY_DEST[dest].includes(category)) {
    return res.status(400).json({ error: '分類を選んでください' });
  }
  if (!message) return res.status(400).json({ error: '内容を入力してください' });
  if (message.length > 2000) return res.status(400).json({ error: '内容は2000文字以内で入力してください' });

  let loginId;
  let name;
  // 通知メールに「どこの誰から」を出すための所属。
  // 未ログインの送信でも、社員番号で登録者が見つかれば補う
  let from = {};
  if (req.user) {
    loginId = req.user.login_id ?? null;
    name = req.user.name;
    from = req.user;
  } else {
    // 未ログインで送れるのは「ログインできない」（管理者宛）だけ
    if (dest !== 'app' || category !== 'ログインできない') {
      return res.status(401).json({ error: 'ログインしてください' });
    }
    loginId = String(body.loginId ?? '').trim();
    name = String(body.name ?? '').trim();
    if (!loginId || !name) return res.status(400).json({ error: '社員番号と氏名を入力してください' });
    if (loginId.length > 64 || name.length > 100) {
      return res.status(400).json({ error: '社員番号・氏名が長すぎます' });
    }
    from = await db.get(
      'SELECT branch, office, title FROM users WHERE login_id = ?', [loginId]
    ).catch(() => null) ?? {};
  }

  const ins = await db.run(
    `INSERT INTO inquiries (user_id, login_id, name, dest, category, message, status, created_at)
     VALUES (?,?,?,?,?,?, 'open', ?)`,
    [req.user?.id ?? null, loginId, name, dest, category, message, now()]
  );
  // 受付はここで完了。回答担当者への通知は待たせずに送る
  res.status(201).json({ ok: true });
  await notifyInquiry({
    id: ins?.lastInsertRowid, login_id: loginId, name, dest, category, message,
    branch: from.branch ?? null, office: from.office ?? null, title: from.title ?? null,
  });
}));

api.get('/inquiries', wrap(async (req, res) => {
  if (!requireInquiryStaff(req, res)) return;
  // 自分が受け持つ宛先だけ（営業部・製品企画部には営業本部内のことだけが届く）。
  // 宛先の無い古い分は、これまでどおり管理者が見る「アプリのこと」として扱う
  const dests = destsFor(req.user.role);
  const cond = dests.map(() => '?').join(',');
  const legacy = dests.includes('app') ? " OR i.dest IS NULL OR i.dest = ''" : '';
  // 未対応を上に、その中では新しい順
  // 送信者の所属（支店・営業所・役職）も添える。誰からの問い合わせかが
  // 分からないと、回答の重さも当たり先も判断できないため。
  // ログイン前に送られた分は user_id が無いので、社員番号で引き当てる
  const rows = await db.all(`
    SELECT i.*,
           COALESCE(u.branch, u2.branch) AS branch,
           COALESCE(u.office, u2.office) AS office,
           COALESCE(u.title,  u2.title)  AS title
      FROM inquiries i
      LEFT JOIN users u  ON u.id = i.user_id
      LEFT JOIN users u2 ON i.user_id IS NULL AND u2.login_id = i.login_id
     WHERE i.dest IN (${cond})${legacy}
     ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.id DESC`, dests);
  res.json(rows);
}));

api.get('/inquiries/mine', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  // ログイン前（ログイン画面の問い合わせ）に送った分も、同じ社員番号なら履歴に出す
  const rows = await db.all(`
    SELECT * FROM inquiries
     WHERE user_id = ? OR (login_id IS NOT NULL AND login_id = ?)
     ORDER BY id DESC`, [req.user.id, req.user.login_id ?? '']);
  const unread = rows.filter((r) => r.reply && !r.read_at).length;
  res.json({ rows, unread });
}));

api.patch('/inquiries/mine/:id/read', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const row = await db.get('SELECT * FROM inquiries WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '問い合わせが見つかりません' });
  const mine = row.user_id === req.user.id
    || (row.login_id != null && row.login_id === (req.user.login_id ?? ''));
  if (!mine) return res.status(403).json({ error: '自分の問い合わせだけ既読にできます' });
  await db.run('UPDATE inquiries SET read_at = ? WHERE id = ?', [now(), row.id]);
  res.json({ ok: true });
}));

/**
 * 問い合わせを消す。
 *
 * 送った本人は自分の分を、回答担当は自分が受け持つ宛先の分を消せる。
 * 履歴が溜まると本当に見るべきものが埋もれるため、
 * 済んだやり取りを片づけられるようにする。消したものは戻せない。
 */
api.delete('/inquiries/:id', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const row = await db.get('SELECT * FROM inquiries WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '問い合わせが見つかりません' });
  const mine = row.user_id === req.user.id
    || (row.login_id != null && row.login_id === (req.user.login_id ?? ''));
  // 宛先の無い古い分は「アプリのこと」として扱う（一覧の出し方と同じ）
  const staff = destsFor(req.user.role).includes(destOf(row.dest));
  if (!mine && !staff) {
    return res.status(403).json({ error: '自分の問い合わせか、受け持ちの問い合わせだけ消せます' });
  }
  await db.run('DELETE FROM inquiries WHERE id = ?', [row.id]);
  res.json({ ok: true });
}));

/**
 * 選んだ問い合わせをまとめて消す。
 *
 * 1件ずつ消せるようにはしてあるが、溜まった分を片づけるには押す回数が多い。
 * 消せるかどうかの判定は1件ずつと同じで、消せない分は消さずに数だけ返す。
 */
api.post('/inquiries/delete', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))].slice(0, 500)
    : [];
  if (!ids.length) return res.status(400).json({ error: '消すお問い合わせを選んでください' });
  const rows = await db.all(
    `SELECT * FROM inquiries WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const dests = destsFor(req.user.role);
  const mayDelete = (row) => row.user_id === req.user.id
    || (row.login_id != null && row.login_id === (req.user.login_id ?? ''))
    // 宛先の無い古い分は「アプリのこと」として扱う（一覧の出し方と同じ）
    || dests.includes(destOf(row.dest));
  const targets = rows.filter(mayDelete).map((r) => r.id);
  if (targets.length) {
    await db.run(
      `DELETE FROM inquiries WHERE id IN (${targets.map(() => '?').join(',')})`, targets);
  }
  // 見つからなかった分（すでに誰かが消した分）は、消せたものとして数えない。
  // 画面は消し終えたあとに一覧を取り直すので、そこで消えていることが分かる
  res.json({ deleted: targets.length, skipped: ids.length - targets.length });
}));

api.patch('/inquiries/:id', wrap(async (req, res) => {
  if (!requireInquiryStaff(req, res)) return;
  const row = await db.get('SELECT * FROM inquiries WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '問い合わせが見つかりません' });
  if (!destsFor(req.user.role).includes(destOf(row.dest))) {
    return res.status(403).json({ error: '受け持ちの問い合わせだけ対応できます' });
  }

  if ('reply' in (req.body || {})) {
    const reply = String(req.body.reply ?? '').trim();
    if (!reply) return res.status(400).json({ error: '回答を入力してください' });
    if (reply.length > 2000) return res.status(400).json({ error: '回答は2000文字以内で入力してください' });
    // 回答すると自動で対応済みになり、本人には未読として届く（ポータルと同じ）
    await db.run(
      `UPDATE inquiries SET reply = ?, replied_by = ?, replied_at = ?,
              status = 'resolved', read_at = NULL WHERE id = ?`,
      [reply, req.user.name, now(), row.id]);
  } else if ('status' in (req.body || {})) {
    const status = String(req.body.status ?? '');
    if (!['open', 'resolved'].includes(status)) {
      return res.status(400).json({ error: '状態は open / resolved のいずれかです' });
    }
    await db.run('UPDATE inquiries SET status = ? WHERE id = ?', [status, row.id]);
  } else {
    return res.status(400).json({ error: '更新項目がありません' });
  }
  res.json(await db.get('SELECT * FROM inquiries WHERE id = ?', [row.id]));
}));

// ---- お知らせ（全員への連絡） ----
//
// 問い合わせが「一人から本社へ」なのに対して、お知らせは「本社から全員へ」。
// 出せるのは本社（営業部・製品企画部）と管理者で、全員の画面に届く。
// 読んだかどうかは人ごとに持ち、未読があるあいだは画面の上に帯を出す。
//
//   GET    /announcements          … 一覧と未読の件数。掲載の終わった分は担当者にだけ出す
//   POST   /announcements          … 出す（担当者のみ）
//   PATCH  /announcements/:id      … 直す（担当者のみ）
//   DELETE /announcements/:id      … 消す（担当者のみ）
//   POST   /announcements/:id/read … 既読にする（本人）
//   POST   /announcements/read-all … 出ているお知らせをまとめて既読にする（本人）

/** お知らせの重み。important=重要（赤・一覧の上）／info=お知らせ（青） */
const ANNOUNCE_LEVELS = ['info', 'important'];
const levelOf = (v) => (ANNOUNCE_LEVELS.includes(String(v ?? '')) ? String(v) : 'info');

/** 掲載中かどうかの条件。掲載の終わりが未設定か、今日以降なら出す */
const LIVE_COND = "(a.ends_at IS NULL OR a.ends_at = '' OR a.ends_at >= ?)";

/** 入力の点検。見出しと本文は必須で、長すぎるものは受けない */
function readAnnounceBody(body) {
  const title = String(body?.title ?? '').trim();
  const text = String(body?.body ?? '').trim();
  if (!title) return { error: '見出しを入力してください' };
  if (title.length > 120) return { error: '見出しは120文字以内で入力してください' };
  if (!text) return { error: '本文を入力してください' };
  if (text.length > 4000) return { error: '本文は4000文字以内で入力してください' };
  const endsAt = String(body?.endsAt ?? '').trim();
  if (endsAt && !/^\d{4}-\d{2}-\d{2}$/.test(endsAt)) {
    return { error: '掲載の終わりは日付で入力してください' };
  }
  return { title, text, endsAt: endsAt || null, level: levelOf(body?.level) };
}

api.get('/announcements', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const today = localDate();
  const staff = isInquiryStaff(req.user.role);
  // 担当者には掲載の終わった分も出す（直したり消したりできるように）。
  // ほかの人には掲載中のものだけ。
  const rows = await db.all(`
    SELECT a.*, r.read_at
      FROM announcements a
      LEFT JOIN announcement_reads r
             ON r.announcement_id = a.id AND r.user_id = ?
     ${staff ? '' : `WHERE ${LIVE_COND}`}
     ORDER BY CASE a.level WHEN 'important' THEN 0 ELSE 1 END, a.id DESC`,
  staff ? [req.user.id] : [req.user.id, today]);
  const live = (a) => !a.ends_at || a.ends_at >= today;
  res.json({
    rows: rows.map((a) => ({ ...a, live: live(a) })),
    // 未読は掲載中のものだけ数える（終わった分で帯が出続けないように）
    unread: rows.filter((a) => live(a) && !a.read_at).length,
    canPost: staff,
  });
}));

api.post('/announcements', wrap(async (req, res) => {
  if (!requireInquiryStaff(req, res)) return;
  const v = readAnnounceBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const stamp = now();
  const r = await db.run(
    `INSERT INTO announcements (title, body, level, ends_at, created_by, created_by_name, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [v.title, v.text, v.level, v.endsAt, req.user.id, req.user.name, stamp]);
  // 新しい行のID（PostgreSQLでは RETURNING id が自動で付く）
  const id = r?.lastInsertRowid ?? null;
  // 出した本人は読んだものとして扱う（自分の出したお知らせで未読が付かないように）
  if (id) {
    await db.run(
      `INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?,?,?)
       ON CONFLICT (announcement_id, user_id) DO NOTHING`, [id, req.user.id, stamp]);
  }
  res.json({ ok: true, id });
}));

api.patch('/announcements/:id', wrap(async (req, res) => {
  if (!requireInquiryStaff(req, res)) return;
  const row = await db.get('SELECT * FROM announcements WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'お知らせが見つかりません' });
  const v = readAnnounceBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  await db.run(
    `UPDATE announcements SET title = ?, body = ?, level = ?, ends_at = ?, updated_at = ?
      WHERE id = ?`,
    [v.title, v.text, v.level, v.endsAt, now(), row.id]);
  res.json({ ok: true });
}));

api.delete('/announcements/:id', wrap(async (req, res) => {
  if (!requireInquiryStaff(req, res)) return;
  const row = await db.get('SELECT * FROM announcements WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'お知らせが見つかりません' });
  await db.run('DELETE FROM announcement_reads WHERE announcement_id = ?', [row.id]);
  await db.run('DELETE FROM announcements WHERE id = ?', [row.id]);
  res.json({ ok: true });
}));

api.post('/announcements/read-all', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const stamp = now();
  const rows = await db.all(
    `SELECT a.id FROM announcements a WHERE ${LIVE_COND}`, [localDate()]);
  for (const a of rows) {
    await db.run(
      `INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?,?,?)
       ON CONFLICT (announcement_id, user_id) DO NOTHING`, [a.id, req.user.id, stamp]);
  }
  res.json({ ok: true, read: rows.length });
}));

api.post('/announcements/:id/read', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const row = await db.get('SELECT * FROM announcements WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'お知らせが見つかりません' });
  await db.run(
    `INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?,?,?)
     ON CONFLICT (announcement_id, user_id) DO NOTHING`, [row.id, req.user.id, now()]);
  res.json({ ok: true });
}));

// ---- ユーザーの一括登録 ----

// 名簿の列見出し → 内部項目。表記ゆれをある程度吸収する。
// 「ログインID（社員番号）」のような括弧の補足つきの見出しは、
// 突き合わせの前に括弧の中身を取り除く（normalizeUserHeader）
const USER_HEADER_MAP = {
  'ログインID': 'loginId', 'ログインid': 'loginId', 'loginid': 'loginId', 'ID': 'loginId', 'id': 'loginId',
  '社員番号': 'loginId', '社員No': 'loginId',
  '氏名': 'name', '名前': 'name', '担当者名': 'name', 'name': 'name',
  '役割': 'role', '権限': 'role', 'ロール': 'role', 'role': 'role',
  '役職': 'title', 'title': 'title',
  'メール': 'email', 'メールアドレス': 'email', 'email': 'email', 'mail': 'email',
  '支店': 'branch', '支店名': 'branch', '管轄': 'branch', 'branch': 'branch',
  '営業所': 'office', '営業所名': 'office', '部署': 'office', 'office': 'office',
  '有効': 'active',
};

/** 見出しの正規化。「支店（管轄）」→「支店」のように括弧の補足と空白を除く */
function normalizeUserHeader(h) {
  return String(h ?? '').trim()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s　]/g, '');
}

/**
 * 名簿（Excel / CSV）を読んでユーザーの登録内容を組み立てる。
 * 1行でも問題があれば、その行だけを飛ばして理由を返す。
 * 途中で止めると「何人入って何人入らなかったか」が分からなくなるため。
 */
function parseUserRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('シートが見つかりません');
  // 空行も残す。行番号がExcelの行と一致しないと、エラーの指摘先がずれる
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true });

  // 見出し行を探す（「氏名」または「ログインID」を含む行。括弧の補足つきも受ける）
  let hi = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const cells = (grid[i] || []).map((c) => normalizeUserHeader(c));
    if (cells.some((c) => c === '氏名' || c === '名前' || /^ログインID$/i.test(c) || c === '社員番号')) { hi = i; break; }
  }
  if (hi < 0) throw new Error('見出し行が見つかりません。「ログインID（社員番号）」「氏名」「権限」を含む行が必要です');

  const headers = (grid[hi] || []).map((h) => normalizeUserHeader(h));
  const colIndex = {};
  headers.forEach((h, i) => {
    const key = USER_HEADER_MAP[h] ?? USER_HEADER_MAP[h.toLowerCase()];
    if (key && colIndex[key] === undefined) colIndex[key] = i;
  });
  if (colIndex.loginId === undefined || colIndex.name === undefined) {
    throw new Error('「ログインID」と「氏名」の列が必要です');
  }

  const rows = [];
  const errors = [];
  for (let i = hi + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    const cell = (key) => (colIndex[key] === undefined ? null : row[colIndex[key]]);
    const loginId = String(cell('loginId') ?? '').trim();
    const name = String(cell('name') ?? '').trim();
    if (!loginId && !name) continue; // 空行
    const lineNo = i + 1;

    if (!/^[A-Za-z0-9._-]{3,32}$/.test(loginId)) {
      errors.push({ line: lineNo, loginId, message: 'ログインIDは半角英数字・._- の3〜32文字で指定してください' });
      continue;
    }
    if (!name) { errors.push({ line: lineNo, loginId, message: '氏名が空です' }); continue; }

    const roleRaw = cell('role');
    const role = roleRaw == null || String(roleRaw).trim() === '' ? 'sales' : parseRole(roleRaw);
    if (!role) {
      errors.push({ line: lineNo, loginId, message: `権限「${String(roleRaw).trim()}」を判別できません（営業担当者/支店長/広域担当/本社/管理者）` });
      continue;
    }

    const email = nv(cell('email'));
    if (badEmail(email)) {
      errors.push({ line: lineNo, loginId, message: `メールアドレス「${String(email).trim()}」の形が正しくありません` });
      continue;
    }

    const branch = nv(cell('branch'));

    // 「有効」列が無い、または空欄なら有効として扱う
    const activeRaw = colIndex.active === undefined ? '' : String(cell('active') ?? '').trim();
    rows.push({
      line: lineNo,
      loginId,
      name,
      role,
      branch,
      office: nv(cell('office')),
      title: nv(cell('title')),
      email,
      active: activeRaw === '' ? true : parseFlag(activeRaw),
    });
  }
  return { rows, errors };
}

api.post('/admin/users/import', upload.single('file'), wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'ファイルを選択してください' });
  // 既存ユーザーを更新するかどうか。既定では追加のみ
  const updateExisting = req.body?.updateExisting === 'true' || req.body?.updateExisting === true;

  let parsed;
  try {
    parsed = parseUserRows(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const { rows, errors } = parsed;
  if (!rows.length && !errors.length) {
    return res.status(400).json({ error: '取り込める行がありませんでした' });
  }

  // ファイル内でのログインID重複を先に弾く（後勝ちで上書きされるのを防ぐ）
  const seen = new Map();
  const unique = [];
  for (const r of rows) {
    if (seen.has(r.loginId)) {
      errors.push({
        line: r.line,
        loginId: r.loginId,
        message: `ファイル内でログインIDが重複しています（${seen.get(r.loginId)}行目と重複）`,
      });
      continue;
    }
    seen.set(r.loginId, r.line);
    unique.push(r);
  }

  const created = [];
  const updated = [];
  const skipped = [];
  for (const r of unique) {
    const existing = await db.get('SELECT id FROM users WHERE login_id = ?', [r.loginId]);
    if (existing && !updateExisting) {
      skipped.push({ loginId: r.loginId, message: '既に登録されています' });
      continue;
    }
    if (existing) {
      await db.run(
        `UPDATE users SET name = ?, role = ?, branch = ?, office = ?, title = ?,
                          email = COALESCE(?, email), active = ? WHERE id = ?`,
        [r.name, r.role, r.branch, r.office, r.title, r.email, r.active ? 1 : 0, existing.id]
      );
      updated.push({ id: existing.id, loginId: r.loginId, name: r.name });
      continue;
    }
    // パスワードは発行しない。本人が初回ログイン時に「パスワード設定」から自分で決める
    const { lastInsertRowid } = await db.run(
      `INSERT INTO users (name, role, branch, office, title, email, login_id, password_hash, must_change_password, active)
       VALUES (?,?,?,?,?,?,?,NULL,0,?)`,
      [r.name, r.role, r.branch, r.office, r.title, r.email, r.loginId, r.active ? 1 : 0]
    );
    created.push({ id: Number(lastInsertRowid), loginId: r.loginId, name: r.name });
  }

  // 名簿の氏名を、案件データの営業担当者の表記へ揃える（空白の違いを吸収する）
  const renamed = await alignUserNamesToDeals();
  res.json({ created, updated, skipped, errors, renamed });
}));

/** 名簿の列。記入例の出力・一覧の出力・取込のどれも同じ並びにする */
const ROSTER_HEADERS = [
  'ログインID（社員番号）', '支店（管轄）', '営業所（部署）', '役職', '氏名', '権限',
  'メール（問い合わせ通知）', '有効',
];
const ROSTER_COLS = [
  { wch: 18 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 26 }, { wch: 6 },
];

/** 名簿の1枚を組み立てて返す（見出し＋行） */
function rosterWorkbook(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([ROSTER_HEADERS, ...rows]);
  ws['!cols'] = ROSTER_COLS;
  XLSX.utils.book_append_sheet(wb, ws, 'ユーザー');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** 名簿の記入例。これを埋めてそのまま取り込める */
api.get('/admin/users/template', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const buf = rosterWorkbook([
    ['100001', '東京中央', '東京中央営業所', '主任', '山田 太郎', '営業担当者', '', '〇'],
    ['100002', '東京中央', '', '支店長', '鈴木 一郎', '支店長', '', '〇'],
    ['100003', '本社', '広域営業部', '課長', '田中 次郎', '広域担当', '', '〇'],
    ['100004', '本社', '製品企画部', '部長', '佐藤 三郎', '本社', 'kikaku@example.co.jp', '〇'],
    ['100005', '本社', '', 'システム管理', '高橋 四郎', '管理者', 'admin@example.co.jp', '〇'],
  ]);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', contentDisposition('ユーザー一括登録_記入例.xlsx', 'users-template.xlsx'));
  res.send(buf);
}));

/**
 * いまのユーザー一覧をExcelで出す。
 * 記入例と同じ列なので、メールなどを書き足して
 * 「既に登録済みのログインIDは内容を更新する」で取り込み直せる。
 */
api.get('/admin/users/export', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const users = await db.all(
    `SELECT login_id, branch, office, title, name, role, email, active
       FROM users ORDER BY branch, office, login_id`);
  const buf = rosterWorkbook(users.map((u) => [
    u.login_id ?? '',
    u.branch ?? '',
    u.office ?? '',
    u.title ?? '',
    u.name ?? '',
    ROLE_LABELS[u.role] ?? u.role ?? '',
    u.email ?? '',
    u.active ? '〇' : '×',
  ]));
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', contentDisposition('ユーザー一覧.xlsx', 'users.xlsx'));
  res.send(buf);
}));

// ---- ユーザー / メタ情報 ----
// 社員名簿にあたるため、ログイン前には返さない
api.get('/users', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  res.json(await db.all('SELECT id, name, role, branch, office FROM users WHERE active = 1 ORDER BY id'));
}));

/**
 * 絞り込みの選択肢（/meta）の作り置き。
 *
 * 中身は取込でしか変わらないのに、案件10万件の集計を6回走らせるため、
 * 画面を開くたびに数秒かかっていた。閲覧範囲ごとに作り置きして使い回す。
 * 取込のあとは invalidateMetaCache() で捨てる（画面には最新が出る）。
 */
const META_CACHE_MS = 5 * 60 * 1000;
const metaCache = new Map();

function invalidateMetaCache() {
  metaCache.clear();
}

api.get('/meta', wrap(async (req, res) => {
  // 絞り込みの候補も閲覧範囲に合わせる。
  // ここを絞らないと、担当者名や法人名の一覧から他営業所の取引先が分かってしまう。
  const scope = scopeConditions(req.user);
  // 作り置きは閲覧範囲ごと（支店・営業所で中身が変わるため）
  const cacheKey = JSON.stringify([scope.where, scope.params]);
  const hit = metaCache.get(cacheKey);
  if (hit && hit.until > Date.now()) {
    return res.json({ ...hit.body, scope: scopeInfo(req.user) });
  }
  const and = scope.where.length ? ` AND ${scope.where.join(' AND ')}` : '';
  const sp = scope.params;

  const [priceTypes, equips, categories, models, persons, customers, branches, offices, corps,
         industries] = await Promise.all([
    db.all('SELECT * FROM price_types ORDER BY code'),
    db.all(`SELECT equip_name AS name, COUNT(*) AS count FROM deals WHERE equip_name IS NOT NULL${and} GROUP BY equip_name ORDER BY count DESC`, sp),
    // 品目は 器具区分（大分類）→ カテゴリー名（大）→ 品目階層名 の順に絞り込む。
    // 親の名前を添えて返し、画面では選んだ親に属するものだけを選択肢に出す
    // （支店→営業所と同じ作り）。同じ名前が別の親にもあるため、組み合わせで返す。
    db.all(`SELECT equip_name AS equip, category_name AS name, COUNT(*) AS count
              FROM deals WHERE category_name IS NOT NULL${and}
             GROUP BY equip_name, category_name ORDER BY count DESC`, sp),
    db.all(`SELECT equip_name AS equip, category_name AS category, model_name AS name, COUNT(*) AS count
              FROM deals WHERE model_name IS NOT NULL${and}
             GROUP BY equip_name, category_name, model_name ORDER BY count DESC LIMIT 3000`, sp),
    db.all(`SELECT sales_person AS name, COUNT(*) AS count FROM deals WHERE sales_person IS NOT NULL${and} GROUP BY sales_person ORDER BY count DESC`, sp),
    db.all(`SELECT customer_code AS code, customer_name AS name, COUNT(*) AS count FROM deals WHERE customer_code IS NOT NULL${and} GROUP BY customer_code, customer_name ORDER BY count DESC LIMIT 500`, sp),
    db.all(`SELECT branch AS name, COUNT(*) AS count FROM deals WHERE branch IS NOT NULL${and} GROUP BY branch ORDER BY count DESC`, sp),
    db.all(`SELECT DISTINCT branch, office AS name, COUNT(*) AS count FROM deals WHERE office IS NOT NULL${and} GROUP BY branch, office ORDER BY count DESC`, sp),
    db.all(`SELECT corp_code AS code, corp_name AS name, COUNT(*) AS count FROM deals WHERE corp_code IS NOT NULL${and} GROUP BY corp_code, corp_name ORDER BY count DESC LIMIT 500`, sp),
    // 業種名。取込元によってコードの付き方が違うため、取込時に normIndustry でそろえている
    db.all(`SELECT industry AS name, COUNT(*) AS count FROM deals
             WHERE industry IS NOT NULL AND industry <> ''${and}
             GROUP BY industry ORDER BY count DESC`, sp),
  ]);
  // 支店・営業所は都道府県順（北から南）。件数順だと選択肢を探しづらい
  branches.sort((a, b) => comparePref(a.name, b.name));
  offices.sort((a, b) => comparePref(a.name, b.name));

  // 取込の情報（A基準の月の見出し・実単価の月など）は1回でまとめて読む
  const { aggMeta, histMeta, actualMeta } = await loadImportMeta();
  // 過去最新単価が「いつまでの受注か」。画面の説明に出す
  // （取込のたびに動くので、文言に日付を書き込まずここから渡す）
  const pastRange = await db.get(
    'SELECT MAX(past_date) AS max FROM deals WHERE past_date IS NOT NULL');

  const body = {
    priceTypes, equips, categories, models, persons, customers, branches, offices,
    corps, industries,
    aggMeta,
    histMeta,
    actualMeta,
    pastMax: pastRange?.max ?? null,
    exportMaxRows: EXPORT_MAX_ROWS,
    // 弾ごとの進み具合。案件一覧の絞り込みに使う
    states: [
      { code: 'open', name: '未入力' },
      { code: 'agreed', name: '合意済（未完了）' },
      { code: 'done', name: '完了' },
    ],
    corpStatuses: CORP_STATUSES,
  };
  metaCache.set(cacheKey, { body, until: Date.now() + META_CACHE_MS });
  // 画面に「いま何が見えているか」を出すための情報は人ごとに変わるため、作り置きに含めない
  res.json({ ...body, scope: scopeInfo(req.user) });
}));

// ---- 閲覧範囲（役割ごとに見えるデータを絞る） ----

/**
 * 支店名の書き方のゆれを吸収するための、突き合わせる候補。
 *
 * 名簿（利用者）は「大阪支店」、価格調査の取込は「大阪」と、
 * 末尾の「支店」の有無が揃っていない。素の一致で比べると
 * どの営業担当者にも案件が1件も出なくなるため、両方の書き方を候補にする。
 * 索引（idx_deals_branch）を使えるよう、関数で加工せず候補の一致で比べる。
 *
 * どちらを正とするかは決めない（名簿・取込のどちらの書き方でも通る）。
 */
function branchMatches(branch) {
  const raw = String(branch ?? '').trim();
  if (!raw) return [];
  const bare = raw.replace(/支店$/, '').trim();
  if (!bare) return [raw];
  return [...new Set([raw, bare, `${bare}支店`])];
}

/**
 * 権限ごとの閲覧範囲を、案件テーブルに対する条件として返す。
 *
 *   営業担当者          … 自分の支店のみ（支店の中の営業所はすべて見える）
 *   支店長・広域担当    … 全支店
 *   本社（planning）    … 全社（目標値の設定もできる）
 *   管理者・開発者      … 全社
 *
 * 支店は取り込んだ案件から増えていくため、ここでは値を持たず
 * 利用者に設定された支店と突き合わせるだけにしている。
 * 支店が増えても、この関数を直す必要はない。
 *
 * 支店が未設定の営業担当者には何も見せない（1=0）。
 * 設定漏れのときに他支店の単価が見えてしまうより、
 * 見えない状態で気づいてもらうほうが安全なため。
 */
function scopeConditions(user, alias = '') {
  const p = alias ? `${alias}.` : '';
  if (!user) return { where: ['1 = 0'], params: [] };
  // 支店長・広域担当は全支店を閲覧できる
  if (isAdminRole(user.role) || ['planning', 'branch_manager', 'wide_area'].includes(user.role)) {
    return { where: [], params: [] };
  }
  // 閲覧専用（共通ID）。見るだけの権限なので、支店にかかわらず全社を見る
  if (isViewerRole(user.role)) return { where: [], params: [] };

  // 営業担当者（既定）。自分の支店のみ（支店の中の営業所はすべて）
  const cands = branchMatches(user.branch);
  if (!cands.length) {
    return { where: ['1 = 0'], params: [], missing: '支店' };
  }
  return {
    where: [`${p}branch IN (${cands.map(() => '?').join(',')})`],
    params: cands,
  };
}

/** 画面に出すための範囲の説明。未設定のときは理由も返す */
function scopeInfo(user) {
  const s = scopeConditions(user);
  if (!user) return { level: 'none', label: '—' };
  if (isAdminRole(user.role) || ['planning', 'branch_manager', 'wide_area'].includes(user.role)) {
    return { level: 'all', label: user.role === 'planning' ? '全社（本社）' : '全社' };
  }
  if (isViewerRole(user.role)) return { level: 'all', label: '全社（閲覧のみ）' };
  if (s.missing) {
    return {
      level: 'none',
      label: '未設定',
      missing: s.missing,
      note: `${s.missing}が設定されていないため、案件を表示できません。本社（管理者）にご連絡ください`,
    };
  }
  return { level: 'branch', label: `${user.branch}（支店全体）` };
}

/**
 * 計画の月（当月・翌月・翌々月・3か月後）を、データの日付から決める。
 *
 * 毎日の価格調査は「前日の結果」で、ファイルの見出しの日付はファイルを作った日を
 * もとに振られている。ふだんはどちらも同じ月なので違いは出ないが、月初（1日）に
 * 取り込むと、中身は前の月の結果なのに見出しだけ新しい月になり、
 * 前の月が計画の4か月から外れてしまう（9/1の取込で8月が抜けた）。
 * そのため月はファイルの見出しではなく、データの日付から決める。
 *
 * 画面側の client/src/aggImportClient.ts の planMonthsFrom と合わせること。
 */
function planMonthsFrom(ymd) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(ymd ?? ''));
  if (!m) return [];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return [0, 1, 2, 3].map((n) => {
    const t = mo - 1 + n;
    return `${y + Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

/**
 * データの日付。毎日の価格調査は前日の結果なので、取込日（未入力なら今日）の1日前。
 * 画面側の dataDateOf と合わせること。
 */
function dataDateOf(takenOn) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(takenOn ?? ''))
    ? String(takenOn) : localDate();
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 翌月の計画を当月の計画で置き換える境目の日。
 * この日より前の登録は、今回の値上げより前の古い申請とみなす。
 *
 * 境目は「実績の月」（売上高を取り込んだ月）の1日。
 * 数量も比較のもと（現状額）も実績の月のものを使っているので、
 * 「古いかどうか」の線もそこに合わせないと、画面の中で基準がばらつく。
 *
 * 売上高がまだ1度も入っていないときだけ、当月の前月で代用する
 * （実績の月が分からないため。売上高が入れば必ず実績の月が使われる）。
 *
 * 売上高（7月）を取り込んだまま当月が9月へ進むと、この2つは食い違う。
 * 実績の月に合わせておけば、売上高を更新するまで境目が動かない
 * （7月に承認された翌月の単価が、月が変わっただけで「古い」に変わらない）。
 */
function slideFromDate(aggMeta, actualMeta) {
  const actYm = String(actualMeta?.ym ?? '');
  if (/^\d{4}-\d{2}$/.test(actYm)) return `${actYm}-01`;
  const m0 = String(aggMeta?.m0 ?? '');
  if (!/^\d{4}-\d{2}$/.test(m0)) return null;
  const y = Number(m0.slice(0, 4));
  const m = Number(m0.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}

/**
 * その月の申請単価（マスタ登録単価）のSQL。
 * 翌月（9月計画）は、承認日が境目の日より前か未記入なら
 * 当月（8月計画）をそのままスライドして使う。画面の表示と値上げ額の集計をそろえる。
 * 日付は slideFromDate が作る YYYY-MM-DD だけなので、そのまま埋め込んでよい。
 */
function aPriceSql(n, slideFrom, prefix = '') {
  const col = (c) => `${prefix}${c}`;
  if (n !== 1 || !slideFrom) return col(`a_price_m${n}`);
  return `(CASE WHEN COALESCE(${col('a_date_m1')}, '') < '${slideFrom}'
                THEN ${col('a_price_m0')} ELSE ${col('a_price_m1')} END)`;
}

// ---- ダッシュボード（進捗） ----

/**
 * 値上げの進み具合をまとめて返す。
 * 表示できる範囲は案件一覧と同じ（営業担当者は自分の支店だけ）。
 *
 * 単価だけの管理表なので金額は扱わず、件数と割合で進捗を示す。
 */
/**
 * ダッシュボードの集計をまとめて作る。画面（/dashboard）と
 * Excel出力（/dashboard/export）で同じ数字を使うため、ここに集約している。
 */
/**
 * 平均単価の比較（基準 → 計画）の集計SQL。
 *
 * 「基準」（過去最新単価／マスタ単価／実単価）で選んだ単価と、各月の計画とを、
 * 出荷数（当月の実績数）で重みを付けた平均で比べる。
 * 同じ品目・同じ数量で比べるので、平均の差がそのまま1台あたりの上がり幅になり、
 * それに出荷数を掛けるとその月の値上げ額と一致する。
 *
 * ダッシュボード全体（/dashboard）と、カードの中だけで絞り込み直す
 * /dashboard/avg-prices の両方がこれを使う。
 */
function avgPriceAgg(query, aggMeta, actualMeta) {
  const f = (c) => `CAST(${c} AS FLOAT)`;
  const approved = aDateCond(query);
  const aPrice = (n) => aPriceSql(n, slideFromDate(aggMeta, actualMeta));
  // 比較のもと（過去最新単価／マスタ単価／実単価）。画面の「基準」で選ぶ
  const base = basePriceSql(query);
  const qty = f('master_qty');
  // 対象は「基準の単価があり、当月の実績数がある品目」。月ごとに変えず、
  // どの月も同じ品目・同じ数量で比べる（基準の平均が1つに定まる）。
  const target = `${base} > 0 AND ${qty} > 0${approved ? ` AND ${approved}` : ''}`;
  // その月の計画が無い品目は「変動なし」として基準の単価のまま数える。
  // 値上げ額の出し方と同じ決まりなので、
  // （計画の平均 − 基準の平均）× 出荷数 が、その月の値上げ額と一致する。
  const plan = (n) => `(CASE WHEN ${aPrice(n)} > 0 THEN ${f(aPrice(n))} ELSE ${base} END)`;
  return `
    SUM(CASE WHEN ${target} THEN 1 ELSE 0 END) AS avg_cnt,
    SUM(CASE WHEN ${target} THEN ${qty} END) AS avg_qty,
    SUM(CASE WHEN ${target} THEN ${base} * ${qty} END) AS avg_base,
    ${[0, 1, 2, 3].map((n) => `
    SUM(CASE WHEN ${target} THEN ${plan(n)} * ${qty} END) AS avg_plan_m${n}`).join(',')}`;
}

/**
 * 値上げの取り組みが始まった年月。ダッシュボードの承認日の既定値と同じ。
 * これより前の承認は前回までの古い単価が多く、値上げ額として見ると実態と合わない。
 * 画面側の client/src/filterOptions.ts の RAISE_START_YM と合わせること。
 */
const RAISE_START_YM = '2026-05';

/** 値上げ幅の「基準」の一覧。履歴はこの3つぶんを残す（画面で選べるため） */
const RAISE_BASES = ['master', 'past', 'actual'];

/** 表示用の日付（YYYY-MM-DD）。サーバーはUTCで動くため日本時間に直す */
const localDate = (value = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TZ }).format(new Date(value));

/**
 * 値上げ額の合計を、取込のたびに記録する。
 *
 * 毎日取り込み直すと、そのたびにマスタ登録単価が入れ替わって値上げ額も動く。
 * あとから「前回の取込からいくら動いたか」を追えるように、
 * 取込日 × 計画の月 ごとに合計を残しておく。
 *
 * 記録するのは全社・絞り込みなし・基準はマスタ単価（画面の既定）で、
 * 承認日が RAISE_START_YM 以降ぶんと、それより前ぶんに分けて持つ。
 * 画面の数字と同じく、稼働日での日量換算をしたあとの額を入れる。
 *
 * 取込そのものは成功させたいので、ここで失敗しても投げずに警告だけ残す。
 */
async function recordRaiseHistory(source, filename, takenOnRaw) {
  try {
    const { aggMeta, actualMeta } = await loadImportMeta();
    const planYms = [0, 1, 2, 3].map((n) => String(aggMeta?.[`m${n}`] ?? ''));
    if (!planYms.some((ym) => /^\d{4}-\d{2}$/.test(ym))) return;   // 計画の月が分からない
    const workdays = workdayPlan(actualMeta?.ym ?? '', planYms);
    const dayRate = (n) => {
      const days = workdays.months[n]?.days;
      return workdays.baseDays > 0 && days > 0 ? ` * ${days}.0 / ${workdays.baseDays}.0` : '';
    };
    const f = (c) => `CAST(${c} AS FLOAT)`;
    // 現状額（実績の月の金額そのもの）。ダッシュボードの「現状額（合計）」と同じ
    const effAmt = `COALESCE(${f('master_amount')}, ${f('master_avg_price')} * ${f('master_qty')}, 0)`;
    const aPrice = (n) => aPriceSql(n, slideFromDate(aggMeta, actualMeta));
    // 承認日の前後。承認日の無いA基準は、どちらにも入れない（画面と同じ決まり）
    const first = `${RAISE_START_YM}-01`;
    const sides = { after: `a_date_m3 >= '${first}'`, before: `a_date_m3 < '${first}'` };
    // 値上げ幅の「基準」は画面で選べるので、3つとも残す。
    // 同じ基準どうしでないと前日比が出せないため（マスタ単価の記録と
    // 過去最新単価の画面を引き算しても意味が無い）。
    // 件数は基準によらないので、マスタ単価のぶんだけ数える。
    const gain = (n, cond, base) => raiseAmtSql(aPrice(n), { base }, cond);
    const cols = [0, 1, 2, 3].flatMap((n) => Object.entries(sides).flatMap(([key, cond]) => [
      ...RAISE_BASES.map((base) =>
        `SUM(${gain(n, cond, base)}${dayRate(n)}) AS ${key}_${base}_${n}`),
      `SUM(CASE WHEN ${aPrice(n)} > 0 AND ${cond} THEN 1 ELSE 0 END) AS ${key}_cnt_${n}`,
    ]));
    const row = await db.get(`
      SELECT COUNT(*) AS deals, SUM(${f('master_qty')}) AS qty,
             SUM(${effAmt}) AS base_amt, ${cols.join(', ')}
        FROM deal_calc`);
    const takenAt = now();
    // 取込日。ふだんは今日だが、過去のファイルを取り込み直して履歴を
    // 埋めるときは、そのファイルの日付を指定できる（明日以降は受けない）
    const today = localDate();
    const takenOn = /^\d{4}-\d{2}-\d{2}$/.test(String(takenOnRaw ?? ''))
      && String(takenOnRaw) <= today ? String(takenOnRaw) : today;
    const n = (v) => Number(v ?? 0);
    for (const [i, planYm] of planYms.entries()) {
      if (!/^\d{4}-\d{2}$/.test(planYm)) continue;
      // 計画額（日量換算後）＝ 現状額 × 稼働日の倍率 ＋ 値上げ額（前後の合計）。
      // 計画額は画面の既定（マスタ単価）で出す
      const rate = workdays.months[i]?.rate > 0 ? workdays.months[i].rate : 1;
      const at = (key, base) => n(row?.[`${key}_${base}_${i}`]);
      await db.run(`
        INSERT INTO raise_history (taken_on, plan_ym, source, filename, act_ym,
          work_days, base_days, deals, qty, base_amt, plan_amt,
          raise_after, raise_before,
          raise_after_past, raise_before_past, raise_after_actual, raise_before_actual,
          cnt_after, cnt_before, a_date_ym, taken_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (taken_on, plan_ym) DO UPDATE SET
          source = excluded.source, filename = excluded.filename, act_ym = excluded.act_ym,
          work_days = excluded.work_days, base_days = excluded.base_days,
          deals = excluded.deals, qty = excluded.qty, base_amt = excluded.base_amt,
          plan_amt = excluded.plan_amt,
          raise_after = excluded.raise_after, raise_before = excluded.raise_before,
          raise_after_past = excluded.raise_after_past,
          raise_before_past = excluded.raise_before_past,
          raise_after_actual = excluded.raise_after_actual,
          raise_before_actual = excluded.raise_before_actual,
          cnt_after = excluded.cnt_after, cnt_before = excluded.cnt_before,
          a_date_ym = excluded.a_date_ym, taken_at = excluded.taken_at`,
        [takenOn, planYm, source, filename || null, actualMeta?.ym ?? null,
          workdays.months[i]?.days ?? null, workdays.baseDays ?? null,
          n(row?.deals), n(row?.qty), n(row?.base_amt),
          n(row?.base_amt) * rate + at('after', 'master') + at('before', 'master'),
          at('after', 'master'), at('before', 'master'),
          at('after', 'past'), at('before', 'past'),
          at('after', 'actual'), at('before', 'actual'),
          n(row?.[`after_cnt_${i}`]), n(row?.[`before_cnt_${i}`]),
          RAISE_START_YM, takenAt]);
    }
  } catch (e) {
    console.warn(`値上げ額の履歴を残せませんでした → ${e.message}`);
  }
}

/**
 * 値上げ額の推移。取込日ごとに、計画の月ぶんの合計を新しい順で返す。
 * 画面では前回の取込との差（前日比）を添えて出す。
 */
async function raiseHistoryRows(limit = 30) {
  let days = [];
  try {
    days = await db.all(
      'SELECT DISTINCT taken_on FROM raise_history ORDER BY taken_on DESC LIMIT ?', [limit]);
  } catch { return []; }
  if (!days.length) return [];
  const oldest = String(days[days.length - 1].taken_on);
  const rows = await db.all(
    'SELECT * FROM raise_history WHERE taken_on >= ? ORDER BY taken_on DESC, plan_ym', [oldest]);
  const byDay = new Map();
  for (const r of rows) {
    const day = String(r.taken_on);
    if (!byDay.has(day)) {
      byDay.set(day, {
        takenOn: day, takenAt: r.taken_at, source: r.source, filename: r.filename,
        actYm: r.act_ym, deals: Number(r.deals ?? 0), baseAmt: Number(r.base_amt ?? 0),
        aDateYm: r.a_date_ym, months: [],
      });
    }
    // 値上げ幅の基準ごとの値。この仕組みより前の記録はマスタ単価ぶんしか無いので、
    // 無い基準は null にして「比べられない」と分かるようにする
    const num0 = (v) => (v == null ? null : Number(v));
    byDay.get(day).months.push({
      ym: String(r.plan_ym), days: r.work_days ?? null, baseDays: r.base_days ?? null,
      planAmt: Number(r.plan_amt ?? 0),
      after: Number(r.raise_after ?? 0), before: Number(r.raise_before ?? 0),
      cntAfter: Number(r.cnt_after ?? 0), cntBefore: Number(r.cnt_before ?? 0),
      // 基準ごと（master＝無印。past／actual は後から足したので古い記録では null）
      byBase: {
        master: { after: num0(r.raise_after), before: num0(r.raise_before) },
        past: { after: num0(r.raise_after_past), before: num0(r.raise_before_past) },
        actual: { after: num0(r.raise_after_actual), before: num0(r.raise_before_actual) },
      },
    });
  }
  return [...byDay.values()];
}

/** 過ぎた月をいくつまで残すか。表が縦に伸びすぎないよう新しい方から数える */
const PAST_MONTH_LIMIT = 12;
/**
 * 案件を減らす絞り込み（dealFilters が見ている項目）。
 * 1つでも入っていると、全社の記録とは違う数字になるため過ぎた月は出せない。
 */
const DEAL_FILTER_KEYS = ['ids', 'q', 'equip', 'person', 'customer', 'corp', 'priceType',
  'branch', 'office', 'category', 'model', 'industry', 'r2State', 'aState', 'act', 'gain',
  'aDateFilter'];
/** 値上げ幅の基準ごとの、記録の列名（承認日の以降ぶん／より前ぶん） */
const RAISE_HIST_COLS = {
  master: ['raise_after', 'raise_before'],
  past: ['raise_after_past', 'raise_before_past'],
  actual: ['raise_after_actual', 'raise_before_actual'],
};

/**
 * 過ぎた月（計画の月から外れた月）の記録。
 *
 * 計画の月は「当月・翌月・翌々月・3か月後」の4つで、取込のたびに1つ先へずれる。
 * そのため月が変わると、前の月がダッシュボードから消えてしまう
 * （データの日付が9月に入った時点で、8月の計画が表から抜ける）。
 * 取込のたびに残している記録（raise_history）には、その月が計画だったころの
 * 合計がそのまま残っているので、そこから拾って過ぎた月も表に残す。
 *
 * 記録は「全社・絞り込みなし」で取ったものなので、画面がその条件と違うときは
 * 数字を出さず、なぜ出せないか（note）だけを返す（前日比と同じ決まり）。
 */
async function pastPlanMonths(query, user, planYms) {
  const current = planYms.filter((ym) => /^\d{4}-\d{2}$/.test(String(ym))).sort();
  if (!current.length) return { months: [], note: '' };
  let rows = [];
  try {
    // 月ごとに「その月が計画に入っていた、いちばん新しい取込」を1件だけ取る
    rows = await db.all(`
      SELECT h.* FROM raise_history h
       WHERE h.plan_ym < ?
         AND h.taken_on = (SELECT MAX(x.taken_on) FROM raise_history x
                            WHERE x.plan_ym = h.plan_ym)
       ORDER BY h.plan_ym DESC
       LIMIT ?`, [current[0], PAST_MONTH_LIMIT]);
  } catch { return { months: [], note: '' }; }   // 履歴の表が無い旧DBでは出さない
  if (!rows.length) return { months: [], note: '' };
  rows.reverse();   // 古い月から順に（表では計画の月の手前に並べる）

  // 記録と同じ条件で見ているときだけ出す。違う条件の数字を並べても意味が無い
  if (scopeInfo(user).level !== 'all' || DEAL_FILTER_KEYS.some((k) => query[k])) {
    return {
      months: [],
      note: '過ぎた月（計画の月から外れた月）の記録は、絞り込み中は出せません'
        + '（全社・絞り込みなしの合計で残しているため、「解除」で出ます）',
    };
  }
  const [afterCol, beforeCol] = RAISE_HIST_COLS[baseKey(query)];
  const baseLabel = BASE_LABELS[baseKey(query)];
  const wantYm = String(query.aDateYm ?? '');
  const wantBefore = String(query.aDateOp ?? 'from') === 'before';
  let note = '';
  const months = [];
  for (const r of rows) {
    const num0 = (v) => (v == null ? null : Number(v));
    const after = num0(r[afterCol]);
    const before = num0(r[beforeCol]);
    if (after == null || before == null) {
      // 基準ごとに残すようになる前の記録。マスタ単価ぶんしか持っていない
      note = `過ぎた月（${r.plan_ym}）の記録に「${baseLabel}」を基準にした値がありません`
        + '（この基準を残すようになる前の記録です）';
      continue;
    }
    // 承認日。記録は取り組みの開始月（a_date_ym）で前後に分けてあるので、
    // 画面の指定がその月と同じなら片側を、空（全期間）なら両方を足したものを使う。
    // それ以外の月を指定されているときは、記録から作れないので出せない
    const split = String(r.a_date_ym ?? '');
    const raise = !wantYm ? after + before
      : wantYm === split ? (wantBefore ? before : after)
        : null;
    if (raise == null) {
      note = '過ぎた月（計画の月から外れた月）の記録は、承認日を '
        + `${split} 以降（既定）か全期間にすると出せます（その区切りで残しているため）`;
      continue;
    }
    const days = Number(r.work_days);
    const baseDays = Number(r.base_days);
    months.push({
      ym: String(r.plan_ym),
      // いつの取込の記録か。表の吹き出しに出して、数字の出どころを分かるようにする
      takenOn: String(r.taken_on),
      days: days > 0 ? days : null,
      baseDays: baseDays > 0 ? baseDays : null,
      // 実績の月に対する倍率（日量換算）。分からない月は1（換算なし）
      rate: days > 0 && baseDays > 0 ? days / baseDays : 1,
      actYm: r.act_ym ?? null,
      deals: Number(r.deals ?? 0),
      baseAmt: Number(r.base_amt ?? 0),
      // 画面の承認日に合わせた値上げ額（記録した時点の、日量換算後の額）
      raise,
      after,
      before,
      cntAfter: Number(r.cnt_after ?? 0),
      cntBefore: Number(r.cnt_before ?? 0),
      aDateYm: split || null,
    });
  }
  return { months, note: months.length ? '' : note };
}

/**
 * いまの案件の内容で、値上げ額の履歴を1件残す。
 *
 * 取込のたびに自動で残しているが、この仕組みより前に取り込んだ分は
 * 記録が無い。案件には最後に取り込んだファイルの内容がそのまま入っているので、
 * 取り込み直さなくても、その日付で記録だけを残せるようにする。
 * 同じ日付の記録があるときは置き換える。
 */
api.post('/raise-history/record', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const takenOn = String(req.body?.takenOn ?? '');
  if (takenOn && !/^\d{4}-\d{2}-\d{2}$/.test(takenOn)) {
    return res.status(400).json({ error: '日付の形が違います' });
  }
  if (takenOn && takenOn > localDate()) {
    return res.status(400).json({ error: '明日以降の日付では記録できません' });
  }
  await recordRaiseHistory('manual', '（いまの内容から記録）', takenOn);
  const days = await raiseHistoryRows(2);
  if (!days.length) return res.status(400).json({ error: '記録できませんでした（取込がまだのようです）' });
  res.json({ ok: true, takenOn: days.find((d) => d.takenOn === (takenOn || localDate()))?.takenOn ?? days[0].takenOn });
}));

api.get('/raise-history', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const limit = Math.min(90, Math.max(2, Number(req.query.limit) || 30));
  res.json({ days: await raiseHistoryRows(limit) });
}));

async function dashboardData(query, user) {
  // 絞り込みは案件一覧と同じものを受ける。閲覧範囲もここに含まれる。
  const { where, params: p } = dealFilters(query, user);
  const andWhere = (cond) => {
    if (!cond) return where;
    return where ? `${where} AND ${cond}` : `WHERE ${cond}`;
  };

  // 支店別・営業所別・法人別の値上げ額。
  //   現状額 = 実績の平均出荷単価 × 数量の合計（値上げしなかった場合）
  //   実績   = マスタ登録単価（A基準）前提で、数量を固定したままの月別合計
  //   値上げ額 = 実績（その月） − 現状額
  //
  // A基準の入っていない案件を混ぜると、現状額だけが積み上がって
  // 値上げ額が大きくマイナスに出る。対象はA基準のある案件だけにする。
  // 単価0は「未申請」の印なので、値上げなし（＝実績と同じ）として扱う。
  //
  // 列は REAL（PostgreSQLでは単精度）で、そのまま足すと数十億円の合計で
  // まとまりごとに丸めがズレる。倍精度に上げてから足す
  // （FLOAT は PostgreSQL では倍精度、SQLite では通常の実数）。
  const f = (c) => `CAST(${c} AS FLOAT)`;
  const { months, masterMonths: mMonths, aggMeta, actualMeta } = await loadImportMeta();

  // 実績の基準。マスタ登録の単価を優先し、無い品目は出荷実績で補う（案件一覧と同じ）。
  // マスタ登録の売上数は月平均（÷3）×対象月数（months）で期間ぶんに換算して揃える。
  // こうすると「合計して ÷months で月あたりを出す」これまでの作りのまま正しい値になる。
  // 実単価（実績の正）。当月の金額 ÷ 数量で、見積ぶんが混ざるとマスタ単価より下がる
  const effPrice = f('master_avg_price');
  const effQty = f('master_qty');
  // マスタ単価（値決めの単価）。A基準（今後の計画）はこれと比べる。
  // マスタ単価の無い品目（古い取込など）は実単価で代用する
  const mPrice = `COALESCE(${f('master_price')}, ${f('master_avg_price')})`;
  // 現状額は当月の金額そのもの（単価×数量で戻すと端数がずれ、実績の合計と合わなくなる）
  const effAmt = `COALESCE(${f('master_amount')}, ${f('master_avg_price')} * ${f('master_qty')}, 0)`;

  // マスタ分（値決めどおりに出た分）の数量と金額。A基準はここに対して当てる。
  // 合計には見積ぶんも入っており、そこへ値上げを当てると計画が過大になる。
  // 種別の分かれていない古い取込では合計と同じ値になる。
  const planQty = `COALESCE(${f('plan_qty')}, ${f('master_qty')}, 0)`;
  const planAmt = `COALESCE(${f('plan_amount')}, ${effAmt})`;
  // 計画額の土台は 7月金額（合計）そのもの。値上げ幅（値決めどうしの差）を
  // ここへ足す形にすることで、実績の金額と同じ土俵でA基準と比べられる。
  const planBase = effAmt;

  // A基準（計画）は、マスタ承認のある品目にだけ充てる。
  // 承認の無い品目は現状のまま（値上げ0）として、土台の金額はそのまま残す。
  //
  // 値上げ幅は「A基準 − マスタ単価」× マスタ分の数量。単価どうしの比較なので、
  // 実単価（見積ぶんで下がる）と混ざらない。その幅を 7月金額（合計）に足すことで、
  // 土台（実績の金額）を崩さずに計画額を出せる。
  const approved = aDateCond(query);
  // 翌月は「承認日が古ければ当月をスライド」の決まりを当てはめる（一覧の表示と同じ）
  const slideFrom = slideFromDate(aggMeta, actualMeta);
  const aPrice = (n) => aPriceSql(n, slideFrom);
  // 値上げ幅の基準（過去最新単価／マスタ単価／実単価）は画面の「基準」で選ぶ。
  // 数量は当月の実績数に揃えてあり、基準の単価が無い品目・実績数が無い品目は
  // 変動なし（0）になる。0なので金額に足しても土台の金額を消してしまわない
  const basePrice = basePriceSql(query);
  const raiseQty = raiseQtySql();
  const aGain = (n) => raiseAmtSql(aPrice(n), query, approved);

  // 稼働日での日量換算。数量は売上高（実績の月）のものをそのまま使っているため、
  // 月ごとの稼働日の違いをそのままにすると、稼働日の少ない月の計画が大きく出る。
  // 実績の月を稼働日で割って日量に直し、計画の月の稼働日を掛け直す。
  // 稼働日の分からない月は倍率1（換算しない）。
  const workdays = workdayPlan(actualMeta?.ym ?? '',
    [0, 1, 2, 3].map((n) => aggMeta?.[`m${n}`] ?? ''));
  // SQLiteでは整数どうしの割り算が整数になるため、小数で書く
  const dayRate = (n) => {
    const days = workdays.months[n]?.days;
    return workdays.baseDays > 0 && days > 0 ? ` * ${days}.0 / ${workdays.baseDays}.0` : '';
  };
  const aCol = (n) => `((${planBase} + ${aGain(n)})${dayRate(n)})`;

  // 想定B基準。法人ごと（さらに器具区分ごと）に決めた「A基準の何%で妥結するか」を当てる。
  // 決定単価（B基準）が入っている案件はそちらが正。設定が無ければ100%＝A基準どおり。
  //
  // 案件1件ごとに副問い合わせを回すと10万件で数百msかかる。設定は数件〜数百件と
  // 小さいので、列名を付け替えた表として1回だけ結合する（列名のぶつかりも避けられる）。
  const planJoin = `
    LEFT JOIN (SELECT corp_code AS pe_corp, equip_name AS pe_equip, b_rate AS pe_rate
                 FROM corp_plans WHERE equip_name <> '') pe
           ON pe.pe_corp = deal_calc.corp_code AND pe.pe_equip = COALESCE(deal_calc.equip_name, '')
    LEFT JOIN (SELECT corp_code AS pc_corp, b_rate AS pc_rate
                 FROM corp_plans WHERE equip_name = '') pc
           ON pc.pc_corp = deal_calc.corp_code`;
  const planRate = 'COALESCE(pe.pe_rate, pc.pc_rate, 100)';
  const bsimUnit = `CASE WHEN b_price IS NOT NULL THEN ${f('b_price')}
                         WHEN a_price_m3 > 0 THEN ${f('a_price_m3')} * ${planRate} / 100
                         ELSE ${basePrice} END`;
  // 想定B基準にした場合の値上げ幅（A基準と同じく、選んだ基準が起点・当月の実績数）
  const bsimGain = `CASE WHEN ${basePrice} > 0 AND ${raiseQty} > 0
                         THEN ((${bsimUnit}) - ${basePrice}) * ${raiseQty} ELSE 0 END`;

  // 器具区分別などの表に出す「実績」。取り込んだ月ごとに出す
  // （4月からの推移を、まとめの表と同じ粒度で見られるようにする）。
  // 走査は既存の集計と同じ1回のままで、足し算だけが増える。
  // 価格調査を取り込んでいれば実績（過去→当月）を出す
  const actSlot = actualMeta?.ym ? 1 : 0;
  // 実績は「過去最新単価（値上げ前）→ 当月のマスタ単価」。どちらも値決めの単価なので
  // そのまま比べられる（ファイルの「売上改善額」と同じ見方）。
  // 単価は円単位なので、0.5円未満のズレは「単価同じ」とみなす。
  // 実績の対象は「過去最新単価のある品目」だけ。
  // 金額はその品目ぶんの 金額（合計）そのもの（単価×数量で戻すと端数がずれる）で、
  // 比べる相手は「過去最新単価 × 数量（合計）」＝ 値上げ前の単価で出たとした場合の金額。
  // 見積ぶんも含めた、実際の売上としての値上がりを表す。
  // 参考として、値決め分だけで見た場合（金額（マスタ）とマスタ分の数量）と、
  // 単価どうしで見た場合（マスタ単価 × マスタ分の数量）も一緒に返す。
  const hasPast = 'past_price > 0';
  // 上がった／単価同じ の判別と、単価で戻した参考の金額は、
  // 当月の単価が出る品目だけが対象（返品だけの品目などは単価が出ない）
  const hasBoth = `${hasPast} AND (${mPrice}) IS NOT NULL`;
  const actUp = `${hasBoth} AND (${mPrice}) - ${f('past_price')} >= 0.5`;
  const actSame = `${hasBoth} AND ABS((${mPrice}) - ${f('past_price')}) < 0.5`;
  // 売上改善額 =（当月のマスタ単価 − 過去最新単価）× マスタ分の数量。
  // 上がった品目（プラス）と下がった品目（マイナス）に分けて足す。
  // 7月金額（合計）からこの改善額を引いたものが「値上げ前当初」の金額になる。
  const actDown = `${hasBoth} AND (${mPrice}) - ${f('past_price')} <= -0.5`;
  const gainExpr = `((${mPrice}) - ${f('past_price')}) * (${planQty})`;
  const actAgg = `
    SUM(CASE WHEN ${hasPast} THEN ${effAmt} END) AS act_amt_1,
    SUM(CASE WHEN ${hasPast} THEN ${f('past_price')} * (${effQty}) END) AS act_base_1,
    SUM(CASE WHEN ${hasPast} THEN ${planAmt} END) AS act_mst_1,
    SUM(CASE WHEN ${hasPast} THEN ${f('past_price')} * (${planQty}) END) AS act_mstbase_1,
    SUM(CASE WHEN ${hasBoth} THEN (${mPrice}) * (${planQty}) END) AS act_mp_1,
    SUM(CASE WHEN ${actUp} THEN ${gainExpr} ELSE 0 END) AS gain_plus_1,
    SUM(CASE WHEN ${actDown} THEN ${gainExpr} ELSE 0 END) AS gain_minus_1,
    SUM(CASE WHEN ${actDown} THEN 1 ELSE 0 END) AS act_down_1,
    SUM(CASE WHEN ${hasPast} THEN 1 ELSE 0 END) AS act_cnt_1,
    SUM(CASE WHEN ${actUp} THEN 1 ELSE 0 END) AS act_up_1,
    SUM(CASE WHEN ${actSame} THEN 1 ELSE 0 END) AS act_same_1`;
  const abAct = actSlot > 0 ? `,${actAgg}` : '';

  // マスタ分（値決めどおりに出た分）の金額と数量。A基準の比較のもとになる。
  // 合計（土台）との差が、見積などで値決めどおりに出なかった分にあたる。
  const mpBelow = `master_qty > 0 AND master_price > 0 AND ${effPrice} - (${mPrice}) <= -0.5`;
  const mpSame = `master_qty > 0 AND master_price > 0 AND ABS(${effPrice} - (${mPrice})) < 0.5`;
  const ab = `
    COUNT(*) AS deals,
    SUM(${effQty}) AS qty,
    SUM(${effAmt}) AS base_amt,
    SUM(${planAmt}) AS mp_amt,
    SUM(${planQty}) AS plan_qty,
    SUM(CASE WHEN ${mpSame} THEN 1 ELSE 0 END) AS mp_same,
    SUM(CASE WHEN ${mpBelow} THEN 1 ELSE 0 END) AS mp_below,
    SUM(${aCol(0)}) AS a0_amt,
    SUM(${aCol(1)}) AS a1_amt,
    SUM(${aCol(2)}) AS a2_amt,
    SUM(${aCol(3)}) AS a3_amt,
    SUM((${planBase} + ${bsimGain})${dayRate(3)}) AS bsim_amt,
    SUM(CASE WHEN b_price IS NOT NULL THEN 1 ELSE 0 END) AS b_rows${abAct}`;
  // 土台は価格調査の全品目。A基準の有無でも、当月の売上の有無でも絞らない
  // （当月に売上の無い品目は金額0として数える）。
  // こうすると現状額の合計が、取り込んだ当月金額の合計とそのまま一致する。
  const abCond = '';

  // 月別のマスタ登録（A基準）。当月〜3か月後それぞれで、
  // 申請の入った件数（単価>0）と値上げ額の合計（(A基準−実績)×数量）を出す。
  // 承認日などの絞り込み（dealFilters）はここにも効く。
  const planned = (n) => `${aPrice(n)} > 0${approved ? ` AND ${approved}` : ''}`;
  const avgAgg = avgPriceAgg(query, aggMeta, actualMeta);

  // 承認日の前後で分けた値上げ額の内訳。
  // 画面の「承認日」で選んだ年月（未指定なら取り組みの開始月）を境目に、
  // それ以降に承認された分と、それより前に承認された分へ分ける。
  // 上の値上げ額は選んだ向きだけを計上するが、こちらは両側とも出すので、
  // 「新しく承認された分がいくらで、前からの分がいくらか」を見比べられる。
  // 承認日の無いA基準はどちらにも入れない（計画に充てない決まりと同じ）。
  const splitYm = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(query.aDateYm ?? ''))
    ? String(query.aDateYm) : RAISE_START_YM;
  const splitSides = {
    after: `a_date_m3 >= '${splitYm}-01'`,
    before: `a_date_m3 < '${splitYm}-01'`,
  };
  const splitAgg = [0, 1, 2, 3].flatMap((n) =>
    Object.entries(splitSides).flatMap(([key, cond]) => [
      `SUM(${raiseAmtSql(aPrice(n), query, cond)}${dayRate(n)}) AS raise_${key}_m${n}`,
      `SUM(CASE WHEN ${aPrice(n)} > 0 AND ${cond} THEN 1 ELSE 0 END) AS cnt_${key}_m${n}`,
    ])).join(',');

  const monthAgg = [0, 1, 2, 3].map((n) => `
    SUM(CASE WHEN ${planned(n)} THEN 1 ELSE 0 END) AS cnt_m${n},
    SUM(${aGain(n)}${dayRate(n)}) AS raise_m${n}`)
    .join(',')
    // 想定B基準（法人ごとの妥結見通し）にした場合の値上げ額。A基準との比較に使う
    + `,
    SUM(CASE WHEN ${planned(3)} THEN ${bsimGain}${dayRate(3)} ELSE 0 END) AS raise_bsim,
    SUM(CASE WHEN b_price IS NOT NULL THEN 1 ELSE 0 END) AS b_rows`;

  // 出荷実績のタイルは「純粋に集計した品目件数」。マスタ登録側の絞り込み
  // （承認日・A基準の有無）は掛けない。マスタ登録件数の母数もこれを使う。
  const pureQuery = { ...query };
  delete pureQuery.aState;
  const pure = dealFilters(pureQuery, user);

  // 価格調査の実績。過去最新単価（値上げ前）から当月までに実際いくら上がったか。
  const actAmt = actAgg;

  const [pureTotals, aMonths, abByEquip, abByBranch, abByCorp] = await Promise.all([
    // 品目件数・数量と、月ごとの実単価は同じ絞り込みなので1文にまとめる
    // （案件は10万件あり、走査の回数がそのまま待ち時間になるため）
    db.get(`SELECT COUNT(*) AS deals, SUM(${effQty}) AS qty, ${actAmt}
            FROM deal_calc ${pure.where}`, pure.params),
    // マスタ登録の件数（A基準の入った件数）はすべての絞り込みが効く
    db.get(`SELECT ${monthAgg}, ${avgAgg}, ${splitAgg},
              SUM(CASE WHEN ${planned(3)} THEN 1 ELSE 0 END) AS covered
            FROM deal_calc ${planJoin} ${where}`, p),
    db.all(`SELECT equip_name AS name, ${ab} FROM deal_calc ${planJoin} ${andWhere(abCond)}
             GROUP BY equip_name ORDER BY SUM(${effAmt}) DESC`, p),
    db.all(`SELECT branch AS name, ${ab} FROM deal_calc ${planJoin} ${andWhere(abCond)}
             GROUP BY branch`, p),
    // 法人はすべて返す（画面でタブに分けて出すため）。
    // まとまりの数は法人グループの数（千件に満たない）なので、上限は付けない
    db.all(`SELECT corp_name AS name, ${ab} FROM deal_calc ${planJoin} ${andWhere(abCond)}
             GROUP BY corp_name ORDER BY SUM(${effAmt}) DESC`, p),
  ]);
  // 支店は都道府県順（選択肢と同じ並び）
  abByBranch.sort((a, b) => comparePref(a.name, b.name));

  // 全体の合計は器具区分別を足したもの（同じ条件のため一致する）。
  // 合計だけをもう一度数えると10万件の走査が1回増えるので、ここで足す
  const sumKeys = ['deals', 'qty', 'base_amt', 'mp_amt', 'plan_qty', 'mp_same', 'mp_below',
    'a0_amt', 'a1_amt', 'a2_amt', 'a3_amt',
    'bsim_amt', 'b_rows',
    ...Array.from({ length: actSlot }, (_, i) =>
      [`act_amt_${i + 1}`, `act_base_${i + 1}`, `act_mst_${i + 1}`, `act_mstbase_${i + 1}`,
        `act_mp_${i + 1}`, `gain_plus_${i + 1}`, `gain_minus_${i + 1}`,
        `act_cnt_${i + 1}`, `act_up_${i + 1}`, `act_same_${i + 1}`, `act_down_${i + 1}`]).flat()];
  const abTotals = abByEquip.reduce((acc, r) => {
    for (const k of sumKeys) acc[k] = Number(acc[k] ?? 0) + Number(r[k] ?? 0);
    return acc;
  }, Object.fromEntries(sumKeys.map((k) => [k, 0])));

  const histTotals = { deals: pureTotals?.deals, qty: pureTotals?.qty };
  const actMonths = pureTotals;
  // 月の並び（actual_meta）と、月ごとの実績額を突き合わせて返す。
  // 現状額（base）は、その月に実績のある案件だけを同じ数量で足したもの。
  // 実績のある案件だけで比べないと、値上げ額が実態より大きく（小さく）出てしまう。
  // 実績は1つ（過去最新単価 → 当月）。計画（A基準）と同じ形で並べられるようにする
  const actuals = actualMeta?.ym ? [{
    ym: actualMeta.ym,
    // 金額（合計）のうち、過去最新単価のある品目ぶんの合計と、その比較のもと
    amount: Number(actMonths?.act_amt_1 ?? 0),
    base: Number(actMonths?.act_base_1 ?? 0),
    // 参考1。値決め分だけで見た場合（金額（マスタ）とマスタ分の数量）
    mstAmount: Number(actMonths?.act_mst_1 ?? 0),
    mstBase: Number(actMonths?.act_mstbase_1 ?? 0),
    // 参考2。同じ品目を「マスタ単価 × 数量」で戻した金額（単価どうしの比較）
    mpAmount: Number(actMonths?.act_mp_1 ?? 0),
    // 売上改善額の内訳。上がった品目ぶんと、下がった品目ぶん
    gainPlus: Number(actMonths?.gain_plus_1 ?? 0),
    gainMinus: Number(actMonths?.gain_minus_1 ?? 0),
    down: Number(actMonths?.act_down_1 ?? 0),
    deals: Number(actMonths?.act_cnt_1 ?? 0),
    // 内訳。値上げがまだ反映されていない（単価同じ）も件数で分かるようにする
    up: Number(actMonths?.act_up_1 ?? 0),
    same: Number(actMonths?.act_same_1 ?? 0),
  }].filter((a) => a.deals > 0) : [];
  // 過ぎた月（計画から外れた月）。記録から拾って、表から消えないようにする
  const past = await pastPlanMonths(query, user, workdays.months.map((x) => x.ym));
  return {
    scope: scopeInfo(user),
    histTotals,
    aMonths,
    abTotals,
    abByEquip,
    abByBranch,
    abByCorp,
    months,
    aggMeta,
    actuals,
    // 計画の日量換算に使った稼働日（画面とExcelが同じ数字で計算できるように返す）
    workdays,
    // 承認日の前後で分けた値上げ額の内訳（計画の月ごと）
    raiseSplit: {
      ym: splitYm,
      months: [0, 1, 2, 3].map((n) => ({
        ym: workdays.months[n]?.ym || '',
        days: workdays.months[n]?.days ?? null,
        after: Number(aMonths?.[`raise_after_m${n}`] ?? 0),
        before: Number(aMonths?.[`raise_before_m${n}`] ?? 0),
        cntAfter: Number(aMonths?.[`cnt_after_m${n}`] ?? 0),
        cntBefore: Number(aMonths?.[`cnt_before_m${n}`] ?? 0),
      })),
    },
    // 値上げ額の推移（取込ごと・全社の合計）。前回の取込との差を画面で出す
    raiseHistory: await raiseHistoryRows(14),
    // 過ぎた月（計画の月から外れた月）。データの日付が月をまたぐと前の月が
    // 計画から外れて表から消えてしまうため、その月の記録を残して出す
    pastMonths: past.months,
    pastNote: past.note,
    // 集計表（器具区分別など）に出している実績の月の並び。未取込なら空
    abActYms: actualMeta?.ym ? [actualMeta.ym] : [],
  };
}

api.get('/dashboard', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  res.json(await dashboardData(req.query, req.user));
}));

/**
 * 平均単価の比較だけを出し直す入口。
 *
 * 「カテゴリー名（大）ごと」「品目階層名ごと」に単価を見比べたいとき、
 * 画面全体の絞り込みを動かすと他のカードまで作り直しになる（18万件の集計で数秒）。
 * この入口はカードの中の選び直しだけに応え、平均単価の集計1本だけを走らせる。
 */
/** 平均単価を内訳ごとに出すときのまとめ方。値上げ額の内訳カードと同じ3つ */
const AVG_GROUPS = { equip: 'equip_name', branch: 'branch', corp: 'corp_name' };

api.get('/dashboard/avg-prices', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const { where, params } = dealFilters(req.query, req.user);
  const { aggMeta, actualMeta } = await loadImportMeta();
  const agg = avgPriceAgg(req.query, aggMeta, actualMeta);
  // 内訳（器具区分別・支店別・法人別）。まとめ方は画面のタブで選ぶ。
  // 全体の合計は内訳を足して作るので、走査は1回で済む
  const col = AVG_GROUPS[String(req.query.group ?? '')] ?? null;
  const [total, rows] = await Promise.all([
    db.get(`SELECT ${agg} FROM deal_calc ${where}`, params),
    col
      ? db.all(`SELECT ${col} AS name, ${agg} FROM deal_calc ${where}
                 GROUP BY ${col} ORDER BY SUM(COALESCE(CAST(master_qty AS FLOAT), 0)) DESC`, params)
      : Promise.resolve([]),
  ]);
  // 支店は都道府県順（選択肢と同じ並び）
  if (col === 'branch') rows.sort((a, b) => comparePref(a.name, b.name));
  res.json({ aMonths: total ?? {}, rows, aggMeta });
}));

/** ダッシュボードの表をそのままExcelにする。絞り込みは画面と同じものが効く */
api.get('/dashboard/export', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const data = await dashboardData(req.query, req.user);
  const buffer = buildDashboardWorkbook(data, { filters: dashboardFilterLabels(req.query) });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition',
    contentDisposition(`値上げダッシュボード_${stamp}.xlsx`, `dashboard_${stamp}.xlsx`));
  res.send(buffer);
}));

/** 出力したファイルに「どの条件で出したか」を残すための一覧 */
function dashboardFilterLabels(q) {
  const items = [];
  for (const [key, label] of [
    ['corp', '法人'], ['branch', '支店'], ['office', '営業所'],
    ['equip', '器具区分'], ['category', 'カテゴリー名（大）'], ['model', '品目階層名'],
    ['person', '担当者'],
  ]) {
    if (q[key]) items.push([label, String(q[key])]);
  }
  if (q.aDateYm) {
    items.push(['承認日', `${q.aDateYm} ${q.aDateOp === 'before' ? 'より前' : '以降'}`]);
  }
  // どの単価と比べた値上げ額なのかは、書き出したファイルだけでは分からないため必ず残す
  items.push(['基準（比較のもと）', BASE_LABELS[baseKey(q)]]);
  return items;
}

/**
 * 案件一覧のExcelの「合計」シートに残す絞り込みの一覧。
 * どの条件で出した合計なのかが、ファイルだけで分かるようにする。
 */
function dealsFilterLabels(q) {
  const items = [];
  if (String(q.q ?? '').trim()) items.push(['検索', String(q.q).trim()]);
  for (const [key, label] of [
    ['industry', '業種'], ['corp', '法人'], ['customer', '得意先'],
    ['branch', '支店'], ['office', '営業所'], ['person', '担当者'],
    ['equip', '器具区分'], ['category', 'カテゴリー名（大）'], ['model', '品目階層名'],
  ]) {
    if (q[key]) items.push([label, String(q[key])]);
  }
  const PICKS = {
    aState: { has: 'マスタ登録単価あり', none: 'マスタ登録単価なし' },
    act: { has: '売上高（当月）あり', none: '売上高（当月）なし' },
    r2State: { open: '未入力', agreed: '合意済', done: '完了' },
    gain: { plus: '上がった品目', minus: '下がった品目', same: '変わらず', none: '比較なし' },
  };
  for (const [key, label] of [
    ['aState', 'マスタ登録単価'], ['act', '売上高（当月）'],
    ['r2State', '交渉の進み具合'], ['gain', '売上改善額'],
  ]) {
    const v = PICKS[key][String(q[key] ?? '')];
    if (v) items.push([label, v]);
  }
  if (q.aDateYm) {
    items.push(['承認日（合計の対象）',
      `${q.aDateYm} ${q.aDateOp === 'before' ? 'より前' : '以降'}`]);
  }
  // どの単価と比べた値上げ幅なのかは、書き出したファイルだけでは分からないため必ず残す
  items.push(['基準（比較のもと）', BASE_LABELS[baseKey(q)]]);
  return items;
}

/**
 * 想定B基準の割合を案件に当てるためのJOIN。
 *
 * 法人×器具区分の設定があればそれを、無ければ法人全体の設定を、
 * どちらも無ければ既定（画面から渡す既定%）を使う。
 */
const PLAN_JOIN = `
  LEFT JOIN corp_plans pe ON pe.corp_code = d.corp_code
                         AND pe.equip_name = COALESCE(d.equip_name, '')
  LEFT JOIN corp_plans pc ON pc.corp_code = d.corp_code AND pc.equip_name = ''`;
const PLAN_RATE = 'COALESCE(pe.b_rate, pc.b_rate, ?)';

/** 法人ごとの想定B基準（A基準に対する%）の一覧 */
api.get('/corp-plans', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const rows = await db.all(`
    SELECT corp_code, equip_name, b_rate, updated_at FROM corp_plans ORDER BY corp_code, equip_name`);
  res.json({ rows });
}));

/**
 * 想定B基準の割合を入れる・消す。
 * 法人全体は equip_name を空で、器具区分ごとは器具区分名を入れて指定する。
 * b_rate が null なら設定を消す（既定に戻す）。
 */
api.put('/corp-plans', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: '保存する内容がありません' });
  if (items.length > 500) return res.status(400).json({ error: '一度に保存できるのは500件までです' });

  const stamp = now();
  let saved = 0;
  let removed = 0;
  for (const it of items) {
    const corp = String(it?.corp_code ?? '').trim();
    if (!corp) continue;
    const equip = String(it?.equip_name ?? '').trim();
    const raw = it?.b_rate;
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      const r = await db.run(
        'DELETE FROM corp_plans WHERE corp_code = ? AND equip_name = ?', [corp, equip]);
      removed += Number(r?.changes ?? 0);
      continue;
    }
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate < 0 || rate > 500) {
      return res.status(400).json({ error: '想定は0〜500の範囲で入力してください' });
    }
    await db.run(
      `INSERT INTO corp_plans (corp_code, equip_name, b_rate, updated_at, updated_by)
       VALUES (?,?,?,?,?)
       ON CONFLICT (corp_code, equip_name) DO UPDATE SET
         b_rate = excluded.b_rate, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [corp, equip, rate, stamp, req.user.id]
    );
    saved += 1;
  }
  res.json({ saved, removed });
}));

/**
 * A基準とB基準のシミュレーション用の集計。
 *
 * グループごとに Σ数量・ΣA売上・ΣB売上（入力分）・B未入力分のA売上を返し、
 * 画面側で「販売数量の増減」「B未入力の想定（Aの何%）」を掛けて試算する。
 * 過去実績（出荷単価×数量）も返すので、値上げ前との比較もできる。
 * 実績原価は本社・管理者・開発者のときだけ返す（粗利の試算用）。
 */
api.get('/simulation', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  // 法人×器具区分は、法人の中で器具ごとに単価が決まるため、
  // 販売計画の増減もその粒度で設定できるようにする
  const group = String(req.query.group ?? 'equip');
  const corp = String(req.query.corp ?? '').trim();
  let nameSel;
  let groupBy;
  // 保存してある想定B基準（A基準に対する%）も一緒に返す。
  // 法人を選んでいるときは法人×器具区分の設定、法人ごとの表では法人全体の設定。
  let planSel = 'NULL AS plan_rate';
  const planParams = [];
  if (group === 'corp_equip') {
    nameSel = "corp_name || '｜' || COALESCE(equip_name, '—') AS name";
    groupBy = 'corp_name, equip_name';
  } else if (group === 'corp') {
    nameSel = 'corp_name AS name, corp_code AS corp_code';
    groupBy = 'corp_code, corp_name';
    planSel = `(SELECT p.b_rate FROM corp_plans p
                 WHERE p.corp_code = deal_calc.corp_code AND p.equip_name = '') AS plan_rate`;
  } else {
    const colMap = { equip: 'equip_name', branch: 'branch' };
    const col = colMap[group] ?? 'equip_name';
    nameSel = `${col} AS name`;
    groupBy = col;
    if (corp && col === 'equip_name') {
      planSel = `(SELECT p.b_rate FROM corp_plans p
                   WHERE p.corp_code = ? AND p.equip_name = COALESCE(deal_calc.equip_name, '')) AS plan_rate`;
      planParams.push(corp);
    }
  }
  const scope = scopeConditions(req.user);
  const conds = ['agg_key IS NOT NULL', 'qty > 0', ...scope.where];
  const params = [...planParams, ...scope.params];
  // 法人を選ぶと、その法人の中だけを集計する
  // （法人ごとに器具区分単位で増減%・想定B基準を設定できるようにするため）
  if (corp) {
    conds.push('corp_code = ?');
    params.push(corp);
  }
  const where = conds.join(' AND ');
  const isAdm = canSeeAllInfo(req.user.role);
  const costCols = isAdm
    ? `, SUM(cost_price * qty) AS cost_amt,
        SUM(CASE WHEN cost_price IS NOT NULL THEN qty ELSE 0 END) AS cost_qty`
    : '';
  const rows = await db.all(`
    SELECT ${nameSel}, ${planSel}, COUNT(*) AS deals, SUM(qty) AS qty,
           SUM(base_price * qty) AS base_amt,
           SUM(a_price_m1 * qty) AS a1_amt,
           SUM(a_price_m2 * qty) AS a2_amt,
           SUM(a_price_m3 * qty) AS a3_amt,
           SUM(CASE WHEN b_price IS NOT NULL THEN 1 ELSE 0 END) AS b_rows,
           SUM(CASE WHEN b_price IS NOT NULL THEN qty ELSE 0 END) AS b_qty,
           SUM(CASE WHEN b_price IS NOT NULL THEN b_price * qty ELSE 0 END) AS b_amt,
           SUM(CASE WHEN b_price IS NULL THEN a_price_m3 * qty ELSE 0 END) AS a3_amt_nob
           ${costCols}
      FROM deal_calc WHERE ${where}
     GROUP BY ${groupBy} ORDER BY SUM(qty) DESC`, params);
  res.json({ rows, withCost: isAdm });
}));

// ---- 案件（deals） ----

/** 実績原価は本社・管理者・開発者だけに返す（社外秘に準ずる扱い） */
function hideCost(rows, user) {
  if (!canSeeAllInfo(user.role)) for (const r of rows) delete r.cost_price;
  return rows;
}

/**
 * 並び替えできる列。
 * 列名はSQLに直接入るため、必ずこの表にあるものだけを使う（受け取った文字列は使わない）。
 */
const SORTABLE = new Map([
  ['corp_name', 'corp_name'],
  ['customer_name', 'customer_name'],
  ['delivery_name', 'delivery_name'],
  ['model_code', 'model_code'],
  ['model_name', 'model_name'],
  ['product_name', 'product_name'],
  ['gas_type', 'gas_type'],
  ['equip_name', 'equip_name'],
  ['branch', 'branch'],
  ['office', 'office'],
  ['sales_person', 'sales_person'],
  ['base_price', 'base_price'],
  ['qty', 'qty'],
  ['hist_avg_price', 'hist_avg_price'],
  ['hist_qty', 'hist_qty'],
  ['master_price', 'master_price'],
  ['past_price', 'past_price'],
  ['a_price_m0', 'a_price_m0'],
  ['a_price_m1', 'a_price_m1'],
  ['a_price_m2', 'a_price_m2'],
  ['a_price_m3', 'a_price_m3'],
  ['b_price', 'b_price'],
  ['r2_target_price', 'r2_target_price'],
  ['r2_agreed_price', 'r2_agreed_price'],
  ['r2_raise_unit', 'r2_raise_unit'],
  ['r2_applied_ym', 'r2_applied_ym'],
  ['nego_result', 'nego_result'],
  ['final_date', 'final_date'],
  ['final_price', 'final_price'],
  ['r2_state', 'r2_state'],
  ['price_type_code', 'price_type_code'],
  ['kubun', 'kubun'],
]);

const DEFAULT_ORDER = 'corp_name, customer_name, equip_name, model_name, id';

/**
 * 並び順を組み立てる。
 * 未入力の行は末尾に寄せる。SQLiteはNULLを先頭、PostgreSQLは末尾に置くため、
 * 「NULLかどうか」を先に並べて、どちらのDBでも同じ見え方にする。
 */
function dealOrder(q, mon = null) {
  let col = SORTABLE.get(String(q.sort ?? ''));
  if (!col) return DEFAULT_ORDER;
  // 実績の列は、表示と同じ「マスタ登録の1~3月実績を優先した値」で並べる。
  // 数量は期間の長さが行ごとに違うため、月平均に直して比べる。
  if (mon) {
    if (col === 'hist_avg_price') col = EFF_PRICE;
    if (col === 'hist_qty') col = `(${effMonthlyQty()})`;
  }
  const dir = String(q.dir ?? '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return `CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END, ${col} ${dir}, id`;
}

/**
 * 承認日の条件をSQLの断片で返す（値は埋め込まない形にできないため直に入れる）。
 * 「2026-08以降に承認された単価だけを計画として充てる」といった使い方をする。
 * 承認日の無いA基準は、どちらの向きでも計画に含めない。
 */
function aDateCond(q) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(q.aDateYm ?? ''))) return '';
  const first = `${q.aDateYm}-01`;
  return q.aDateOp === 'before' ? `a_date_m3 < '${first}'` : `a_date_m3 >= '${first}'`;
}

/**
 * 業種名の表記ゆれをそろえる。
 *
 * 取込元によって「10:プロパン会社」のようにコード付きで来るものと、
 * 「プロパン会社」だけで来るものがあり、そのままでは絞り込みの選択肢に
 * 同じ業種が2つ並ぶ（実データでは22通りのうち11通りがこの重複だった）。
 * 先頭のコードを外し、英数字は半角・カタカナは全角にそろえて1つにまとめる。
 */
const KANA_HALF = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const KANA_FULL = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';
const KANA_DAKUTEN = {
  ｶ: 'ガ', ｷ: 'ギ', ｸ: 'グ', ｹ: 'ゲ', ｺ: 'ゴ', ｻ: 'ザ', ｼ: 'ジ', ｽ: 'ズ', ｾ: 'ゼ', ｿ: 'ゾ',
  ﾀ: 'ダ', ﾁ: 'ヂ', ﾂ: 'ヅ', ﾃ: 'デ', ﾄ: 'ド', ﾊ: 'バ', ﾋ: 'ビ', ﾌ: 'ブ', ﾍ: 'ベ', ﾎ: 'ボ', ｳ: 'ヴ',
};
const KANA_HANDAKUTEN = { ﾊ: 'パ', ﾋ: 'ピ', ﾌ: 'プ', ﾍ: 'ペ', ﾎ: 'ポ' };

function normIndustry(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  s = s.replace(/^[0-9A-Za-zＡ-Ｚａ-ｚ０-９]{1,3}\s*[:：]\s*/, '');   // 先頭のコード（10: / 1A： など）
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/([ｳｶ-ﾄﾊ-ﾎ])ﾞ/g, (m, c) => KANA_DAKUTEN[c] ?? m)
    .replace(/([ﾊ-ﾎ])ﾟ/g, (m, c) => KANA_HANDAKUTEN[c] ?? m)
    .replace(/[ｦ-ﾝ]/g, (c) => (KANA_HALF.indexOf(c) >= 0 ? KANA_FULL[KANA_HALF.indexOf(c)] : c));
  return s.trim() || null;
}

/** 文字での検索の対象。名前だけでなくコードや区分も「含む」で引けるようにする */
const SEARCH_COLS = [
  'corp_name', 'corp_code', 'customer_name', 'customer_code', 'delivery_name',
  'model_name', 'model_code', 'product_name', 'gas_type', 'equip_name', 'category_name', 'industry',
  'branch', 'office', 'sales_person',
];

function dealFilters(q, user) {
  const where = [];
  const params = [];
  if (q.ids) {
    const ids = String(q.ids).split(',').map(Number).filter(Number.isFinite);
    if (ids.length) {
      where.push(`id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
  }
  // 文字での検索。入れた言葉を「含む」もので絞り込む。
  // 空白で区切ると、すべての言葉を含むものだけが残る（例:「岩谷 給湯」）。
  // 名前だけでなくコード・器具区分・支店・担当者も対象にして、
  // 思いついた言葉のどれで打っても引けるようにする。
  if (String(q.q ?? '').trim()) {
    const words = String(q.q).trim().split(/[\s　]+/).filter(Boolean).slice(0, 5);
    for (const w of words) {
      const cond = SEARCH_COLS.map((c) => `LOWER(COALESCE(${c}, '')) LIKE ?`).join(' OR ');
      where.push(`(${cond})`);
      const like = `%${w.toLowerCase()}%`;
      params.push(...SEARCH_COLS.map(() => like));
    }
  }
  for (const [key, col] of [
    ['equip', 'equip_name'], ['person', 'sales_person'],
    ['customer', 'customer_code'], ['corp', 'corp_code'], ['priceType', 'price_type_code'],
    ['office', 'office'],
    ['category', 'category_name'], ['model', 'model_name'],
    ['industry', 'industry'],
  ]) {
    if (q[key]) { where.push(`${col} = ?`); params.push(q[key]); }
  }
  // 支店は「大阪」「大阪支店」のどちらの書き方でも同じ支店として絞り込む
  // （画面の選択肢は案件の書き方だが、名簿の書き方で来ることもあるため）
  if (q.branch) {
    const cands = branchMatches(q.branch);
    where.push(`branch IN (${cands.map(() => '?').join(',')})`);
    params.push(...cands);
  }
  // 交渉の進み具合（未入力 / 合意済 / 完了）。ビューの r2_state と同じ条件で絞る
  for (const [key, col] of [['r2State', 'r2_state']]) {
    if (['open', 'agreed', 'done'].includes(q[key])) { where.push(`${col} = ?`); params.push(q[key]); }
  }
  // A基準の有無。マスタ登録は値上げ対象の一部のため、無い行も多い
  if (q.aState === 'has') where.push('a_price_m3 IS NOT NULL');
  else if (q.aState === 'none') where.push('a_price_m3 IS NULL');

  // 当月実績（価格調査）との突合。当月実績をベースにマスタ登録（A基準）を重ねるため、
  // マスタ登録にだけあって突合で当たらなかった品目は当月の数量（master_qty）が入らない。
  // その品目は「当月実績無し」として絞り込める
  if (q.act === 'has') where.push('master_qty IS NOT NULL');
  else if (q.act === 'none') where.push('master_qty IS NULL');

  // 売上改善額の向き。過去最新単価と当月のマスタ単価を比べて、
  // 上がった品目（プラス）・下がった品目（マイナス）・変わらない品目に分ける。
  // ダッシュボードの内訳から、その中身をこの一覧で開けるようにするための絞り込み。
  const gainHas = `past_price > 0 AND ${MASTER_PRICE} IS NOT NULL`;
  const gainDiff = `(${MASTER_PRICE} - CAST(past_price AS FLOAT))`;
  if (q.gain === 'plus') where.push(`${gainHas} AND ${gainDiff} >= 0.5`);
  else if (q.gain === 'minus') where.push(`${gainHas} AND ${gainDiff} <= -0.5`);
  else if (q.gain === 'same') where.push(`${gainHas} AND ABS(${gainDiff}) < 0.5`);
  else if (q.gain === 'none') where.push(`NOT (${gainHas})`);

  // 承認日は案件を減らす絞り込みには使わない（土台の品目はそのまま残す）。
  // ダッシュボードでは aDateCond() で「計画を充てるかどうか」の条件に使い、
  // 案件一覧では aState と同じように a_date_m3 で絞る用途だけに残す。
  if (q.aDateFilter === 'row' && /^\d{4}-(0[1-9]|1[0-2])$/.test(String(q.aDateYm ?? ''))) {
    const first = `${q.aDateYm}-01`;
    where.push(q.aDateOp === 'before' ? 'a_date_m3 < ?' : 'a_date_m3 >= ?');
    params.push(first);
  }

  // 合意単価が目標に届かなかったもの。
  //
  // 対象は「実際に合意した行」だけ（r2_state が open でない）。
  // 管理表では未交渉の行にも0が入っている。これを未達に含めると、
  // これから交渉する案件が目標額まるごとの不足として並んでしまう。
  const below = (n) =>
    `(r${n}_state <> 'open' AND r${n}_agreed_price > 0`
    + ` AND r${n}_target_price IS NOT NULL`
    + ` AND r${n}_agreed_price < r${n}_target_price)`;
  if (q.below === 'r1') where.push(below(1));
  else if (q.below === 'r2') where.push(below(2));
  else if (q.below === 'any') where.push(`(${below(1)} OR ${below(2)})`);

  // 役割ごとの閲覧範囲。画面から渡される絞り込みとは別に、必ず最後に足す。
  const scope = scopeConditions(user);
  where.push(...scope.where);
  params.push(...scope.params);

  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * 案件に基準価格表との突き合わせ結果を添える（画面の目標欄に出すため）。
 * std_name: 判別した品名 / std_kind: code(コード一致)・name(品名一致)・similar(類似) /
 * std_targets: 区分ごとの値上後単価（区分を選ぶ前の候補として見せる）。
 * マスターが空のときは何も付けない。
 */
function attachStandardMatch(rows, index) {
  if (!index || index.empty) return rows;
  for (const r of rows) {
    const m = matchStandardModel(index, r);
    r.std_name = m?.model_name ?? null;
    r.std_kind = m?.kind ?? null;
    r.std_targets = m?.targets ?? null;
  }
  return rows;
}

/**
 * 出荷実績の対象月数。「2025/07〜2026/06」なら12。
 *
 * 数量は期間全体の合計で持っているので、月平均を出すのに使う。
 */
function monthsOfHist_unused(meta) {
  // 期間の文字（2025/07〜2026/06）から数えるのを最優先にする。
  // 保存してある月数は、旧版の取込が月見出しの列数を重複して数えていて
  // 実際の2倍（24など）になっていることがあるため、期間が読めないときだけ使う
  const m = /^(\d{4})\/(\d{2}).*?(\d{4})\/(\d{2})$/.exec(String(meta?.period ?? ''));
  if (m) {
    const span = (Number(m[3]) - Number(m[1])) * 12 + (Number(m[4]) - Number(m[2])) + 1;
    if (span > 0) return span;
  }
  const n = Number(meta?.months);
  if (Number.isFinite(n) && n > 0) return n;
  return 12;
}

/**
 * マスタ登録の出荷実績の対象月数。「1~3月」なら3。
 *
 * マスタ登録の売上数（master_qty）は期間（3か月）の合計で入っているので、
 * 月平均を出すのに使う。期間は取込時の見出し（「1~3月出荷単価」など）から
 * agg_meta に残してあり、読めない形式なら3か月とみなす。
 */
function monthsOfMaster() {
  // 価格調査は当月（7月など）の1か月ぶんの数量なので、月平均への割り算は要らない
  return 1;
}

/**
 * 取込の情報（出荷実績・マスタ登録・価格調査）をまとめて1回で読む。
 *
 * それぞれ別に問い合わせると、画面を開くたびに往復が3回増える。
 * 遠くのDBでは1回あたりが積み上がるため、1文にまとめている。
 */
async function loadImportMeta() {
  let rows = [];
  try {
    rows = await db.all(
      "SELECT key, value FROM settings WHERE key IN ('hist_meta', 'agg_meta', 'actual_meta')");
  } catch { /* 取込前で settings が無い場合は既定値で進む */ }
  const parse = (key) => {
    const row = rows.find((r) => r.key === key);
    try { return row ? JSON.parse(row.value) : null; } catch { return null; }
  };
  const histMeta = parse('hist_meta');
  const aggMeta = parse('agg_meta');
  const actualMeta = parse('actual_meta');
  return {
    histMeta,
    aggMeta,
    actualMeta,
    // 価格調査は当月ぶんの単価と数量なので、金額はそのまま1か月あたりになる
    months: 1,
    masterMonths: monthsOfMaster(),
  };
}

/**
 * 案件一覧の「実績」の基準。マスタ登録の単価を優先し、
 * マスタ登録に無い品目は出荷実績（月別履歴）の値で補う。
 * 出荷実績も1~3月のファイルへ切り替えたため、どちらも同じ期間の実績になる。
 *
 * 数量は期間の合計なので、それぞれの月数で割って月平均にする。
 */
/** 実単価（実績の正）。当月の金額 ÷ 数量。見積ぶんが混ざるとマスタ単価より下がる */
const EFF_PRICE = 'master_avg_price';
/** マスタ単価（値決めの単価）。A基準はこれと比べる。無ければ実単価で代用する */
const MASTER_PRICE = 'COALESCE(CAST(master_price AS FLOAT), CAST(master_avg_price AS FLOAT))';
const effMonthlyQty = () => 'COALESCE(CAST(master_qty AS FLOAT), 0)';
/** マスタ分（値決めどおりに出た分）の数量。A基準の値上げ額はこれに対して出す */
const planMonthlyQty = () => 'COALESCE(CAST(plan_qty AS FLOAT), CAST(master_qty AS FLOAT), 0)';

/**
 * 値上げ幅の「基準」（比較のもと）。画面の「基準」で選ぶ。
 *   past   … 過去最新単価（値上げ前の単価）
 *   master … 当月のマスタ単価（値決めの単価）※既定
 *   actual … 当月の実単価（金額÷数量。見積ぶんが混ざる）
 *
 * どの基準でも
 *   値上げ幅 = マスタ登録単価（A基準） − 基準の単価
 *   値上げ額 = 値上げ幅 × 当月の実績数
 * とする。数量は当月（＝実績の月）の実績数に揃えているので、
 * 実績数の無い品目・基準の単価が無い品目は「変動なし」（0）として扱う。
 */
const BASE_COLS = { past: 'past_price', master: 'master_price', actual: 'master_avg_price' };
const BASE_LABELS = { past: '過去最新単価', master: 'マスタ単価', actual: '実単価' };
/** 選ばれている基準。知らない値・未指定はマスタ単価にする */
const baseKey = (q) => (BASE_COLS[String(q?.base ?? '')] ? String(q.base) : 'master');
/** 基準の単価。0以下・未設定は「基準が無い」として扱う */
const basePriceSql = (q, prefix = '') => `CAST(${prefix}${BASE_COLS[baseKey(q)]} AS FLOAT)`;
/** 値上げ額を出すときの数量。当月の実績数。無ければ0＝変動なし */
const raiseQtySql = (prefix = '') => `COALESCE(CAST(${prefix}master_qty AS FLOAT), 0)`;
/**
 * 値上げ額（1か月あたり）のSQL。
 * 未申請（A基準が0以下）・基準の単価が無い・実績数が無い、のいずれかなら0（変動なし）。
 * NULLではなく0を返すので、金額に足しても他の金額を消してしまわない。
 */
function raiseAmtSql(aExpr, q, extraCond = '', prefix = '') {
  const base = basePriceSql(q, prefix);
  const qty = raiseQtySql(prefix);
  return `CASE WHEN ${aExpr} > 0 AND ${base} > 0 AND ${qty} > 0${extraCond ? ` AND ${extraCond}` : ''}
               THEN (CAST(${aExpr} AS FLOAT) - ${base}) * ${qty} ELSE 0 END`;
}

/**
 * 一覧の実績列に出す月。ファイルに「N月実績」の列が無くても、
 * 毎日の取込で月別履歴（master_price_history）に当月の値が貯まるため、
 * そこにある月を実績の月として使う。一覧のたびに数えないよう1分だけ使い回す。
 */
let histMonthsCache = { until: 0, months: [] };
async function histMonthsFromHistory() {
  if (histMonthsCache.until > Date.now()) return histMonthsCache.months;
  let months = [];
  try {
    const rows = await db.all('SELECT ym FROM master_price_history GROUP BY ym ORDER BY ym');
    months = rows.map((r) => String(r.ym)).filter((ym) => /^\d{4}-\d{2}$/.test(ym));
  } catch { /* 履歴の表が無い旧DBでは実績列を出さない */ }
  histMonthsCache = { until: Date.now() + 60_000, months };
  return months;
}

/**
 * 案件一覧の合計。画面の上に出している数字と、Excelの「合計」シートで同じものを使う。
 *
 * 件数と完了件数のほかに、値上げ額（1か月あたり）の合計を月ごとに出す。
 * 値上げ幅は「その月のA基準 − 基準の単価」で、値上げ額はそれに実績の月の実績数を掛けたもの。
 * 基準（過去最新単価／マスタ単価／実単価）は画面の「基準」で選ぶ。
 * 基準の単価が無い品目・実績数が無い品目は変動なし（0）として扱う。
 */
function dealsTotals(query, where, params, aggMeta, actualMeta) {
  // 承認日の条件（ダッシュボードと同じ判定）。合計の計上に使う
  const approvedCond = aDateCond(query);
  return db.get(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN r2_done = 1 THEN 1 ELSE 0 END) AS r2_done,
             SUM(CASE WHEN past_price > 0 AND ${MASTER_PRICE} IS NOT NULL
                       AND ${MASTER_PRICE} - CAST(past_price AS FLOAT) >= 0.5
                      THEN (${MASTER_PRICE} - CAST(past_price AS FLOAT))
                           * (${planMonthlyQty()}) ELSE 0 END) AS gain_plus,
             SUM(CASE WHEN past_price > 0 AND ${MASTER_PRICE} IS NOT NULL
                       AND ${MASTER_PRICE} - CAST(past_price AS FLOAT) <= -0.5
                      THEN (${MASTER_PRICE} - CAST(past_price AS FLOAT))
                           * (${planMonthlyQty()}) ELSE 0 END) AS gain_minus,
             ${[0, 1, 2, 3].map((n) => {
               // 翌月は「承認日が古ければ当月をスライド」の決まりを当てはめる（表示と同じ）
               const a = aPriceSql(n, slideFromDate(aggMeta, actualMeta));
               // 承認日の絞り込みは、ダッシュボードと同じく「値上げ額を計上するか」に効かせる。
               // 案件は全部そのまま出したうえで、合計だけ条件に合うものを足す。
               return `
             SUM(${raiseAmtSql(a, query, approvedCond)}) AS raise_m${n}`;
             }).join(',')}
      FROM deal_calc ${where}`, params);
}

api.get('/deals', wrap(async (req, res) => {
  const { where, params } = dealFilters(req.query, req.user);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Number(req.query.size) || 50);
  const { months, masterMonths: mMonths, aggMeta, actualMeta } = await loadImportMeta();
  const [totals, rows] = await Promise.all([
    dealsTotals(req.query, where, params, aggMeta, actualMeta),
    // 交渉は法人単位で進むため、法人の交渉情報と直近の履歴を添える。
    // 相関サブクエリにしてあるのは、SQLite/PostgreSQLの双方で同じSQLが通るようにするため
    // （LATERAL join はSQLiteが解釈できない）。
    db.all(`
      SELECT deal_calc.*,
        (SELECT c.status FROM corp_negotiations c WHERE c.corp_code = deal_calc.corp_code) AS corp_status,
        (SELECT c.contact_date FROM corp_negotiations c WHERE c.corp_code = deal_calc.corp_code) AS corp_contact_date,
        (SELECT c.note FROM corp_negotiations c WHERE c.corp_code = deal_calc.corp_code) AS corp_note,
        (SELECT COUNT(*) FROM negotiation_logs l WHERE l.corp_code = deal_calc.corp_code) AS corp_log_count
      FROM deal_calc ${where}
      ORDER BY ${dealOrder(req.query, { hm: months, mm: mMonths })}
      LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]),
  ]);
  attachStandardMatch(rows, await loadStandardIndex());
  hideCost(rows, req.user);
  // マスタ単価の月別実績（4月〜取込前日）。一覧のマスタ登録単価のまとまりに
  // 実績も並べるため、このページの行のぶんだけまとめて読んで行に添える。
  // ファイルに実績列が無いときは、履歴に貯まっている月を使う
  let histMonths = Array.isArray(aggMeta?.histMonths) ? aggMeta.histMonths : [];
  if (!histMonths.length) histMonths = await histMonthsFromHistory();
  const keyed = rows.filter((r) => r.hist_ent_cd && r.model_code);
  if (histMonths.length && keyed.length) {
    try {
      const hrows = await db.all(`
        SELECT ent_cd, model_code, ym, price FROM master_price_history
         WHERE ${keyed.map(() => '(ent_cd = ? AND model_code = ?)').join(' OR ')}`,
        keyed.flatMap((r) => [r.hist_ent_cd, r.model_code]));
      const byKey = new Map();
      for (const h of hrows) {
        const k = `${h.ent_cd}|${h.model_code}`;
        if (!byKey.has(k)) byKey.set(k, {});
        byKey.get(k)[h.ym] = h.price;
      }
      for (const r of rows) {
        r.hist_prices = byKey.get(`${r.hist_ent_cd}|${r.model_code}`) ?? null;
      }
    } catch { /* 履歴の表が無い旧DBでは実績列を出さない */ }
  }
  res.json({ rows, totals, page, size, months, masterMonths: mMonths, histMonths });
}));

/**
 * 検索の候補。入力中の文字を含むものを種類ごとに返す。
 *
 * 「東京ガス」まで打てば法人、「FH」なら器種、という具合に
 * 何で絞り込めるのかを示す。表示できる範囲は案件一覧と同じ。
 *
 * 候補を選ぶとコード（法人コード・得意先コード）で絞り込むため、
 * 同じ名前の取引先が複数あっても取り違えない。
 */
api.get('/suggest', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const q = String(req.query.q ?? '').trim();
  if (q.length < 1) return res.json({ groups: [] });

  const scope = scopeConditions(req.user);
  const and = scope.where.length ? ` AND ${scope.where.join(' AND ')}` : '';
  const like = `%${q}%`;
  const PER_GROUP = 8;

  const [corps, customers, models, persons, equips] = await Promise.all([
    db.all(`SELECT corp_code AS code, MIN(corp_name) AS name, COUNT(*) AS count
              FROM deals WHERE corp_name LIKE ?${and}
             GROUP BY corp_code ORDER BY COUNT(*) DESC LIMIT ?`, [like, ...scope.params, PER_GROUP]),
    db.all(`SELECT customer_code AS code, MIN(customer_name) AS name, COUNT(*) AS count
              FROM deals WHERE customer_name LIKE ?${and}
             GROUP BY customer_code ORDER BY COUNT(*) DESC LIMIT ?`, [like, ...scope.params, PER_GROUP]),
    db.all(`SELECT model_name AS name, COUNT(*) AS count
              FROM deals WHERE model_name LIKE ?${and}
             GROUP BY model_name ORDER BY COUNT(*) DESC LIMIT ?`, [like, ...scope.params, PER_GROUP]),
    db.all(`SELECT sales_person AS name, COUNT(*) AS count
              FROM deals WHERE sales_person LIKE ?${and}
             GROUP BY sales_person ORDER BY COUNT(*) DESC LIMIT ?`, [like, ...scope.params, PER_GROUP]),
    db.all(`SELECT equip_name AS name, COUNT(*) AS count
              FROM deals WHERE equip_name LIKE ?${and}
             GROUP BY equip_name ORDER BY COUNT(*) DESC LIMIT ?`, [like, ...scope.params, PER_GROUP]),
  ]);

  // filter は案件一覧の絞り込みキー。候補を選んだときにそのまま使う
  const groups = [
    { key: 'corp', label: '法人', filter: 'corp', items: corps },
    { key: 'customer', label: '得意先', filter: 'customer', items: customers },
    { key: 'model', label: '品目階層名', filter: 'model', items: models },
    { key: 'person', label: '担当者', filter: 'person', items: persons },
    { key: 'equip', label: '器具区分', filter: 'equip', items: equips },
  ].filter((g) => g.items.length > 0);

  res.json({ groups });
}));

api.get('/deals/export', wrap(async (req, res) => {
  const { where, params } = dealFilters(req.query, req.user);
  const { c } = await db.get(`SELECT COUNT(*) AS c FROM deal_calc ${where}`, params);
  if (Number(c) > EXPORT_MAX_ROWS) {
    return res.status(413).json({
      error: `対象が${Number(c).toLocaleString()}件あります。`
        + `一度に書き出せるのは${EXPORT_MAX_ROWS.toLocaleString()}件までです。`
        + '器具区分・担当者・得意先などで絞り込んでから実行してください',
    });
  }
  const { months, masterMonths: mMonths, aggMeta, actualMeta } = await loadImportMeta();
  const [rows, priceTypes, totals] = await Promise.all([
    db.all(`
      SELECT deal_calc.*,
        (SELECT c.status FROM corp_negotiations c WHERE c.corp_code = deal_calc.corp_code) AS corp_status
      FROM deal_calc ${where}
      ORDER BY ${dealOrder(req.query, { hm: months, mm: mMonths })}`, params),
    db.all('SELECT * FROM price_types ORDER BY code'),
    // 画面の上に出しているのと同じ合計。「合計」シートに添える
    dealsTotals(req.query, where, params, aggMeta, actualMeta),
  ]);
  // 実績原価は本社・管理者・開発者のときだけ列に出す（社外秘に準ずる扱い）
  const withCost = canSeeAllInfo(req.user.role);
  const buffer = buildWorkbook(rows, priceTypes,
    { months, masterMonths: mMonths, withCost, aggMeta, actualMeta, base: baseKey(req.query),
      aDate: { ym: req.query.aDateYm, op: req.query.aDateOp },
      totals, filters: dealsFilterLabels(req.query) });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', contentDisposition(`値上げ管理表_${stamp}.xlsx`, `price-list_${stamp}.xlsx`));
  res.send(buffer);
}));

/**
 * 件数が多いときの分割出力。
 *
 * サーバーレス（Vercel）は1回の応答が約4.5MBまでのため、Excelファイルを
 * サーバーで作って返せるのは数千件が限度（EXPORT_MAX_ROWS）。
 * それを超える出力は、この入口で表の中身を数千行ずつJSONで取り出し、
 * ブラウザ側でExcelファイルに組み立てる（取込と同じで、ブラウザなら
 * 応答の大きさにも実行時間にも上限が無い）。
 *
 * ページ送りはOFFSETではなく「前回の最後の案件ID より後」で行う。
 * OFFSETだと後ろのページほど並べ直しが重くなり、10万件で数十秒余計にかかる。
 * このためこの出力の並びは案件ID順（Excel側で並べ替えて使う想定）。
 */
const EXPORT_CHUNK_ROWS = 4000;
api.get('/deals/export-rows', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const { where, params } = dealFilters(req.query, req.user);
  const sinceId = Number(req.query.sinceId) || 0;
  const cond = where ? `${where} AND id > ?` : 'WHERE id > ?';
  const { months, masterMonths: mMonths, aggMeta, actualMeta } = await loadImportMeta();
  const [rows, totalRow, totals] = await Promise.all([
    db.all(`
      SELECT deal_calc.*,
        (SELECT c.status FROM corp_negotiations c WHERE c.corp_code = deal_calc.corp_code) AS corp_status
      FROM deal_calc ${cond}
      ORDER BY id LIMIT ?`, [...params, sinceId, EXPORT_CHUNK_ROWS]),
    // 全体の件数は最初の1回だけ数える（進み具合の表示用）
    sinceId === 0 ? db.get(`SELECT COUNT(*) AS c FROM deal_calc ${where}`, params) : null,
    // 合計も最初の1回だけ。10万件の集計を分割のたびに回さない
    sinceId === 0 ? dealsTotals(req.query, where, params, aggMeta, actualMeta) : null,
  ]);
  const withCost = canSeeAllInfo(req.user.role);
  const table = buildExportTable(rows,
    { months, masterMonths: mMonths, withCost, aggMeta, actualMeta, base: baseKey(req.query),
      aDate: { ym: req.query.aDateYm, op: req.query.aDateOp } });
  res.json({
    rows: table.rows,
    // 見出しなどの形は最初の1回だけ返す（毎回返しても害はないが応答を小さく保つ）
    ...(sinceId === 0 ? {
      header: table.header,
      widths: table.widths,
      total: Number(totalRow?.c ?? 0),
      // 「合計」シートの中身。サーバーで作る出力と同じものをブラウザ側でも置く
      totalsSheet: buildTotalsSheet(totals,
        { aggMeta, actualMeta, filters: dealsFilterLabels(req.query) }),
      totalsWidths: TOTALS_SHEET_WIDTHS,
      totalsName: TOTALS_SHEET_NAME,
    } : {}),
    // 次のページはこのIDより後から。これ以上無ければ null
    nextId: rows.length === EXPORT_CHUNK_ROWS ? rows[rows.length - 1].id : null,
  });
}));

/**
 * 範囲内の案件を1件取る。範囲外なら null。
 * 範囲外は「権限がありません」ではなく「見つかりません」として扱う。
 * 断り方で他営業所にその案件が在ることを教えないため。
 */
async function findDealInScope(id, user, table = 'deal_calc') {
  const scope = scopeConditions(user);
  const where = ['id = ?', ...scope.where].join(' AND ');
  return db.get(`SELECT * FROM ${table} WHERE ${where}`, [id, ...scope.params]);
}

api.get('/deals/:id', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const deal = await findDealInScope(req.params.id, req.user);
  if (!deal) return res.status(404).json({ error: '案件が見つかりません' });
  attachStandardMatch([deal], await loadStandardIndex());
  hideCost([deal], req.user);
  // 交渉は法人単位で進むため、法人の交渉情報と履歴を一緒に返す
  const negotiation = deal.corp_code
    ? await db.get('SELECT * FROM corp_negotiations WHERE corp_code = ?', [deal.corp_code])
    : null;
  const logs = deal.corp_code
    ? await db.all(`
        SELECT l.*, u.name AS user_name FROM negotiation_logs l
        LEFT JOIN users u ON u.id = l.user_id
        WHERE l.corp_code = ? ORDER BY COALESCE(l.contact_date, l.created_at) DESC, l.id DESC`,
        [deal.corp_code])
    : [];
  // マスタ単価の実績（月別履歴）。4月〜取込時点（当月は取り込んだ前日まで）
  let priceHistory = [];
  if (deal.hist_ent_cd && deal.model_code) {
    try {
      priceHistory = await db.all(`
        SELECT ym, price, source, updated_at FROM master_price_history
         WHERE ent_cd = ? AND model_code = ? ORDER BY ym`,
        [deal.hist_ent_cd, deal.model_code]);
    } catch { /* 履歴の表が無い旧DBでは空のまま */ }
  }
  res.json({ deal, negotiation: negotiation ?? null, logs, priceHistory });
}));

// 値上げ交渉の項目。営業担当者を含む全権限が案件一覧から入れられる。
// 列名の r2_ は旧・第2弾の名残で、いまは唯一の交渉を指す。
const EDITABLE = [
  'r2_agreed_price', 'r2_applied_ym', 'r2_done',
  // 値上げ交渉（営業担当者が入力する）。商談メモは商談結果の詳細
  'nego_result', 'nego_note', 'final_date', 'final_price',
];

// 本社（planning）・管理者・開発者。目標値の設定など、交渉以外の変更ができる
const HQ_ROLES = ['planning', 'admin', 'developer'];
const isHqRole = (role) => HQ_ROLES.includes(role);

/** 商談結果の選択肢。〇=合意 / □=広域待ち / △=否決 / ×=本社へ相談 */
const NEGO_RESULTS = ['〇', '□', '△', '×'];

/**
 * 商談結果の記号の表記ゆれをそろえる。Excelの取込値をそのまま生かすため、
 * 丸（○/〇/◯）・バツ（×/✕/Ｘ/x）などのどれで来ても同じ記号として扱う。
 * 選択肢に無い文字はそのまま返す（取込では弾かず、入っていた値を残す）
 */
function normNegoResult(v) {
  const t = String(v ?? '').trim();
  if (!t) return null;
  if (['○', '〇', '◯'].includes(t)) return '〇';
  if (['□', '■'].includes(t)) return '□';
  if (['△', '▲'].includes(t)) return '△';
  if (['×', '✕', '✗', 'X', 'x', 'Ｘ'].includes(t)) return '×';
  return t;
}

// 目標値上げ単価・単価種別は本社（と管理者）だけが直せる。
// 誰でも直せると目標そのものが動いてしまい、進捗の意味が無くなるため。
const HQ_ONLY_EDITABLE = ['r2_target_price', 'price_type_code'];

// 取込で入る残りの列（法人名・器種・出荷単価・支店など）。
// 取込のズレ（列の取り違え・誤記）を直すためのもので、開発者だけが変更できる。
// 通常の運用でここが動くと管理表と食い違うため、管理者にも開放しない。
const DEVELOPER_EDITABLE = FIELDS
  .filter((f) => !EDITABLE.includes(f.key) && !HQ_ONLY_EDITABLE.includes(f.key))
  .map((f) => ({ key: f.key, label: f.label, type: f.type }));

/** 開発者の修正用。取込と同じく、空欄は未設定として受ける */
function toLooseNumber(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[,¥\s]/g, ''));
  if (!Number.isFinite(n)) throw new Error('数値で入力してください');
  return n;
}

const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 適用年月は「YYYY-MM」に寄せる（2026/4 や 202604 も受ける） */
function normalizeYm(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  const m = /^(\d{4})\D?(\d{1,2})$/.exec(raw.replace(/\s/g, ''));
  if (m) {
    const mm = String(Number(m[2])).padStart(2, '0');
    const ym = `${m[1]}-${mm}`;
    if (YM_RE.test(ym)) return ym;
  }
  throw new Error(`適用年月は「2026-04」の形式で入力してください（受け取った値: ${raw}）`);
}

function toPrice(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('単価は数値で入力してください');
  if (n < 0) throw new Error('単価に負の数は指定できません');
  return n;
}

/**
 * 更新する項目を組み立てる。1件更新と一括取込で同じ判断を使う。
 * 入力が不正なときは Error を投げる（呼び出し側で理由をそのまま返す）。
 */
function buildDealUpdate(body, deal, user) {
  const sets = [];
  const params = [];

  for (const f of EDITABLE) {
    if (!(f in body)) continue;
    let v = body[f];
    if (f.endsWith('_agreed_price') || f === 'final_price') v = toPrice(v);
    else if (f.endsWith('_applied_ym')) v = normalizeYm(v);
    else if (f.endsWith('_done')) v = v ? 1 : 0;
    else if (f === 'nego_result') {
      v = normNegoResult(v);
      if (v != null && !NEGO_RESULTS.includes(v)) {
        throw new Error('商談結果は 〇（合意）/ □（広域待ち）/ △（否決）/ ×（本社へ相談）から選んでください');
      }
    } else if (f === 'nego_note') {
      v = String(v ?? '').trim() || null;
      if (v != null && v.length > 500) {
        throw new Error('商談メモは500文字以内で入力してください');
      }
    } else if (f === 'final_date') {
      v = String(v ?? '').trim() || null;
      if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error('最終確定日は「2026-08-20」の形式で入力してください');
      }
    } else v = nv(v);
    sets.push(`${f} = ?`);
    params.push(v);
  }
  for (const f of HQ_ONLY_EDITABLE) {
    if (!(f in body)) continue;
    if (!isHqRole(user.role)) {
      throw new Error(f === 'r2_target_price'
        ? '目標値上げ単価を変更できるのは本社（と管理者）のみです'
        : '単価種別を変更できるのは本社（と管理者）のみです');
    }
    sets.push(`${f} = ?`);
    params.push(f === 'r2_target_price' ? toPrice(body[f]) : nv(body[f]));
  }
  // B基準（実際の決定単価）。本社と管理者が入れる
  if ('b_price' in body) {
    if (!isHqRole(user.role)) {
      throw new Error('決定単価（B基準）を入力できるのは本社（と管理者）のみです');
    }
    sets.push('b_price = ?');
    params.push(toPrice(body.b_price));
  }
  for (const f of DEVELOPER_EDITABLE) {
    if (!(f.key in body)) continue;
    if (user.role !== 'developer') {
      throw new Error(`「${f.label}」を変更できるのは開発者のみです`);
    }
    let v;
    try {
      v = f.type === 'number' ? toLooseNumber(body[f.key]) : nv(String(body[f.key] ?? '').trim() || null);
    } catch (e) {
      throw new Error(`「${f.label}」: ${e.message}`);
    }
    sets.push(`${f.key} = ?`);
    params.push(v);
  }
  if (!sets.length) throw new Error('更新項目がありません');

  // 完了にするには合意単価が要る。空や0のまま完了にできると、
  // 何で妥結したのか分からない行が「完了」として残ってしまう。
  const next = { ...deal };
  sets.forEach((set, i) => { next[set.split(' =')[0]] = params[i]; });
  if (Number(next.r2_done) === 1 && !(Number(next.r2_agreed_price) > 0)) {
    throw new Error('完了にするには合意単価を入力してください');
  }

  // 中身が変わらない行は書き込まない（一括取込では大半が変更なしのため）
  const changed = sets.some((set, i) => {
    const col = set.split(' =')[0];
    const before = deal[col];
    const after = params[i];
    if (before == null && after == null) return false;
    if (before == null || after == null) return true;
    return String(before) !== String(after);
  });

  return { sets, params, changed };
}

api.patch('/deals/:id', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  // 範囲外の案件は更新もできない（参照と同じ扱いにする）
  const deal = await findDealInScope(req.params.id, req.user, 'deals');
  if (!deal) return res.status(404).json({ error: '案件が見つかりません' });

  // 区分の選択。目標値上げ単価は手入力ではなく、
  // 選んだ区分に対応する基準価格表の「値上後単価」が入る。
  // 目標値が変わる操作のため、本社（と管理者）だけができる。
  const extraSets = [];
  const extraParams = [];
  const body = { ...req.body };
  if ('kubun' in body) {
    if (!isHqRole(req.user.role)) {
      return res.status(403).json({ error: '区分の選択（目標値の設定）ができるのは本社（と管理者）のみです' });
    }
    const kubun = String(body.kubun ?? '').trim();
    delete body.kubun;
    if (!kubun) {
      // 区分を外す。基準の根拠が無くなるため目標も未設定に戻す
      extraSets.push('kubun = ?', 'r2_target_price = ?');
      extraParams.push(null, null);
    } else {
      if (!KUBUNS.includes(kubun)) {
        return res.status(400).json({ error: `区分は ${KUBUNS.join(' / ')} から選んでください` });
      }
      const std = await findStandardPrice(deal, kubun);
      if (!std || std.target_price == null) {
        // 器種が当たったのに区分の単価だけ無い場合は、判別した品名で案内する
        const name = std?.model_name ?? deal.model_name;
        return res.status(400).json({
          error: `基準価格表に「${name}」（${kubun}）の単価がありません。`
            + 'マスターの登録内容をご確認ください',
        });
      }
      extraSets.push('kubun = ?', 'r2_target_price = ?');
      extraParams.push(kubun, std.target_price);
    }
  }

  let built = { sets: [], params: [], changed: true };
  if (Object.keys(body).length) {
    try {
      built = buildDealUpdate(body, deal, req.user);
    } catch (e) {
      return res.status(/のみです$/.test(e.message) ? 403 : 400).json({ error: e.message });
    }
  } else if (!extraSets.length) {
    return res.status(400).json({ error: '更新項目がありません' });
  }

  const sets = [...extraSets, ...built.sets, 'updated_at = ?'];
  const params = [...extraParams, ...built.params, now(), req.params.id];
  await db.run(`UPDATE deals SET ${sets.join(', ')} WHERE id = ?`, params);
  const updated = await db.get('SELECT * FROM deal_calc WHERE id = ?', [req.params.id]);
  // 器種名や支店を直した直後も、画面の「基準: ○○」表示が追随するように添える
  attachStandardMatch([updated], await loadStandardIndex());
  hideCost([updated], req.user);
  res.json(updated);
}));

// 一括取込で一度に受け取る行数。JSONにして数百KBに収まる大きさにする
const BULK_UPDATE_CHUNK = 500;

/**
 * 案件一覧から書き出したExcelを、記入して戻すための一括更新。
 *
 * 案件IDで突き合わせ、合意単価・適用年月・完了だけを更新する。
 * 判断は1件更新と同じ（buildDealUpdate）ため、画面から直したときと
 * 結果が食い違うことがない。
 *
 * dryRun=true のときは書き込まずに件数だけ返す。
 * 数千行をまとめて書き換える操作なので、取り込む前に中身を確かめられるようにする。
 */
api.post('/deals/bulk-update', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows?.length) return res.status(400).json({ error: '取り込む行がありません' });
  if (rows.length > BULK_UPDATE_CHUNK) {
    return res.status(400).json({ error: `一度に送れるのは${BULK_UPDATE_CHUNK}行までです` });
  }
  const dryRun = req.body?.dryRun === true;

  let updated = 0;      // 実際に変わる行
  let unchanged = 0;    // 中身が同じで書き込む必要のない行
  let notFound = 0;     // 範囲外・存在しないID
  const errors = [];    // 入力が不正な行

  for (const row of rows) {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) {
      errors.push({ id: row?.id ?? null, message: '案件IDが読み取れません' });
      continue;
    }
    const deal = await findDealInScope(id, req.user, 'deals');
    if (!deal) { notFound += 1; continue; }

    const body = {};
    for (const f of [...EDITABLE, ...ADMIN_ONLY_EDITABLE]) {
      if (f in row) body[f] = row[f];
    }
    if (!Object.keys(body).length) { unchanged += 1; continue; }

    let built;
    try {
      built = buildDealUpdate(body, deal, req.user);
    } catch (e) {
      errors.push({ id, message: e.message });
      continue;
    }
    if (!built.changed) { unchanged += 1; continue; }
    updated += 1;
    if (dryRun) continue;

    await db.run(
      `UPDATE deals SET ${[...built.sets, 'updated_at = ?'].join(', ')} WHERE id = ?`,
      [...built.params, now(), id]
    );
  }

  res.json({ dryRun, updated, unchanged, notFound, errors });
}));

/**
 * Content-Disposition を組み立てる（RFC 6266）。
 * filename* だけだと、環境によっては非ASCII名が落ちて「download」になるため、
 * ASCIIのフォールバック名を必ず併記する。
 */
function contentDisposition(filename, asciiFallback) {
  const fallback = (asciiFallback || filename.replace(/[^\x20-\x7E]/g, '_'))
    .replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---- 法人ごとの交渉情報・交渉履歴 ----
// 単価は器種ごとでも、交渉そのものは法人（本部）単位で進むため、
// 交渉状況とメモ・履歴は法人に紐づけて持つ。

const CORP_STATUSES = [
  { code: 'not_started', name: '未着手' },
  { code: 'negotiating', name: '交渉中' },
  { code: 'agreed', name: '合意' },
  { code: 'declined', name: '値上げ不可' },
];
const CORP_STATUS_CODES = new Set(CORP_STATUSES.map((x) => x.code));

/** 法人の概要（案件件数・弾ごとの完了件数）と交渉情報 */
api.get('/corps', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const where = [];
  const params = [];
  if (req.query.q) {
    where.push('(d.corp_name LIKE ? OR d.corp_code LIKE ?)');
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  if (req.query.branch) { where.push('d.branch = ?'); params.push(req.query.branch); }
  // 法人は案件から作るので、案件と同じ範囲で絞る
  const scope = scopeConditions(req.user, 'd');
  where.push(...scope.where);
  params.push(...scope.params);
  const rows = await db.all(`
    SELECT d.corp_code, MIN(d.corp_name) AS corp_name,
           COUNT(*) AS deals,
           SUM(CASE WHEN d.r2_done = 1 THEN 1 ELSE 0 END) AS r2_done,
           (SELECT c.status FROM corp_negotiations c WHERE c.corp_code = d.corp_code) AS status,
           (SELECT c.contact_date FROM corp_negotiations c WHERE c.corp_code = d.corp_code) AS contact_date,
           (SELECT c.note FROM corp_negotiations c WHERE c.corp_code = d.corp_code) AS note,
           (SELECT COUNT(*) FROM negotiation_logs l WHERE l.corp_code = d.corp_code) AS log_count
      FROM deals d
     WHERE d.corp_code IS NOT NULL ${where.length ? 'AND ' + where.join(' AND ') : ''}
     GROUP BY d.corp_code
     ORDER BY MIN(d.corp_name)`, params);
  res.json(rows);
}));

/**
 * 範囲内に案件がある法人だけを返す。
 * 自分の支店が取引していない法人は、交渉情報も履歴も見せない。
 */
async function findCorpInScope(code, user) {
  const scope = scopeConditions(user);
  const where = ['corp_code = ?', ...scope.where].join(' AND ');
  return db.get(`
    SELECT corp_code, MIN(corp_name) AS corp_name, COUNT(*) AS deals,
           SUM(CASE WHEN r2_done = 1 THEN 1 ELSE 0 END) AS r2_done
      FROM deals WHERE ${where} GROUP BY corp_code`, [code, ...scope.params]);
}

api.get('/corps/:code', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const code = String(req.params.code);
  const summary = await findCorpInScope(code, req.user);
  if (!summary) return res.status(404).json({ error: '法人が見つかりません' });
  const negotiation = await db.get('SELECT * FROM corp_negotiations WHERE corp_code = ?', [code]);
  const logs = await db.all(`
    SELECT l.*, u.name AS user_name FROM negotiation_logs l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.corp_code = ? ORDER BY COALESCE(l.contact_date, l.created_at) DESC, l.id DESC`, [code]);
  res.json({ ...summary, negotiation: negotiation ?? null, logs });
}));

/** 法人の交渉情報（状況・直近商談日・メモ）を更新する */
api.put('/corps/:code/negotiation', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const code = String(req.params.code);
  const corp = await findCorpInScope(code, req.user);
  if (!corp?.corp_name) return res.status(404).json({ error: '法人が見つかりません' });

  const status = String(req.body?.status ?? 'not_started');
  if (!CORP_STATUS_CODES.has(status)) return res.status(400).json({ error: '交渉状況の指定が不正です' });

  const existing = await db.get('SELECT corp_code FROM corp_negotiations WHERE corp_code = ?', [code]);
  const args = [corp.corp_name, status, nv(req.body?.contact_date) || null,
                nv(req.body?.note) || null, now(), req.user.id];
  if (existing) {
    await db.run(`UPDATE corp_negotiations
                     SET corp_name = ?, status = ?, contact_date = ?, note = ?, updated_at = ?, updated_by = ?
                   WHERE corp_code = ?`, [...args, code]);
  } else {
    await db.run(`INSERT INTO corp_negotiations
                    (corp_name, status, contact_date, note, updated_at, updated_by, corp_code)
                  VALUES (?,?,?,?,?,?,?)`, [...args, code]);
  }
  res.json(await db.get('SELECT * FROM corp_negotiations WHERE corp_code = ?', [code]));
}));

api.get('/corps/:code/logs', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const code = String(req.params.code);
  // 範囲外の法人の履歴は見せない
  if (!await findCorpInScope(code, req.user)) return res.status(404).json({ error: '法人が見つかりません' });
  res.json(await db.all(`
    SELECT l.*, u.name AS user_name FROM negotiation_logs l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.corp_code = ? ORDER BY COALESCE(l.contact_date, l.created_at) DESC, l.id DESC`, [code]));
}));

api.post('/corps/:code/logs', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const code = String(req.params.code);
  const corp = await findCorpInScope(code, req.user);
  if (!corp?.corp_name) return res.status(404).json({ error: '法人が見つかりません' });
  const note = String(req.body?.note ?? '').trim();
  if (!note) return res.status(400).json({ error: '内容を入力してください' });

  const { lastInsertRowid } = await db.run(
    `INSERT INTO negotiation_logs (corp_code, user_id, contact_date, channel, result, note, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [code, req.user.id, nv(req.body.contact_date) || null, nv(req.body.channel) || null,
     nv(req.body.result) || null, note, now()]
  );
  res.status(201).json(await db.get(
    `SELECT l.*, u.name AS user_name FROM negotiation_logs l
     LEFT JOIN users u ON u.id = l.user_id WHERE l.id = ?`, [Number(lastInsertRowid)]));
}));

api.delete('/logs/:id', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const log = await db.get('SELECT * FROM negotiation_logs WHERE id = ?', [req.params.id]);
  if (!log) return res.status(404).json({ error: '履歴が見つかりません' });
  // 範囲外の法人の履歴には触れない
  if (log.corp_code && !await findCorpInScope(log.corp_code, req.user)) {
    return res.status(404).json({ error: '履歴が見つかりません' });
  }
  if (log.user_id !== req.user.id && !['planning', 'admin', 'developer'].includes(req.user.role)) {
    return res.status(403).json({ error: '記入者本人または本社のみ削除できます' });
  }
  await db.run('DELETE FROM negotiation_logs WHERE id = ?', [log.id]);
  res.json({ ok: true });
}));

// ---- 添付ファイル ----
// 1ファイルあたりの上限
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/**
 * multerのoriginalnameはUTF-8のバイト列をlatin-1として解釈した文字列で渡ってくるため、
 * 日本語のファイル名が「çµ¦æ¹¯å™¨…」のように化ける。バイト列へ戻してUTF-8で読み直す。
 *
 * 添付とExcel取込の両方で使う。定義が無いとアップロードが500になるため、
 * 使う側より前に置いておく。
 */
function decodeUploadName(name) {
  if (!name) return name;
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    // 復元に失敗すると U+FFFD が出る。その場合は元の文字列のままにする
    return decoded.includes('�') ? name : decoded;
  } catch {
    return name;
  }
}

api.get('/attachments', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const dealId = Number(req.query.dealId);
  if (!Number.isFinite(dealId)) return res.status(400).json({ error: '案件を指定してください' });
  // 範囲外の案件に付いた添付は一覧にも出さない
  if (!await findDealInScope(dealId, req.user, 'deals')) {
    return res.status(404).json({ error: '案件が見つかりません' });
  }
  res.json(await db.all(`
    SELECT a.id, a.deal_id, a.filename, a.mime_type, a.size, a.uploaded_at, u.name AS uploaded_by_name
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.deal_id = ? ORDER BY a.id DESC`, [dealId]));
}));

api.post('/attachments', upload.single('file'), wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'ファイルを選択してください' });
  if (req.file.size > MAX_ATTACHMENT_BYTES) {
    return res.status(413).json({ error: `1ファイル${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MBまでです` });
  }
  const dealId = Number(req.body?.dealId);
  if (!Number.isFinite(dealId)) return res.status(400).json({ error: '案件を指定してください' });
  if (!await findDealInScope(dealId, req.user, 'deals')) {
    return res.status(404).json({ error: '案件が見つかりません' });
  }

  // 実体はSupabaseの保管庫へ。鍵が未設定のローカル開発では従来どおり base64 で DB に入れる。
  // blob_url には保管庫の中のパスを入れる（URLではないので保管先を変えても記録は生きる）
  const filename = decodeUploadName(req.file.originalname);
  let blobUrl = null;
  if (isFileStoreConfigured()) {
    try {
      blobUrl = await putAttachment({
        dealId, filename, mimeType: req.file.mimetype, body: req.file.buffer,
      });
    } catch (e) {
      console.error('[attachments] 保管庫への保存に失敗:', e?.message || e);
      return res.status(502).json({ error: 'ファイルの保存に失敗しました。時間をおいて再度お試しください' });
    }
  }
  let inserted;
  try {
    inserted = await db.run(
      `INSERT INTO attachments (deal_id, filename, mime_type, size, content, blob_url, uploaded_by, uploaded_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [dealId, filename, req.file.mimetype, req.file.size,
       blobUrl ? null : req.file.buffer.toString('base64'), blobUrl, req.user.id, now()]
    );
  } catch (e) {
    // DB に紐づかなかった実体を残さない
    await deleteAttachment(blobUrl);
    throw e;
  }
  const { lastInsertRowid } = inserted;
  res.status(201).json(await db.get(
    `SELECT a.id, a.deal_id, a.filename, a.mime_type, a.size, a.uploaded_at, u.name AS uploaded_by_name
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.id = ?`, [Number(lastInsertRowid)]));
}));

api.get('/attachments/:id/download', wrap(async (req, res) => {
  const a = await db.get('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'ファイルが見つかりません' });
  // 添付は案件にひもづくので、案件が範囲外なら中身も渡さない
  if (a.deal_id && !await findDealInScope(a.deal_id, req.user, 'deals')) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }
  // blob_url があれば保管庫から取得して中継する。場所自体はブラウザへ返さない。
  // 無い場合はDBに入れた行（鍵の未設定時に保存したもの）なので base64 を返す。
  let body = null;
  if (a.blob_url) {
    try {
      body = await fetchAttachment(a.blob_url);
    } catch (e) {
      console.error('[attachments] 保管庫から取得できませんでした:', e?.message || e);
    }
  } else if (a.content) {
    body = Buffer.from(a.content, 'base64');
  }
  if (!body) return res.status(502).json({ error: 'ファイル本体を取得できませんでした' });

  res.set('Content-Type', a.mime_type || 'application/octet-stream');
  res.set('Content-Disposition', contentDisposition(a.filename));
  res.send(body);
}));

api.delete('/attachments/:id', wrap(async (req, res) => {
  const a = await db.get('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'ファイルが見つかりません' });
  if (a.deal_id && !await findDealInScope(a.deal_id, req.user, 'deals')) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }
  if (a.uploaded_by !== req.user.id && !['planning', 'admin', 'developer'].includes(req.user.role)) {
    return res.status(403).json({ error: 'アップロードした本人または本社のみ削除できます' });
  }
  await db.run('DELETE FROM attachments WHERE id = ?', [a.id]);
  // DB から消えた後に実体も消す。失敗しても業務は止めない（fileStore 側でログのみ）
  await deleteAttachment(a.blob_url);
  res.json({ ok: true });
}));

// ---- マスタ登録（集約表）の取込 ----
//
// 案件の土台は価格調査（得意先×商品）。マスタ登録は 得意先×納入先×商品 の
// 細かい単位なので、得意先×商品へ集約してからA基準として重ねる。
// 単価は数量で加重平均する（Σ単価×数量 ÷ Σ数量）。
// 突き合わせは得意先コードなので、法人（企業グループ）の分け方は関係しない。

api.post('/agg-import/start', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const filename = String(req.body?.filename ?? '価格調査.xlsx');
  // 価格調査（毎日更新）が案件一覧の土台。空のDBへも取り込める
  await db.run('DELETE FROM agg_staging');
  const meta = req.body?.meta;
  if (meta && typeof meta === 'object') {
    // 計画の月（当月〜3か月後）は、ファイルの見出しではなくデータの日付から決める。
    // 毎日の価格調査は前日の結果なので、9/1に取り込んでも当月は8月のまま。
    // ここをファイル任せにすると、月初の取込で前の月が計画から抜けてしまう
    const takenOn = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.takenOn ?? ''))
      ? String(req.body.takenOn) : '';
    const dataDate = dataDateOf(takenOn);
    const [pm0, pm1, pm2, pm3] = planMonthsFrom(dataDate);
    await db.run(
      `INSERT INTO settings (key, value) VALUES ('agg_meta', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({
        m0: pm0 ?? String(meta.m0 ?? ''),
        m1: pm1 ?? String(meta.m1 ?? ''),
        m2: pm2 ?? String(meta.m2 ?? ''),
        m3: pm3 ?? String(meta.m3 ?? ''),
        // 月を決めたもとにしたデータの日付と、ファイルの見出しから読めた月。
        // 食い違ったときに、どちらの決まりで出た数字か後から追えるように残す
        dataDate,
        fileMonths: Array.isArray(meta.fileMonths)
          ? meta.fileMonths.map(String).slice(0, 4) : [],
        basePeriod: String(meta.basePeriod ?? ''), filename,
        // 目標単価の列があるファイルか。あるときは取込でファイルの内容を正とする
        hasTarget: meta.hasTarget === true,
        // 値上げ額の履歴に残す取込日（YYYY-MM-DD）。ふだんは空＝今日。
        // 前回のファイルを取り込み直して前日比を埋めたいときだけ指定する
        takenOn,
        // 値上げ交渉の記録（商談結果・最終確定日・最終確定単価）をファイルの値で
        // 入れ直すか。毎日の取込はマスタ登録単価を入れ直すためのもので、
        // 交渉の記録は営業担当者がアプリで入れるため、既定では触らない。
        // ファイル側でまとめて直したときだけ true にする
        overwriteNego: req.body?.overwriteNego === true,
        // マスタ単価の実績（月別）の月。「マスター単価（4月実績）」…の列があるファイルで入る
        histMonths: Array.isArray(meta.histMonths)
          ? meta.histMonths.map(String).filter((ym) => /^\d{4}-\d{2}$/.test(ym)).slice(0, 24)
          : [],
        updatedAt: new Date().toISOString(),
      })]
    );
  }
  res.json({ ok: true });
}));

api.post('/agg-import/chunk', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '取り込む行がありません' });
  if (rows.length > 4000) return res.status(400).json({ error: '一度に送れるのは4000行までです' });

  const num = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return 0;
    const n = Number(String(v).replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  // 承認日（登録日）は「YYYY-MM-DD」。足し合わせず、まとまりの中で一番新しい日を残す。
  // 稟議Noは承認とセットの情報なので、承認日が一番新しい行のものを一緒に残す。
  const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
  const txt2 = (v) => (String(v ?? '').trim() || null);
  const takeApproval = (a, dKey, rKey, date, ringi) => {
    if (date && (!a[dKey] || date > a[dKey])) {
      a[dKey] = date;
      if (ringi) a[rKey] = ringi;
    } else if (!a[dKey] && !a[rKey] && ringi) {
      a[rKey] = ringi;   // 承認日の無い形式でも、稟議Noだけあれば最初のものを残す
    }
  };

  // 法人×品目ごとにまとめる。数量は月あたりの影響額（値上げ額）の計算にだけ使い、
  // A基準・目標値の単価はファイルの値をそのまま持つ（加重平均しない）
  const acc = new Map();
  let matched = 0;
  let unmatched = 0;
  for (const r of rows) {
    // 案件は 得意先×商品。マスタ登録も同じ得意先コードで突き合わせる
    const ent = String(r.customer_code ?? '').trim();
    if (!ent) { unmatched += 1; continue; }
    matched += 1;
    const key = `${ent}|${String(r.model_code).trim()}`;
    const qty = num(r.qty);
    const a = acc.get(key) ?? {
      ent, model: String(r.model_code).trim(), qty: 0,
      base: 0, baseW: 0,
      a0: null, a1: null, a2: null, a3: null,
      cost: 0, costW: 0,
      d0: null, d1: null, d2: null, d3: null,
      r0: null, r1: null, r2: null, r3: null,
      tgt: null, nego: null, fdate: null, fprice: null,
      branch: null, office: null, person: null,
      corp_group: null, industry: null, customer_name: null, delivery_name: null,
      model_name: null,
      product_name: null, gas_type: null, equip_name: null, category_name: null,
      top: Number.NEGATIVE_INFINITY,
    };
    const isTop = qty > a.top;
    if (isTop) a.top = qty;
    // 支店・営業所・担当者などの名前は、数量の一番多い行（主な納入先）を代表にする。
    // 代表の行で空欄の項目は他の行から補う（品目名などを取りこぼさないため）
    const rep = {
      branch: String(r.branch ?? '').trim() || null,
      office: String(r.office ?? '').trim() || null,
      person: String(r.sales_person ?? '').trim() || null,
      // 実績（価格調査）に無い品目を案件として追加するときに使う
      corp_group: txt2(r.corp_group),
      industry: normIndustry(r.industry),
      customer_name: txt2(r.customer_name),
      delivery_name: txt2(r.delivery_name),
      model_name: txt2(r.model_name),
      product_name: txt2(r.product_name),
      gas_type: txt2(r.gas_type),
      equip_name: txt2(r.equip_name),
      category_name: txt2(r.category_name),
      // A基準・目標値もリストの単価をそのまま代表値として持つ。
      // 納入先違いで行が分かれても単価は同じはずなので、平均はしない
      // （0は「未申請」の印なので値として扱わない）
      a0: num(r.a_price_m0) > 0 ? num(r.a_price_m0) : null,
      a1: num(r.a_price_m1) > 0 ? num(r.a_price_m1) : null,
      a2: num(r.a_price_m2) > 0 ? num(r.a_price_m2) : null,
      a3: num(r.a_price_m3) > 0 ? num(r.a_price_m3) : null,
      tgt: num(r.target_price) > 0 ? num(r.target_price) : null,
    };
    if (isTop) {
      for (const [k, v] of Object.entries(rep)) if (v != null) a[k] = v;
    } else {
      for (const [k, v] of Object.entries(rep)) if (a[k] == null) a[k] = v;
    }
    a.qty += qty;
    // 出荷単価・実績原価は参考値のため、従来どおり
    // 「その単価が入っている行」だけの数量で加重平均する。数量0の行は重み1
    const w = qty > 0 ? qty : 1;
    const addPrice = (kAmt, kW, v) => {
      const n2 = num(v);
      if (n2 > 0) { a[kAmt] += n2 * w; a[kW] += w; }
    };
    addPrice('base', 'baseW', r.base_price);
    addPrice('cost', 'costW', r.cost_price);
    // 承認日・稟議Noは、その月の申請単価が入っている行からだけ拾う。
    // 単価が無いのに承認日だけが残るのはおかしいため
    if (num(r.a_price_m0) > 0) takeApproval(a, 'd0', 'r0', ymd(r.a_date_m0), txt2(r.a_ringi_m0));
    if (num(r.a_price_m1) > 0) takeApproval(a, 'd1', 'r1', ymd(r.a_date_m1), txt2(r.a_ringi_m1));
    if (num(r.a_price_m2) > 0) takeApproval(a, 'd2', 'r2', ymd(r.a_date_m2), txt2(r.a_ringi_m2));
    if (num(r.a_price_m3) > 0) takeApproval(a, 'd3', 'r3', ymd(r.a_date_m3), txt2(r.a_ringi_m3));
    // 商談結果・最終確定単価は数量の一番多い行を代表に、最終確定日は一番新しい日を残す
    if (qty >= a.top) {
      if (txt2(r.nego_result)) a.nego = normNegoResult(r.nego_result);
      if (num(r.final_price) > 0) a.fprice = num(r.final_price);
    }
    const fd = ymd(r.final_date);
    if (fd && (!a.fdate || fd > a.fdate)) a.fdate = fd;
    acc.set(key, a);
  }

  // 送りが分かれても最新の日が残るように、日付は加算ではなく大きい方を採る
  const keepNewer = (c) =>
    `${c} = CASE WHEN agg_staging.${c} IS NULL OR excluded.${c} > agg_staging.${c}`
    + ` THEN excluded.${c} ELSE agg_staging.${c} END`;
  // 送りが分かれても、数量の一番多い行の支店・営業所・担当者が残るようにする。
  // 片方が空欄の項目はもう片方から補う（品目名などを取りこぼさないため）
  const keepTop = (c) =>
    `${c} = CASE WHEN excluded.top_qty > agg_staging.top_qty
       THEN COALESCE(excluded.${c}, agg_staging.${c})
       ELSE COALESCE(agg_staging.${c}, excluded.${c}) END`;
  // 稟議Noは承認日とセット。承認日が新しい側の値を採る（同じなら入っている方を残す）
  const keepWithDate = (c, d) =>
    `${c} = CASE WHEN agg_staging.${d} IS NULL OR excluded.${d} > agg_staging.${d}
       THEN COALESCE(excluded.${c}, agg_staging.${c}) ELSE agg_staging.${c} END`;
  // 数量・出荷単価・実績原価は送りが分かれても足し込む（数量は影響額の計算に使う）
  const SUM_COLS = ['qty', 'base_amt', 'base_wgt', 'cost_amt', 'cost_wgt'];
  // A基準・目標値はリストの単価そのもの。amt に単価、wgt に「値あり」の印(1)を入れ、
  // 案件へ重ねるときの amt÷wgt がそのまま単価になる
  const PRICE_COLS = ['a0', 'a1', 'a2', 'a3', 'tgt'];
  // 送りが分かれても足し合わせず、数量の一番多い側の単価を残す（無い側は補う）
  const keepPrice = (c) => `
    ${c}_amt = CASE
        WHEN excluded.${c}_wgt > 0
             AND (agg_staging.${c}_wgt = 0 OR excluded.top_qty > agg_staging.top_qty)
          THEN excluded.${c}_amt
        ELSE agg_staging.${c}_amt END,
    ${c}_wgt = CASE WHEN excluded.${c}_wgt > 0 OR agg_staging.${c}_wgt > 0 THEN 1 ELSE 0 END`;
  const vals = [...acc.values()].map((a) =>
    [a.ent, a.model, a.qty, a.base, a.baseW,
      a.a0 ?? 0, a.a0 != null ? 1 : 0, a.a1 ?? 0, a.a1 != null ? 1 : 0,
      a.a2 ?? 0, a.a2 != null ? 1 : 0, a.a3 ?? 0, a.a3 != null ? 1 : 0,
      a.cost, a.costW, a.tgt ?? 0, a.tgt != null ? 1 : 0,
      a.d0, a.d1, a.d2, a.d3, a.r0, a.r1, a.r2, a.r3,
      a.branch, a.office, a.person,
      a.corp_group, a.industry, a.customer_name, a.delivery_name, a.model_name,
      a.product_name, a.gas_type, a.equip_name, a.category_name,
      a.nego, a.fdate, a.fprice,
      Number.isFinite(a.top) ? a.top : 0]);
  // 1文あたりのパラメータ上限（SQLiteは32,766個・PostgreSQLは65,535個）に
  // 収まるよう、41列×700行ずつに分けて書き込む。同じまとまりが分かれても、
  // ON CONFLICT の残し方（足し込み・数量の多い側を代表）は同じ結果になる
  for (let i = 0; i < vals.length; i += 700) {
    const part = vals.slice(i, i + 700);
    await db.run(
      `INSERT INTO agg_staging
         (ent_cd, model_code, qty, base_amt, base_wgt,
          a0_amt, a0_wgt, a1_amt, a1_wgt, a2_amt, a2_wgt, a3_amt, a3_wgt,
          cost_amt, cost_wgt, tgt_amt, tgt_wgt,
          d0_max, d1_max, d2_max, d3_max, r0_no, r1_no, r2_no, r3_no,
          branch, office, sales_person,
          corp_group, industry, customer_name, delivery_name, model_name,
          product_name, gas_type, equip_name, category_name,
          nego_result, final_date, final_price, top_qty)
       VALUES ${part.map(() => `(${'?,'.repeat(40)}?)`).join(',')}
       ON CONFLICT (ent_cd, model_code) DO UPDATE SET
         ${SUM_COLS.map((c) => `${c} = agg_staging.${c} + excluded.${c}`).join(', ')},
         ${PRICE_COLS.map(keepPrice).join(', ')},
         ${[0, 1, 2, 3].map((n) => keepWithDate(`r${n}_no`, `d${n}_max`)).join(', ')},
         ${['d0_max', 'd1_max', 'd2_max', 'd3_max'].map(keepNewer).join(', ')},
         ${keepNewer('final_date')},
         ${['branch', 'office', 'sales_person',
            'corp_group', 'industry', 'customer_name', 'delivery_name', 'model_name',
            'product_name', 'gas_type', 'equip_name', 'category_name',
            'nego_result', 'final_price', 'top_qty']
           .map(keepTop).join(', ')}`,
      part.flat()
    );
  }
  // マスタ単価の実績（月別）。「マスター単価（N月実績）」列の値をそのまま履歴へ入れる。
  // 同じ月へ毎日取り込むと最新の値で上書きされ、「取り込んだ前日まで」の値が残る。
  // 行が分かれているときは数量の一番多い行の値を採る（単価はまとまり内で同じはず）
  const hist = new Map();
  for (const r of rows) {
    const ent = String(r.customer_code ?? '').trim();
    const model = String(r.model_code ?? '').trim();
    if (!ent || !model) continue;
    const qty = num(r.qty);
    for (const [ym, v] of Object.entries(r.hist_prices ?? {})) {
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      const price = num(v);
      if (!(price > 0)) continue;
      const key = `${ent}|${model}|${ym}`;
      const cur = hist.get(key);
      if (!cur || qty > cur.top) hist.set(key, { ent, model, ym, price, top: qty });
    }
  }
  const hvals = [...hist.values()];
  if (hvals.length) {
    const stamp = now();
    // 遠くのDBでは1文あたりの往復が積み上がるため、できるだけ大きくまとめて送る
    for (let i = 0; i < hvals.length; i += 2000) {
      const part = hvals.slice(i, i + 2000);
      await db.run(
        `INSERT INTO master_price_history (ent_cd, model_code, ym, price, source, updated_at)
         VALUES ${part.map(() => "(?,?,?,?,'agg',?)").join(',')}
         ON CONFLICT (ent_cd, model_code, ym) DO UPDATE SET
           price = excluded.price, source = excluded.source, updated_at = excluded.updated_at`,
        part.flatMap((h) => [h.ent, h.model, h.ym, h.price, stamp]));
    }
  }

  res.json({ matched, unmatched, groups: acc.size, histSaved: hvals.length });
}));

api.post('/agg-import/finish', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  // 集約した結果を案件へ重ねる。マスタ登録単価・目標単価はリストの単価そのもの
  // （amt÷wgt は wgt=1 のためファイルの値がそのまま入る）。
  // 価格調査（毎日更新）が案件一覧の土台で、売上高（月次）はここへ突合して重なる。
  const stamp = now();
  // 目標単価は本社が価格調査（毎日更新）のファイルで管理している。
  // 列のあるファイルを取り込んだときは、そのファイルの内容を正とし、
  // ファイルで空欄の品目は空に戻す（前の取込の値が残り続けないようにする）。
  // 列の無いファイルのときは、これまでどおり今の値を残す。
  const { aggMeta: startedMeta } = await loadImportMeta();
  const targetFromFile = startedMeta?.hasTarget === true;
  const targetSql = targetFromFile
    ? 'CASE WHEN s.tgt_wgt > 0 THEN s.tgt_amt / s.tgt_wgt END'
    : `COALESCE(CASE WHEN s.tgt_wgt > 0 THEN s.tgt_amt / s.tgt_wgt END,
                 deals.r2_target_price)`;
  // 商談結果・最終確定日・最終確定単価（値上げ交渉の記録）は営業担当者が
  // アプリで入れる項目なので、毎日の取込では触らない（画面の値がそのまま残る）。
  // 取込のときに「ファイルの値で入れ直す」を選んだ場合だけ、値のある列を上書きする。
  // 商談メモはもともとファイルに無いため、どちらの場合も変わらない。
  const overwriteNego = startedMeta?.overwriteNego === true;
  const negoSql = !overwriteNego ? '' : `
      nego_result = COALESCE(s.nego_result, deals.nego_result),
      final_date = COALESCE(s.final_date, deals.final_date),
      final_price = COALESCE(s.final_price, deals.final_price),`;
  // 当月実績の単価・数量（master_*）は売上高の取込が正なので、ここでは触らない。
  await db.run(`
    UPDATE deals SET
      base_price = CASE WHEN s.base_wgt > 0 THEN s.base_amt / s.base_wgt END,
      qty = s.qty,
      a_price_m0 = CASE WHEN s.a0_wgt > 0 THEN s.a0_amt / s.a0_wgt END,
      a_price_m1 = CASE WHEN s.a1_wgt > 0 THEN s.a1_amt / s.a1_wgt END,
      a_price_m2 = CASE WHEN s.a2_wgt > 0 THEN s.a2_amt / s.a2_wgt END,
      a_price_m3 = CASE WHEN s.a3_wgt > 0 THEN s.a3_amt / s.a3_wgt END,
      a_date_m0 = s.d0_max,
      a_date_m1 = s.d1_max,
      a_date_m2 = s.d2_max,
      a_date_m3 = s.d3_max,
      a_ringi_m0 = s.r0_no,
      a_ringi_m1 = s.r1_no,
      a_ringi_m2 = s.r2_no,
      a_ringi_m3 = s.r3_no,
      cost_price = CASE WHEN s.cost_wgt > 0 THEN s.cost_amt / s.cost_wgt END,
      -- 支店・営業所・担当者は実績側に無いので、マスタ登録から写す
      -- （まとまりの中で数量の一番多い行のもの）
      branch = s.branch,
      office = s.office,
      sales_person = s.sales_person,
      -- 納入先名（主な納入先）。ファイルに無ければ今のまま
      delivery_name = COALESCE(s.delivery_name, deals.delivery_name),
      -- 目標単価（第2弾新値上げ単価）。列のあるファイルならファイルの内容を正とする
      r2_target_price = ${targetSql},
      -- 商談結果・最終確定日・最終確定単価（「ファイルの値で入れ直す」を選んだときだけ）
      ${negoSql}
      -- ベース（価格調査）に載っている印。売上高（月次）の取込で
      -- 「今月の売上高に無い行」を落とすときに、この印のある行は残す
      agg_batch = ?,
      updated_at = ?
    FROM agg_staging s
    WHERE deals.hist_ent_cd = s.ent_cd AND deals.model_code = s.model_code`, [stamp, stamp]);

  // 実績（価格調査）に無い品目も、案件として追加する。
  // 当月の実績（単価・数量・金額）は空のまま。翌月以降の価格調査で
  // 実績が入る可能性があるため、A基準だけでも一覧に載せておく。
  // 次の価格調査の取込で作り直されて消えても、マスタ登録を重ね直せばまた載る
  const ins = await db.run(`
    INSERT INTO deals (agg_key, hist_ent_cd, corp_code, corp_name, customer_code,
      customer_name, delivery_name, industry, model_code, model_name, product_name, gas_type,
      equip_name, category_name, base_price, qty,
      a_price_m0, a_price_m1, a_price_m2, a_price_m3,
      a_date_m0, a_date_m1, a_date_m2, a_date_m3,
      a_ringi_m0, a_ringi_m1, a_ringi_m2, a_ringi_m3,
      r2_target_price, nego_result, final_date, final_price,
      branch, office, sales_person, agg_batch, updated_at)
    SELECT s.ent_cd || '|' || s.model_code, s.ent_cd,
      COALESCE(NULLIF(s.corp_group, ''), s.ent_cd),
      COALESCE(NULLIF(s.corp_group, ''), s.customer_name),
      s.ent_cd, s.customer_name, s.delivery_name, s.industry,
      s.model_code, s.model_name, s.product_name, s.gas_type,
      s.equip_name, s.category_name,
      CASE WHEN s.base_wgt > 0 THEN s.base_amt / s.base_wgt END, s.qty,
      CASE WHEN s.a0_wgt > 0 THEN s.a0_amt / s.a0_wgt END,
      CASE WHEN s.a1_wgt > 0 THEN s.a1_amt / s.a1_wgt END,
      CASE WHEN s.a2_wgt > 0 THEN s.a2_amt / s.a2_wgt END,
      CASE WHEN s.a3_wgt > 0 THEN s.a3_amt / s.a3_wgt END,
      s.d0_max, s.d1_max, s.d2_max, s.d3_max,
      s.r0_no, s.r1_no, s.r2_no, s.r3_no,
      CASE WHEN s.tgt_wgt > 0 THEN s.tgt_amt / s.tgt_wgt END,
      s.nego_result, s.final_date, s.final_price,
      s.branch, s.office, s.sales_person, ?, ?
    FROM agg_staging s
    WHERE NOT EXISTS (
      SELECT 1 FROM deals d
       WHERE d.hist_ent_cd = s.ent_cd AND d.model_code = s.model_code)`, [stamp, stamp]);
  const added = Number(ins?.changes ?? 0);

  // マスタ単価の実績（月別履歴）。当月（本日時点）の単価をその月の枠へ記録する。
  // 毎日取り込むと同じ月が最新の値で上書きされ、「取り込んだ前日まで」の値が残る。
  // ファイルに「マスター単価（N月実績）」の列があるときは、その値を取込時に
  // 記録済みなので、ここでの当月の書き込みは行わない（実績の列の値を正とする）
  const { aggMeta } = await loadImportMeta();
  const histMonths = Array.isArray(aggMeta?.histMonths) ? aggMeta.histMonths : [];
  const m0Raw = /^\d{4}-\d{2}$/.test(String(aggMeta?.m0 ?? '')) ? aggMeta.m0 : null;
  const m0Ym = m0Raw && !histMonths.includes(m0Raw) ? m0Raw : null;
  if (m0Ym) {
    await db.run(`
      INSERT INTO master_price_history (ent_cd, model_code, ym, price, source, updated_at)
      SELECT s.ent_cd, s.model_code, ?, s.a0_amt / s.a0_wgt, 'agg', ?
        FROM agg_staging s
       WHERE s.a0_wgt > 0
      ON CONFLICT (ent_cd, model_code, ym) DO UPDATE SET
        price = excluded.price, source = excluded.source, updated_at = excluded.updated_at`,
      [m0Ym, stamp]);
  }

  // 名簿の氏名を、取り込んだ営業担当者の表記へ揃える（空白の違いを吸収する）
  const renamed = await alignUserNamesToDeals();

  const [{ covered }, { total }, { groups }] = await Promise.all([
    db.get('SELECT COUNT(*) AS covered FROM deals WHERE a_price_m3 IS NOT NULL'),
    db.get('SELECT COUNT(*) AS total FROM deals'),
    db.get('SELECT COUNT(*) AS groups FROM agg_staging'),
  ]);
  await db.run('DELETE FROM agg_staging');
  // ここでは行を消さないため VACUUM は不要（毎日の取込なので、時間のかかる
  // 掃除を毎回走らせない。行が消える売上高の取込側にだけ残す）
  invalidateMetaCache();
  // 値上げ額の合計をこの取込の日付で残す（前回の取込との差を追えるように）
  await recordRaiseHistory('agg', startedMeta?.filename ?? '', startedMeta?.takenOn);
  res.json({ covered: Number(covered), total: Number(total), groups: Number(groups), added, renamed });
}));

// ---- 価格調査（実単価）の取込 ----
//
// マスタ登録と同じ 得意先×納入先×商品 の単位で、月ごとの実際の単価が入っている。
// A基準（値上げの計画）に対して実際いくらで出たのかを並べるために取り込む。
// 案件は 法人×品目 なので、マスタ登録と同じように法人へ集約する。

/** 実単価の月の枠の数。これを超える月数のファイルは受け取らない */
const ACT_SLOTS = 12;
const actCols = (prefix) => Array.from({ length: ACT_SLOTS }, (_, i) => `${prefix}${i + 1}`);

/**
 * 価格調査（実単価）の取込。
 *
 * このファイルの法人コード・法人名で案件（法人×品目）を作り直す。
 * 出荷実績（月別履歴）の法人グループは使わない。
 */
/**
 * 価格調査（当月実績）の取込。案件一覧の土台を作る。
 *
 * 得意先コード×商品コード の単位で、当月の単価（数量で加重平均）・数量、
 * そして過去最新単価（値上げ前）を案件に入れる。
 * A基準（マスタ登録）は、この当月単価に重ねて今後の計画として比べる。
 */
api.post('/survey-import/start', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const filename = String(req.body?.filename ?? '価格調査.xlsx');
  const ym = String(req.body?.ym ?? '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: '当月が分かりません' });
  await db.run('DELETE FROM act_staging');
  await db.run(
    `INSERT INTO settings (key, value) VALUES ('actual_meta', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify({ ym, months: [ym], filename, updatedAt: new Date().toISOString() })]
  );
  // 今回の取込に含まれない案件を最後に落とすための印
  res.json({ ok: true, batch: `act-${Date.now()}` });
}));

api.post('/survey-import/chunk', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '取り込む行がありません' });
  if (rows.length > 4000) return res.status(400).json({ error: '一度に送れるのは4000行までです' });

  const num = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return 0;
    const n = Number(String(v).replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const txt = (v) => (String(v ?? '').trim() || null);
  /** 値が入っているか。0やマイナスも「入っている」として扱う */
  const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';

  // 代表の名前として持つ項目（得意先名・品目名など）
  const REP = ['customer_name', 'corp_group', 'industry', 'delivery_name',
    'model_name', 'product_name', 'spec', 'equip_name', 'category_name'];
  // 業種名だけは表記ゆれ（コードの有無）をそろえてから持つ
  const repText = (r, k) => (k === 'industry' ? normIndustry(r[k]) : txt(r[k]));

  // 得意先×商品ごとに、数量と「単価×数量」を足し込む（加重平均のため）。
  // 数量が0の行は重み1として扱い、全行0のまとまりでも単純平均になるようにする。
  const acc = new Map();
  let matched = 0;
  let unmatched = 0;
  for (const r of rows) {
    const cust = String(r.customer_code ?? '').trim();
    const model = String(r.model_code ?? '').trim();
    if (!cust || !model || isBlankCorp(cust) || isBlankCorp(r.customer_name)) {
      unmatched += 1;
      continue;
    }
    matched += 1;
    const key = `${cust}|${model}`;
    const a = acc.get(key) ?? {
      cust, model, qty: 0, money: 0, amt: 0, wgt: 0, mp_amt: 0, mp_wgt: 0,
      plan_qty: 0, plan_money: 0,
      past_amt: 0, past_wgt: 0, past_date: null,
      list_amt: 0, list_wgt: 0,
      customer_name: null, corp_group: null, industry: null,
      delivery_name: null, model_name: null, product_name: null, spec: null,
      equip_name: null, category_name: null, top: Number.NEGATIVE_INFINITY,
    };
    const qty = num(r.qty);
    const w = qty > 0 ? qty : 1;
    const price = num(r.price);
    const mprice = num(r.master_price);
    const past = num(r.past_price);
    const list = num(r.list_price);
    a.qty += qty;
    // 金額はファイルの値をそのまま足す。単価×数量で戻すと端数がずれて、
    // 全体の合計が実績と合わなくなるため。
    // 返品などで金額がマイナスの行もそのまま足す（0やマイナスを捨てると
    // 合計が実績より大きくなる）。金額の列が無いファイルのときだけ単価×数量で補う
    a.money += filled(r.amount) ? num(r.amount) : price * qty;
    // マスタ分（値決めどおりに出た分）。A基準はここに対して当てる。
    // 種別の分かれていないファイルでは合計と同じ値が来る
    a.plan_qty += filled(r.plan_qty) ? num(r.plan_qty) : qty;
    a.plan_money += filled(r.plan_amount)
      ? num(r.plan_amount)
      : (filled(r.amount) ? num(r.amount) : price * qty);
    if (price > 0) { a.amt += price * w; a.wgt += w; }
    // マスタ単価（値決めの単価）。A基準はこれと比べるので実単価とは別に持つ
    if (mprice > 0) { a.mp_amt += mprice * w; a.mp_wgt += w; }
    if (past > 0) { a.past_amt += past * w; a.past_wgt += w; }
    if (list > 0) { a.list_amt += list * w; a.list_wgt += w; }
    // 過去最新受注日は、まとまりの中で一番新しい日を残す
    const d = txt(r.past_date);
    if (d && (!a.past_date || d > a.past_date)) a.past_date = d;
    // 名前は数量の一番多い行を代表にする。ただし代表の行で空欄の項目は
    // 同じまとまりの他の行から補う。金額はあるのに器種名・商品名・器具区分が
    // 空のままの案件を作らないため（どれかの行に入っていれば必ず載る）
    if (qty > a.top) {
      a.top = qty;
      for (const k of REP) {
        const v = repText(r, k);
        if (v != null) a[k] = v;
      }
    } else {
      for (const k of REP) if (a[k] == null) a[k] = repText(r, k);
    }
    acc.set(key, a);
  }

  const vals = [...acc.values()].map((a) => [
    a.cust, a.model, a.qty, a.money, a.amt, a.wgt, a.mp_amt, a.mp_wgt,
    a.plan_qty, a.plan_money, a.past_amt, a.past_wgt, a.past_date,
    a.list_amt, a.list_wgt, ...REP.map((k) => a[k]), Number.isFinite(a.top) ? a.top : 0,
  ]);
  if (vals.length) {
    const sumCols = ['qty_sum', 'money_sum', 'price_amt', 'price_wgt', 'mp_amt', 'mp_wgt',
      'plan_qty_sum', 'plan_money_sum', 'past_amt', 'past_wgt'];
    const cols = ['ent_cd', 'model_code', ...sumCols, 'past_date',
      'list_amt', 'list_wgt', ...REP, 'top_qty'];
    // 送りが分かれても、数量の一番多い行の内容と、一番新しい受注日が残るようにする。
    // 片方が空欄の項目はもう片方から補う（品目名などを取りこぼさないため）
    const keepTop = (c) =>
      `${c} = CASE WHEN excluded.top_qty > act_staging.top_qty
         THEN COALESCE(excluded.${c}, act_staging.${c})
         ELSE COALESCE(act_staging.${c}, excluded.${c}) END`;
    // 1文あたりのパラメータ上限（SQLiteは32,766個・PostgreSQLは65,535個）に
    // 収まるよう、25列×1,200行ずつに分けて書き込む（残し方は分かれても同じ結果）
    for (let i = 0; i < vals.length; i += 1200) {
      const part = vals.slice(i, i + 1200);
      await db.run(
        `INSERT INTO act_staging (${cols.join(',')})
         VALUES ${part.map(() => `(${cols.map(() => '?').join(',')})`).join(',')}
         ON CONFLICT (ent_cd, model_code) DO UPDATE SET
           ${[...sumCols, 'list_amt', 'list_wgt'].map((c) => `${c} = act_staging.${c} + excluded.${c}`).join(', ')},
           past_date = CASE WHEN act_staging.past_date IS NULL OR excluded.past_date > act_staging.past_date
                            THEN excluded.past_date ELSE act_staging.past_date END,
           ${[...REP, 'top_qty'].map(keepTop).join(', ')}`,
        part.flat()
      );
    }
  }
  res.json({ matched, unmatched, groups: acc.size });
}));

api.post('/survey-import/finish', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const stamp = now();
  const batch = String(req.body?.batch ?? '');

  // 売上高（月次）をベース（価格調査（毎日更新））へ突合して重ねる。
  // ベースにある案件は実績（単価・数量・金額）を上書き、
  // ベースに無い売上高の行も案件として追加する（売上高の合計が必ず合うように）。
  // 突き合わせは 得意先コード×商品コード。
  const ins = ['agg_key', 'hist_ent_cd', 'corp_code', 'corp_name', 'customer_code', 'customer_name',
    'industry', 'delivery_name', 'model_code', 'model_name', 'product_name', 'gas_type',
    'equip_name', 'category_name',
    'list_price', 'master_avg_price', 'master_price', 'master_qty', 'master_amount',
    'plan_qty', 'plan_amount', 'past_price', 'past_date', 'hist_batch', 'updated_at'];
  // 法人は企業グループ名。グループ名がそのまま法人のコードになる
  // （ファイルにグループのコードが無く、名前が法人を一意に指すため）。
  // グループ名の無いファイルでは、これまでどおり得意先が法人になる。
  const corpCode = "COALESCE(NULLIF(s.corp_group, ''), s.ent_cd)";
  const corpName = "COALESCE(NULLIF(s.corp_group, ''), s.customer_name)";
  const sel = `
    SELECT s.ent_cd || '|' || s.model_code, s.ent_cd, ${corpCode}, ${corpName},
           s.ent_cd, s.customer_name, s.industry, s.delivery_name,
           s.model_code, s.model_name, s.product_name, s.spec, s.equip_name, s.category_name,
           CASE WHEN s.list_wgt > 0 THEN s.list_amt / s.list_wgt END,
           CASE WHEN s.qty_sum > 0 THEN s.money_sum / s.qty_sum
                WHEN s.price_wgt > 0 THEN s.price_amt / s.price_wgt END,
           CASE WHEN s.mp_wgt > 0 THEN s.mp_amt / s.mp_wgt END,
           s.qty_sum, s.money_sum,
           s.plan_qty_sum, s.plan_money_sum,
           CASE WHEN s.past_wgt > 0 THEN s.past_amt / s.past_wgt END,
           s.past_date,
           ${batch ? '?' : 'NULL'}, ?
      FROM act_staging s
     WHERE true`;   // SQLiteは INSERT...SELECT の ON CONFLICT を JOIN の ON と読み違えるため、
                    // 区切りとして WHERE を置く（PostgreSQLでも同じ意味になる）
  const upd = ins.filter((c) => c !== 'agg_key').map((c) => `${c} = excluded.${c}`).join(', ');
  await db.run(
    `INSERT INTO deals (${ins.join(',')}) ${sel}
     ON CONFLICT (agg_key) WHERE agg_key IS NOT NULL DO UPDATE SET ${upd}`,
    batch ? [batch, stamp] : [stamp]
  );

  // マスタ単価の実績（月別履歴）。この月のマスタ単価をその月の枠へ記録する
  const { actualMeta } = await loadImportMeta();
  const actYm = /^\d{4}-\d{2}$/.test(String(actualMeta?.ym ?? '')) ? actualMeta.ym : null;
  if (actYm) {
    await db.run(`
      INSERT INTO master_price_history (ent_cd, model_code, ym, price, source, updated_at)
      SELECT s.ent_cd, s.model_code, ?, s.mp_amt / s.mp_wgt, 'survey', ?
        FROM act_staging s
       WHERE s.mp_wgt > 0
      ON CONFLICT (ent_cd, model_code, ym) DO UPDATE SET
        price = excluded.price, source = excluded.source, updated_at = excluded.updated_at`,
      [actYm, stamp]);
  }

  let removed = 0;
  if (batch) {
    // 今回の売上高に無い案件は、実績（単価・数量・金額）を空へ戻す。
    // ベース（価格調査（毎日更新））の行は消さず「当月実績無し」として残す
    await db.run(`
      UPDATE deals SET master_avg_price = NULL, master_price = NULL, master_qty = NULL,
             master_amount = NULL, plan_qty = NULL, plan_amount = NULL,
             past_price = NULL, past_date = NULL, updated_at = ?
       WHERE hist_batch IS DISTINCT FROM ?
         AND (master_qty IS NOT NULL OR master_avg_price IS NOT NULL OR master_amount IS NOT NULL)`,
      [stamp, batch]);

    // 前の月の売上高にだけあった行（ベースに無く、今回の売上高にも無い）は落とす。
    // ベース（価格調査（毎日更新））で入った行は agg_batch の印を持つので、
    // 単価がまだ1つも入っていなくても残す。
    // 「売上高（7月）に無い品目も一覧に載せる」ためで、次の価格調査の取込で
    // 単価が入ることもある。印の無い古い行は、これまでどおり単価の有無で判断する
    const orphan = `hist_batch IS DISTINCT FROM ?
      AND agg_batch IS NULL
      AND qty IS NULL AND base_price IS NULL
      AND a_price_m0 IS NULL AND a_price_m1 IS NULL
      AND a_price_m2 IS NULL AND a_price_m3 IS NULL
      AND r2_target_price IS NULL AND cost_price IS NULL`;
    for (const sql of [
      `DELETE FROM attachments WHERE deal_id IN (SELECT id FROM deals WHERE ${orphan})`,
      `DELETE FROM notifications WHERE deal_id IN (SELECT id FROM deals WHERE ${orphan})`,
    ]) {
      try { await db.run(sql, [batch]); } catch { /* 無ければ何もしない */ }
    }
    const r = await db.run(`DELETE FROM deals WHERE ${orphan}`, [batch]);
    removed = Number(r?.changes ?? 0);
  }

  const [{ covered }, { total }, { groups }] = await Promise.all([
    db.get('SELECT COUNT(*) AS covered FROM deals WHERE master_avg_price IS NOT NULL'),
    db.get('SELECT COUNT(*) AS total FROM deals'),
    db.get('SELECT COUNT(*) AS groups FROM act_staging'),
  ]);
  await db.run('DELETE FROM act_staging');
  try { await db.run('VACUUM deals'); } catch { /* 自動VACUUMに任せる */ }
  invalidateMetaCache();
  // 売上高が入れ替わると実績数（値上げ額のもと）も変わるので、ここでも残す
  await recordRaiseHistory('survey', actualMeta?.filename ?? '');
  res.json({ covered: Number(covered), total: Number(total), groups: Number(groups), removed });
}));

// ---- 出荷実績（月別履歴）の取込 ----
//
// 案件一覧の土台。法人グループ×品目の単位で、期間全体の
// 平均出荷単価と数量合計を集計して案件の行を作る。
// マスタ登録（A基準）は、あとからこの単位へ集約して重ねる。

/** 法人名の照合用の正規化（会社種別・空白・記号を除く） */
function normCorpName(s) {
  return String(s ?? '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/株式会社|有限会社|合同会社|（株）|\(株\)|㈱|（有）|\(有\)|㈲|（合）|\(合\)/g, '')
    .replace(/[\s　・．.,、。_\-ー―－〜~]/g, '')
    .toUpperCase();
}

/**
 * 法人名（またはコード）が実質「空」かどうか。
 *
 * 実績ファイルは集計ソフトの出力で、法人グループの付いていない行は
 * コードも名前も「(空白)」という文字で入ってくる。空文字と同じに扱う。
 */
const BLANK_CORP_RE = /^[（(]?\s*(空白|blank)\s*[)）]?$|^[-－―ー\s　]+$/i;
function isBlankCorp(s) {
  const t = String(s ?? '').trim();
  return !t || BLANK_CORP_RE.test(t);
}

// 出荷実績（月別履歴）の取込は廃止した。
// 案件の土台は価格調査（実単価）の取込が作る（法人コード×品目）。

api.get('/import/fields', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  res.json({
    // 別名も返す。画面側で同じ規則で自動判定できないと、
    // 「出荷数」「売上担当者支店名」のような見出しを取りこぼす
    fields: FIELDS.map((f) => ({
      key: f.key, label: f.label, group: f.group, type: f.type,
      required: Boolean(f.required), aliases: f.aliases,
    })),
    chunkRows: IMPORT_CHUNK_ROWS,
  });
}));

api.post('/import', upload.single('file'), wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'ファイルを選択してください' });
  // 同じファイルを取り込み直すと明細が二重になる。既定では止め、明示指定のときだけ通す
  const force = req.body?.force === 'true' || req.body?.force === true;
  let mapping;
  if (req.body?.mapping) {
    try { mapping = JSON.parse(req.body.mapping); }
    catch { return res.status(400).json({ error: '列の対応を読み取れませんでした' }); }
  }
  try {
    const result = await importWorkbook(
      req.file.buffer, decodeUploadName(req.file.originalname), req.user.id, undefined, { force, mapping }
    );
    res.json(result);
  } catch (e) {
    if (e.isDuplicate) {
      return res.status(409).json({ error: e.message, duplicate: true, batch: e.batch });
    }
    res.status(400).json({ error: e.message });
  }
}));

// ---- 分割取込 ----
// Vercelはリクエスト本文を約4.5MBまでしか受け取れず、数MBの管理表は
// ファイルのまま送れない。ブラウザ側でExcelを読み、行データだけを
// 小分けにして送ることで、ファイルの大きさに関係なく取り込めるようにする。

api.post('/import/session', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const { filename, contentHash, dataHash, mapping, force } = req.body || {};
  if (!mapping || typeof mapping !== 'object') {
    return res.status(400).json({ error: '列の対応が指定されていません' });
  }
  try {
    validateMapping(mapping);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!force) {
    try {
      await assertNotDuplicate(contentHash ? String(contentHash) : null, dataHash ? String(dataHash) : null);
    } catch (e) {
      if (e.isDuplicate) return res.status(409).json({ error: e.message, duplicate: true, batch: e.batch });
      throw e;
    }
  }
  const batchId = await createBatch(
    String(filename || '（名称不明）'), req.user.id, contentHash || null, dataHash || null
  );
  res.status(201).json({ batchId });
}));

api.post('/import/session/:batchId/rows', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const batchId = Number(req.params.batchId);
  const batch = await db.get('SELECT * FROM import_batches WHERE id = ?', [batchId]);
  if (!batch) return res.status(404).json({ error: '取込セッションが見つかりません' });
  // 他人の取込に行を混ぜられないようにする
  if (batch.imported_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'この取込を操作する権限がありません' });
  }
  const { rows, mapping } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: '行データが不正です' });
  if (rows.length > IMPORT_CHUNK_ROWS) {
    return res.status(400).json({ error: `1回に送れるのは${IMPORT_CHUNK_ROWS}行までです` });
  }
  try {
    validateMapping(mapping);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const warnings = new Map();
  const built = [];
  for (const cells of rows) {
    if (!Array.isArray(cells) || isSkippableRow(cells, mapping)) continue;
    built.push(buildRow(cells, mapping, warnings));
  }
  // 売上伝票NOが一致する既存の明細は上書き更新、無い行だけ追加する
  const r = await upsertRows(batchId, built);
  const total = await addBatchCount(batchId, built.length);
  res.json({
    added: r.added, updated: r.updated, unchanged: r.unchanged,
    total, skipped: summarizeWarnings(warnings),
  });
}));

api.post('/import/session/:batchId/finish', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const batchId = Number(req.params.batchId);
  const batch = await db.get('SELECT * FROM import_batches WHERE id = ?', [batchId]);
  if (!batch) return res.status(404).json({ error: '取込セッションが見つかりません' });
  if (batch.imported_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'この取込を操作する権限がありません' });
  }
  // 1行も入らなかった取込は履歴に残さない（0行の履歴だけが残ると原因が分からなくなる）
  if (Number(batch.row_count) === 0) {
    await db.run('DELETE FROM import_batches WHERE id = ?', [batchId]);
    return res.status(400).json({ error: '取り込める行がありませんでした' });
  }
  res.json({ batchId, count: Number(batch.row_count) });
}));

// 中断した取込の後始末
api.delete('/import/session/:batchId', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const batchId = Number(req.params.batchId);
  const batch = await db.get('SELECT * FROM import_batches WHERE id = ?', [batchId]);
  if (!batch) return res.json({ deleted: 0 });
  if (batch.imported_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'この取込を操作する権限がありません' });
  }
  const { changes } = await db.run('DELETE FROM deals WHERE batch_id = ?', [batchId]);
  await db.run('DELETE FROM import_batches WHERE id = ?', [batchId]);
  res.json({ deleted: Number(changes ?? 0) });
}));

api.get('/import/batches', wrap(async (req, res) => {
  res.json(await db.all(`
    SELECT b.*, u.name AS imported_by_name FROM import_batches b
    LEFT JOIN users u ON u.id = b.imported_by
    ORDER BY b.id DESC LIMIT 50`));
}));

// 誤って取り込んだ分の取り消し。申請済みの明細を含む場合は消さない
// （申請・承認の記録が根拠を失うため）
api.delete('/import/batches/:id', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning', 'admin'])) return;
  const id = Number(req.params.id);
  const batch = await db.get('SELECT * FROM import_batches WHERE id = ?', [id]);
  if (!batch) return res.status(404).json({ error: '取込履歴が見つかりません' });

  // 旧ワークフローの申請に紐づく明細は消さない。
  // application_items は廃止済みで新しいDBには無いため、無ければ確認を飛ばす
  // （無いのに問い合わせると取り消し自体が失敗してしまう）。
  let used = null;
  try {
    used = await db.get(
      `SELECT COUNT(*) AS c FROM application_items ai
         JOIN deals d ON d.id = ai.deal_id
        WHERE d.batch_id = ?`,
      [id]
    );
  } catch (e) {
    if (!/does not exist|no such table/i.test(e?.message || '')) throw e;
  }
  if (Number(used?.c || 0) > 0) {
    return res.status(400).json({
      error: `この取込には申請済みの明細が${Number(used.c).toLocaleString()}件含まれているため取り消せません。`
        + '該当の申請を取下げてから実行してください',
    });
  }

  // 交渉履歴は法人単位に移行済みで、新しいDBには deal_id 列が無い。
  // 旧DBに残っている案件単位の履歴だけ、従来どおり一緒に消す。
  try {
    await db.run('DELETE FROM negotiation_logs WHERE deal_id IN (SELECT id FROM deals WHERE batch_id = ?)', [id]);
  } catch (e) {
    if (!/does not exist|no such column|no such table/i.test(e?.message || '')) throw e;
  }
  // 実体（保管庫のファイル）も一緒に片付ける。行を消す前に場所を控えておく。
  const orphanBlobs = await db.all(
    `SELECT blob_url FROM attachments
      WHERE blob_url IS NOT NULL AND deal_id IN (SELECT id FROM deals WHERE batch_id = ?)`, [id]);
  await db.run('DELETE FROM attachments WHERE deal_id IN (SELECT id FROM deals WHERE batch_id = ?)', [id]);
  for (const o of orphanBlobs) await deleteAttachment(o.blob_url);
  const { changes } = await db.run('DELETE FROM deals WHERE batch_id = ?', [id]);
  await db.run('DELETE FROM import_batches WHERE id = ?', [id]);
  res.json({ deleted: Number(changes ?? batch.row_count) });
}));

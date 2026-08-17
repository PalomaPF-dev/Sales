import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import multer from 'multer';
import XLSX from 'xlsx';
import { db, initDb } from './db.js';
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
import { buildWorkbook, buildDashboardWorkbook } from './export.js';
import { ssoConfig, verifyToken, safeNextPath, SsoError } from './sso.js';
import {
  deleteAttachment, fetchAttachment, isPrivateBlobConfigured, putAttachment,
} from './privateBlob.js';
import { comparePref } from './prefOrder.js';
import {
  KUBUNS, findStandardPrice, loadStandardIndex, matchStandardModel,
  parseStandardWorkbook, replaceStandardPrices,
} from './standardPrices.js';

export const api = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// 分割取込で1回に送る行数。JSONにして数百KBに収まる大きさにする
const IMPORT_CHUNK_ROWS = 500;

// Excel書き出しの上限。サーバーレスは応答サイズに制限があるため控えめにする
const EXPORT_MAX_ROWS = process.env.VERCEL ? 6000 : 100000;

const nv = (v) => (v === undefined ? null : v);
const now = () => new Date().toISOString();
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

/** 認証無効時に全員が名乗るユーザー（管理者→営業企画部の順で選ぶ） */
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
  '/login', '/logout', '/me', '/setup/status', '/setup', '/sso', '/admin-recovery',
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
    // 初期設定の対象は管理者・営業企画部のみ（POST側の制限と揃える）
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
    return res.status(400).json({ error: '最初の設定は管理者または営業企画部のユーザーに対して行ってください' });
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

// ---- 社内ポータルからのSSO ----

/**
 * ポータルが発行した受け渡しトークンを受け取り、本アプリのセッションを作る。
 * 仕様は docs/SSO-PROPOSAL.md を参照。
 *
 * 失敗しても理由を画面に細かく出さない（総当たりの手掛かりになるため）。
 * ログイン画面に短い区分だけ渡し、詳細はサーバーのログに残す。
 */
api.get('/sso', wrap(async (req, res) => {
  const config = ssoConfig();
  const next = safeNextPath(req.query?.next);
  const fail = (code, detail) => {
    console.warn(`SSO失敗 (${code}): ${detail}`);
    return res.redirect(302, `/login?sso=${encodeURIComponent(code)}`);
  };

  // 鍵が未設定の間はSSOそのものを開かない
  if (!config.enabled) {
    return fail('disabled', 'PORTAL_SSO_SECRET が未設定です');
  }

  let claims;
  try {
    claims = verifyToken(req.query?.token, config);
  } catch (e) {
    if (e instanceof SsoError) return fail(e.code, e.message);
    throw e;
  }

  // 期限切れの記録を掃除してから、使い回しでないことを確かめる
  await db.run('DELETE FROM sso_used_tokens WHERE expires_at < ?', [now()]).catch(() => {});
  const used = await db.get('SELECT jti FROM sso_used_tokens WHERE jti = ?', [claims.jti]);
  if (used) return fail('replayed', `jti ${claims.jti} は使用済みです`);

  let user = await db.get('SELECT * FROM users WHERE login_id = ?', [claims.loginId]);

  if (!user) {
    if (!config.autoCreate) {
      return fail('unknown_user', `未登録のログインID: ${claims.loginId}`);
    }
    // 自動作成は必ず最小権限から。管理者への変更は本アプリの管理者画面で行う
    // （トークンに役割を持たせると、ポータル側の設定ミスで管理者を作れてしまう）
    const created = await db.run(
      `INSERT INTO users (name, role, branch, office, active, login_id, must_change_password)
       VALUES (?,?,?,?,1,?,0)`,
      [claims.name || claims.loginId, 'sales', claims.branch, claims.office, claims.loginId]);
    user = await db.get('SELECT * FROM users WHERE id = ?', [created.lastInsertRowid]);
    console.warn(`SSO: 未登録のため営業担当者として作成しました（${claims.loginId} / ${user?.name}）`);
  }

  if (!user?.active) return fail('inactive', `無効なユーザー: ${claims.loginId}`);

  await db.run(
    'INSERT INTO sso_used_tokens (jti, user_id, used_at, expires_at) VALUES (?,?,?,?)',
    [claims.jti, user.id, now(), claims.expiresAt]);

  // パスワードでのログインと同じ扱いにする。ロックが残っていても
  // ポータルで本人確認が済んでいるため解除する。
  await db.run(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?
       WHERE id = ?`, [now(), user.id]);

  const { token, expires } = await createSession(user.id);
  setSessionCookie(req, res, token, expires);

  // トークンをURLに残さない（履歴・ブックマーク・Referer に載るため）
  res.redirect(302, next);
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

const ROLES = ['sales', 'branch_manager', 'planning', 'admin', 'developer'];
// 名簿では日本語で書かれることが多いため、役割名の表記ゆれを吸収する
const ROLE_ALIASES = {
  '営業担当者': 'sales', '営業': 'sales', '担当者': 'sales', 'sales': 'sales',
  '支店長': 'branch_manager', 'branch_manager': 'branch_manager',
  '営業企画部': 'planning', '企画': 'planning', 'planning': 'planning',
  '管理者': 'admin', 'admin': 'admin',
  '開発者': 'developer', 'developer': 'developer',
};

function parseRole(v) {
  const s = String(v ?? '').trim();
  return ROLE_ALIASES[s] || (ROLES.includes(s) ? s : null);
}

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
  const rows = await db.all(`
    SELECT u.id, u.name, u.role, u.branch, u.office, u.active, u.login_id, u.last_login_at,
           u.must_change_password, u.locked_until,
           CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
           CASE
             WHEN u.role IN ('admin','developer','planning') THEN (SELECT COUNT(*) FROM deals)
             WHEN u.role = 'branch_manager' THEN
               (SELECT COUNT(*) FROM deals d WHERE d.branch = u.branch)
             ELSE
               (SELECT COUNT(*) FROM deals d WHERE d.branch = u.branch AND d.office = u.office)
           END AS visible_deals
    FROM users u ORDER BY u.id`);
  res.json(rows);
}));

api.post('/admin/users', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, role, branch, office, loginId } = req.body || {};
  if (!name || !role || !loginId) {
    return res.status(400).json({ error: '氏名・役割・ログインIDは必須です' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: '役割の指定が不正です' });
  }
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(loginId)) {
    return res.status(400).json({ error: 'ログインIDは半角英数字・._- の3〜32文字で指定してください' });
  }
  const dup = await db.get('SELECT id FROM users WHERE login_id = ?', [loginId]);
  if (dup) return res.status(409).json({ error: 'そのログインIDは既に使われています' });

  const temp = generateTempPassword();
  const { lastInsertRowid } = await db.run(
    `INSERT INTO users (name, role, branch, office, login_id, password_hash, must_change_password)
     VALUES (?,?,?,?,?,?,1)`,
    [name, role, nv(branch), nv(office), loginId, await hashPassword(temp)]
  );
  // 仮パスワードはこの応答でのみ返す（DBには平文を残さない）
  res.status(201).json({ id: Number(lastInsertRowid), loginId, tempPassword: temp });
}));

api.post('/admin/users/:id/reset-password', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  const temp = generateTempPassword();
  await db.run(
    `UPDATE users SET password_hash = ?, must_change_password = 1,
            failed_attempts = 0, locked_until = NULL WHERE id = ?`,
    [await hashPassword(temp), user.id]
  );
  await destroyUserSessions(user.id); // 既存のログインを打ち切る
  res.json({ id: user.id, loginId: user.login_id, tempPassword: temp });
}));

api.patch('/admin/users/:id', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  const sets = [];
  const params = [];
  for (const [field, col] of [['name', 'name'], ['role', 'role'], ['branch', 'branch'], ['office', 'office']]) {
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
    `SELECT id, name, role, branch, office, active, login_id, last_login_at,
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

  const sso = ssoConfig();
  const hasBasic = Boolean(process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS);

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
        key: 'basic',
        name: 'Basic認証（URLを知っている人からの遮断）',
        ok: hasBasic,
        detail: hasBasic
          ? `有効（利用者名: ${process.env.BASIC_AUTH_USER}）`
          : '未設定。URLを知っていればログイン画面までは開けます',
        hint: 'Vercel → Settings → Environment Variables に BASIC_AUTH_USER と BASIC_AUTH_PASS',
      },
      {
        key: 'blob',
        name: '添付ファイルの保管先（Vercel Blob）',
        ok: isPrivateBlobConfigured(),
        detail: isPrivateBlobConfigured()
          ? `Blobに保存します（登録済み ${num(attach?.total)}件のうち ${num(attach?.on_blob)}件がBlob）`
          : `未設定のためデータベースに保存します（登録済み ${num(attach?.total)}件）`,
        hint: 'Vercel → Storage で Blob ストアを接続（プレフィックス PRIVATE_BLOB）',
      },
      {
        key: 'sso',
        name: '社内ポータルからのSSO',
        ok: sso.enabled,
        detail: sso.enabled
          ? `有効（発行元: ${sso.issuer} / 未登録の人の自動作成: ${sso.autoCreate ? 'する' : 'しない'}）`
          : '未設定。ログインIDとパスワードでの入室のみです',
        hint: 'ポータルと同じ鍵を PORTAL_SSO_SECRET に設定',
      },
    ],
  });
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

    const temp = generateTempPassword();
    await db.run(
      `INSERT INTO users (name, role, branch, office, login_id, password_hash, must_change_password)
       VALUES (?, 'sales', ?, ?, ?, ?, 1)`,
      [name, nv(item?.branch) || null, nv(item?.office) || null, loginId, await hashPassword(temp)]);
    created.push({ name, loginId, tempPassword: temp });
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

// ---- ユーザーの一括登録 ----

// 名簿の列見出し → 内部項目。表記ゆれをある程度吸収する
const USER_HEADER_MAP = {
  'ログインID': 'loginId', 'ログインid': 'loginId', 'loginid': 'loginId', 'ID': 'loginId', 'id': 'loginId',
  '氏名': 'name', '名前': 'name', '担当者名': 'name', 'name': 'name',
  '役割': 'role', '権限': 'role', 'ロール': 'role', 'role': 'role',
  '支店': 'branch', '支店名': 'branch', 'branch': 'branch',
  '営業所': 'office', '営業所名': 'office', 'office': 'office',
  '有効': 'active',
};

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

  // 見出し行を探す（「氏名」または「ログインID」を含む行）
  let hi = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const cells = (grid[i] || []).map((c) => String(c ?? '').trim());
    if (cells.some((c) => c === '氏名' || c === '名前' || /^ログインID$/i.test(c))) { hi = i; break; }
  }
  if (hi < 0) throw new Error('見出し行が見つかりません。「ログインID」「氏名」「役割」を含む行が必要です');

  const headers = (grid[hi] || []).map((h) => String(h ?? '').trim());
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
      errors.push({ line: lineNo, loginId, message: `役割「${String(roleRaw).trim()}」を判別できません（営業担当者/支店長/営業企画部/管理者）` });
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
        'UPDATE users SET name = ?, role = ?, branch = ?, office = ?, active = ? WHERE id = ?',
        [r.name, r.role, r.branch, r.office, r.active ? 1 : 0, existing.id]
      );
      updated.push({ id: existing.id, loginId: r.loginId, name: r.name });
      continue;
    }
    // 仮パスワードはこの応答でのみ返す（DBには平文を残さない）
    const temp = generateTempPassword();
    const { lastInsertRowid } = await db.run(
      `INSERT INTO users (name, role, branch, office, login_id, password_hash, must_change_password, active)
       VALUES (?,?,?,?,?,?,1,?)`,
      [r.name, r.role, r.branch, r.office, r.loginId, await hashPassword(temp), r.active ? 1 : 0]
    );
    created.push({ id: Number(lastInsertRowid), loginId: r.loginId, name: r.name, tempPassword: temp });
  }

  res.json({ created, updated, skipped, errors });
}));

/** 名簿の記入例。これを埋めてそのまま取り込める */
api.get('/admin/users/template', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = [
    ['ログインID', '氏名', '役割', '支店', '営業所', '有効'],
    ['yamada.t', '山田 太郎', '営業担当者', '東京中央', '東京中央営業所', '〇'],
    ['suzuki.i', '鈴木 一郎', '支店長', '東京中央', '', '〇'],
    ['tanaka.j', '田中 次郎', '営業企画部', '本社', '営業企画部', '〇'],
    ['sato.s', '佐藤 三郎', '管理者', '本社', '', '〇'],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 6 }];
  XLSX.utils.book_append_sheet(wb, ws, 'ユーザー');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', contentDisposition('ユーザー一括登録_記入例.xlsx', 'users-template.xlsx'));
  res.send(buf);
}));

// ---- ユーザー / メタ情報 ----
// 社員名簿にあたるため、ログイン前には返さない
api.get('/users', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  res.json(await db.all('SELECT id, name, role, branch, office FROM users WHERE active = 1 ORDER BY id'));
}));

api.get('/meta', wrap(async (req, res) => {
  // 絞り込みの候補も閲覧範囲に合わせる。
  // ここを絞らないと、担当者名や法人名の一覧から他営業所の取引先が分かってしまう。
  const scope = scopeConditions(req.user);
  const and = scope.where.length ? ` AND ${scope.where.join(' AND ')}` : '';
  const sp = scope.params;

  const [priceTypes, equips, persons, customers, branches, offices, corps] = await Promise.all([
    db.all('SELECT * FROM price_types ORDER BY code'),
    db.all(`SELECT equip_name AS name, COUNT(*) AS count FROM deals WHERE equip_name IS NOT NULL${and} GROUP BY equip_name ORDER BY count DESC`, sp),
    db.all(`SELECT sales_person AS name, COUNT(*) AS count FROM deals WHERE sales_person IS NOT NULL${and} GROUP BY sales_person ORDER BY count DESC`, sp),
    db.all(`SELECT customer_code AS code, customer_name AS name, COUNT(*) AS count FROM deals WHERE customer_code IS NOT NULL${and} GROUP BY customer_code, customer_name ORDER BY count DESC LIMIT 500`, sp),
    db.all(`SELECT branch AS name, COUNT(*) AS count FROM deals WHERE branch IS NOT NULL${and} GROUP BY branch ORDER BY count DESC`, sp),
    db.all(`SELECT DISTINCT branch, office AS name, COUNT(*) AS count FROM deals WHERE office IS NOT NULL${and} GROUP BY branch, office ORDER BY count DESC`, sp),
    db.all(`SELECT corp_code AS code, corp_name AS name, COUNT(*) AS count FROM deals WHERE corp_code IS NOT NULL${and} GROUP BY corp_code, corp_name ORDER BY count DESC LIMIT 500`, sp),
  ]);
  // 支店・営業所は都道府県順（北から南）。件数順だと選択肢を探しづらい
  branches.sort((a, b) => comparePref(a.name, b.name));
  offices.sort((a, b) => comparePref(a.name, b.name));

  // マスタ登録（集約表）の取込情報。A基準の月の見出しなどに使う
  const aggMetaRow = await db.get("SELECT value FROM settings WHERE key = 'agg_meta'");
  const histMetaRow = await db.get("SELECT value FROM settings WHERE key = 'hist_meta'");
  // 価格調査（実単価）の取込情報。実績の月の見出しに使う
  const actualMetaRow = await db.get("SELECT value FROM settings WHERE key = 'actual_meta'");

  res.json({
    priceTypes, equips, persons, customers, branches, offices,
    corps,
    aggMeta: aggMetaRow ? JSON.parse(aggMetaRow.value) : null,
    histMeta: histMetaRow ? JSON.parse(histMetaRow.value) : null,
    actualMeta: actualMetaRow ? JSON.parse(actualMetaRow.value) : null,
    // 画面に「いま何が見えているか」を出すための情報
    scope: scopeInfo(req.user),
    exportMaxRows: EXPORT_MAX_ROWS,
    // 弾ごとの進み具合。案件一覧の絞り込みに使う
    states: [
      { code: 'open', name: '未入力' },
      { code: 'agreed', name: '合意済（未完了）' },
      { code: 'done', name: '完了' },
    ],
    corpStatuses: CORP_STATUSES,
  });
}));

// ---- 閲覧範囲（役割ごとに見えるデータを絞る） ----

/**
 * 役割ごとの閲覧範囲を、案件テーブルに対する条件として返す。
 *
 *   営業担当者   … 自分の営業所のみ
 *   支店長       … 自分の支店の全営業所
 *   営業企画部   … 全社
 *   管理者       … 全社
 *
 * 支店・営業所は取り込んだ案件から増えていくため、ここでは値を持たず
 * 利用者に設定された支店・営業所と突き合わせるだけにしている。
 * 支店や営業所が増えても、この関数を直す必要はない。
 *
 * 支店・営業所が未設定の利用者には何も見せない（1=0）。
 * 設定漏れのときに他営業所の単価が見えてしまうより、
 * 見えない状態で気づいてもらうほうが安全なため。
 */
function scopeConditions(user, alias = '') {
  const p = alias ? `${alias}.` : '';
  if (!user) return { where: ['1 = 0'], params: [] };
  if (isAdminRole(user.role) || user.role === 'planning') return { where: [], params: [] };

  if (user.role === 'branch_manager') {
    if (!user.branch) return { where: ['1 = 0'], params: [], missing: '支店' };
    return { where: [`${p}branch = ?`], params: [user.branch] };
  }

  // 営業担当者（既定）
  if (!user.branch || !user.office) {
    return { where: ['1 = 0'], params: [], missing: '支店・営業所' };
  }
  return { where: [`${p}branch = ? AND ${p}office = ?`], params: [user.branch, user.office] };
}

/** 画面に出すための範囲の説明。未設定のときは理由も返す */
function scopeInfo(user) {
  const s = scopeConditions(user);
  if (!user) return { level: 'none', label: '—' };
  if (isAdminRole(user.role) || user.role === 'planning') {
    return { level: 'all', label: '全社' };
  }
  if (s.missing) {
    return {
      level: 'none',
      label: '未設定',
      missing: s.missing,
      note: `${s.missing}が設定されていないため、案件を表示できません。営業企画部にご連絡ください`,
    };
  }
  if (user.role === 'branch_manager') return { level: 'branch', label: `${user.branch}（支店全体）` };
  return { level: 'office', label: `${user.branch} / ${user.office}` };
}

// ---- ダッシュボード（進捗） ----

/**
 * 値上げの進み具合をまとめて返す。
 * 表示できる範囲は案件一覧と同じ（営業担当者は自分の営業所だけ）。
 *
 * 単価だけの管理表なので金額は扱わず、件数と割合で進捗を示す。
 */
/**
 * ダッシュボードの集計をまとめて作る。画面（/dashboard）と
 * Excel出力（/dashboard/export）で同じ数字を使うため、ここに集約している。
 */
async function dashboardData(query, user) {
  // 絞り込みは案件一覧と同じものを受ける。閲覧範囲もここに含まれる。
  const { where, params: p } = dealFilters(query, user);
  const andWhere = (cond) => (where ? `${where} AND ${cond}` : `WHERE ${cond}`);

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
  const months = await histMonths();
  const mMonths = await masterMonths();

  // 実績の基準。マスタ登録の単価を優先し、無い品目は出荷実績で補う（案件一覧と同じ）。
  // マスタ登録の売上数は月平均（÷3）×対象月数（months）で期間ぶんに換算して揃える。
  // こうすると「合計して ÷months で月あたりを出す」これまでの作りのまま正しい値になる。
  const effPrice = `CASE WHEN master_avg_price IS NOT NULL
                         THEN ${f('master_avg_price')} ELSE ${f('hist_avg_price')} END`;
  const effQty = `CASE WHEN master_avg_price IS NOT NULL
                       THEN ${f('master_qty')} / ${mMonths} * ${months} ELSE ${f('hist_qty')} END`;

  const aCol = (n) =>
    `(CASE WHEN a_price_m${n} > 0 THEN ${f(`a_price_m${n}`)} ELSE ${effPrice} END) * (${effQty})`;

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
                         ELSE ${effPrice} END`;

  const ab = `
    COUNT(*) AS deals,
    SUM(${effQty}) AS qty,
    SUM((${effPrice}) * (${effQty})) AS base_amt,
    SUM(${aCol(0)}) AS a0_amt,
    SUM(${aCol(1)}) AS a1_amt,
    SUM(${aCol(2)}) AS a2_amt,
    SUM(${aCol(3)}) AS a3_amt,
    SUM((${bsimUnit}) * (${effQty})) AS bsim_amt,
    SUM(CASE WHEN b_price IS NOT NULL THEN 1 ELSE 0 END) AS b_rows`;
  const abCond = `a_price_m3 IS NOT NULL AND (${effPrice}) IS NOT NULL AND (${effQty}) > 0`;

  // 月別のマスタ登録（A基準）。当月〜3か月後それぞれで、
  // 申請の入った件数（単価>0）と値上げ額の合計（(A基準−実績)×数量）を出す。
  // 承認日などの絞り込み（dealFilters）はここにも効く。
  const monthAgg = [0, 1, 2, 3].map((n) => `
    SUM(CASE WHEN a_price_m${n} > 0 THEN 1 ELSE 0 END) AS cnt_m${n},
    SUM(CASE WHEN a_price_m${n} > 0 AND (${effPrice}) IS NOT NULL
         THEN (${f(`a_price_m${n}`)} - (${effPrice})) * COALESCE(${effQty}, 0) END) AS raise_m${n}`)
    .join(',')
    // 想定B基準（法人ごとの妥結見通し）にした場合の値上げ額。A基準との比較に使う
    + `,
    SUM(CASE WHEN a_price_m3 > 0 AND (${effPrice}) IS NOT NULL
         THEN ((${bsimUnit}) - (${effPrice})) * COALESCE(${effQty}, 0) END) AS raise_bsim,
    SUM(CASE WHEN b_price IS NOT NULL THEN 1 ELSE 0 END) AS b_rows`;

  // 出荷実績のタイルは「純粋に集計した品目件数」。マスタ登録側の絞り込み
  // （承認日・A基準の有無）は掛けない。マスタ登録件数の母数もこれを使う。
  const pureQuery = { ...query };
  delete pureQuery.aDateYm;
  delete pureQuery.aDateOp;
  delete pureQuery.aState;
  const pure = dealFilters(pureQuery, user);

  // 価格調査の実単価（月ごと）。実際いくらで出たのかを、現状額と同じ数量で金額にする。
  // 単価の無い月はその月の実績が無いということなので、金額にも数量にも含めない。
  const actAmt = Array.from({ length: ACT_SLOTS }, (_, i) => `
    SUM(CASE WHEN act_price_${i + 1} > 0 THEN ${f(`act_price_${i + 1}`)} * (${effQty}) END) AS act_amt_${i + 1},
    SUM(CASE WHEN act_price_${i + 1} > 0 THEN (${effPrice}) * (${effQty}) END) AS act_base_${i + 1},
    SUM(CASE WHEN act_price_${i + 1} > 0 THEN 1 ELSE 0 END) AS act_cnt_${i + 1}`).join(',');

  const [histTotals, aMonths, abTotals, abByEquip, abByBranch, abByCorp, aggMetaRow, actMonths, actualMetaRow] = await Promise.all([
    db.get(`SELECT COUNT(*) AS deals, SUM(${f('hist_qty')}) AS qty
            FROM deal_calc ${pure.where}`, pure.params),
    // マスタ登録の件数（A基準の入った件数）はすべての絞り込みが効く
    db.get(`SELECT ${monthAgg},
              SUM(CASE WHEN a_price_m3 IS NOT NULL THEN 1 ELSE 0 END) AS covered
            FROM deal_calc ${planJoin} ${where}`, p),
    db.get(`SELECT ${ab} FROM deal_calc ${planJoin} ${andWhere(abCond)}`, p),
    db.all(`SELECT equip_name AS name, ${ab} FROM deal_calc ${planJoin} ${andWhere(abCond)}
             GROUP BY equip_name ORDER BY SUM((${effPrice}) * (${effQty})) DESC`, p),
    db.all(`SELECT branch AS name, ${ab} FROM deal_calc ${planJoin} ${andWhere(abCond)}
             GROUP BY branch`, p),
    db.all(`SELECT corp_name AS name, ${ab} FROM deal_calc ${planJoin} ${andWhere(abCond)}
             GROUP BY corp_name ORDER BY SUM((${effPrice}) * (${effQty})) DESC LIMIT 30`, p),
    db.get("SELECT value FROM settings WHERE key = 'agg_meta'"),
    // 実単価は絞り込みだけを受ける（A基準の有無や承認日は掛けない。
    // 実績はA基準の申請とは別に、出た分がそのまま記録されるため）
    db.get(`SELECT ${actAmt} FROM deal_calc ${pure.where}`, pure.params),
    db.get("SELECT value FROM settings WHERE key = 'actual_meta'"),
  ]);
  // 支店は都道府県順（選択肢と同じ並び）
  abByBranch.sort((a, b) => comparePref(a.name, b.name));

  let aggMeta = null;
  try { aggMeta = aggMetaRow ? JSON.parse(aggMetaRow.value) : null; } catch { /* 壊れていたら無し */ }
  let actualMeta = null;
  try { actualMeta = actualMetaRow ? JSON.parse(actualMetaRow.value) : null; } catch { /* 壊れていたら無し */ }
  // 月の並び（actual_meta）と、月ごとの実績額を突き合わせて返す。
  // 現状額（base）は、その月に実績のある案件だけを同じ数量で足したもの。
  // 実績のある案件だけで比べないと、値上げ額が実態より大きく（小さく）出てしまう。
  const actuals = (actualMeta?.months ?? []).map((ym, i) => ({
    ym,
    amount: Number(actMonths?.[`act_amt_${i + 1}`] ?? 0),
    base: Number(actMonths?.[`act_base_${i + 1}`] ?? 0),
    deals: Number(actMonths?.[`act_cnt_${i + 1}`] ?? 0),
  })).filter((a) => a.deals > 0);
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
  };
}

api.get('/dashboard', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  res.json(await dashboardData(req.query, req.user));
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
    ['equip', '器具区分'], ['person', '担当者'],
  ]) {
    if (q[key]) items.push([label, String(q[key])]);
  }
  if (q.aDateYm) {
    items.push(['承認日', `${q.aDateYm} ${q.aDateOp === 'before' ? 'より前' : '以降'}`]);
  }
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
 * 実績原価は管理者・開発者のときだけ返す（粗利の試算用）。
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
  const isAdm = isAdminRole(req.user.role);
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

/** 実績原価は管理者・開発者だけに返す（社外秘に準ずる扱い） */
function hideCost(rows, user) {
  if (!isAdminRole(user.role)) for (const r of rows) delete r.cost_price;
  return rows;
}

/**
 * 並び替えできる列。
 * 列名はSQLに直接入るため、必ずこの表にあるものだけを使う（受け取った文字列は使わない）。
 */
const SORTABLE = new Map([
  ['corp_name', 'corp_name'],
  ['customer_name', 'customer_name'],
  ['model_name', 'model_name'],
  ['equip_name', 'equip_name'],
  ['branch', 'branch'],
  ['office', 'office'],
  ['sales_person', 'sales_person'],
  ['base_price', 'base_price'],
  ['qty', 'qty'],
  ['hist_avg_price', 'hist_avg_price'],
  ['hist_qty', 'hist_qty'],
  ['a_price_m0', 'a_price_m0'],
  ['a_price_m1', 'a_price_m1'],
  ['a_price_m2', 'a_price_m2'],
  ['a_price_m3', 'a_price_m3'],
  ['b_price', 'b_price'],
  ['r2_target_price', 'r2_target_price'],
  ['r2_agreed_price', 'r2_agreed_price'],
  ['r2_raise_unit', 'r2_raise_unit'],
  ['r2_applied_ym', 'r2_applied_ym'],
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
    if (col === 'hist_qty') col = `(${effMonthlyQty(mon.mm, mon.hm)})`;
  }
  const dir = String(q.dir ?? '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return `CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END, ${col} ${dir}, id`;
}

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
  if (q.q) {
    where.push('(customer_name LIKE ? OR corp_name LIKE ? OR model_name LIKE ? OR delivery_name LIKE ?)');
    const like = `%${q.q}%`;
    params.push(like, like, like, like);
  }
  for (const [key, col] of [
    ['equip', 'equip_name'], ['person', 'sales_person'],
    ['customer', 'customer_code'], ['corp', 'corp_code'], ['priceType', 'price_type_code'],
    ['branch', 'branch'], ['office', 'office'],
  ]) {
    if (q[key]) { where.push(`${col} = ?`); params.push(q[key]); }
  }
  // 交渉の進み具合（未入力 / 合意済 / 完了）。ビューの r2_state と同じ条件で絞る
  for (const [key, col] of [['r2State', 'r2_state']]) {
    if (['open', 'agreed', 'done'].includes(q[key])) { where.push(`${col} = ?`); params.push(q[key]); }
  }
  // A基準の有無。マスタ登録は値上げ対象の一部のため、無い行も多い
  if (q.aState === 'has') where.push('a_price_m3 IS NOT NULL');
  else if (q.aState === 'none') where.push('a_price_m3 IS NULL');

  // 承認日での絞り込み。「2026-08以降だけ見る（それより前は値上げ前の単価）」
  // といった使い方をする。承認日の無い行は、どちらの向きでも対象外になる。
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(q.aDateYm ?? ''))) {
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
 * 取込時に数えた月数を settings に入れてあり、無ければ期間の文字から数える。
 */
async function histMonths() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'hist_meta'");
  let meta = null;
  try { meta = row ? JSON.parse(row.value) : null; } catch { /* 壊れていたら既定値 */ }
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
async function masterMonths() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'agg_meta'");
  let meta = null;
  try { meta = row ? JSON.parse(row.value) : null; } catch { /* 壊れていたら既定値 */ }
  const m = /(\d{1,2})\s*[~〜～-]\s*(\d{1,2})\s*月/.exec(String(meta?.basePeriod ?? ''));
  if (m) {
    const span = Number(m[2]) - Number(m[1]) + 1;
    if (span > 0 && span <= 12) return span;
  }
  return 3;
}

/**
 * 案件一覧の「実績」の基準。マスタ登録の単価を優先し、
 * マスタ登録に無い品目は出荷実績（月別履歴）の値で補う。
 * 出荷実績も1~3月のファイルへ切り替えたため、どちらも同じ期間の実績になる。
 *
 * 数量は期間の合計なので、それぞれの月数で割って月平均にする。
 */
const EFF_PRICE = 'COALESCE(master_avg_price, hist_avg_price)';
const effMonthlyQty = (mm, hm) => `CASE WHEN master_avg_price IS NOT NULL
       THEN COALESCE(CAST(master_qty AS FLOAT), 0) / ${mm}
       ELSE COALESCE(CAST(hist_qty AS FLOAT), 0) / ${hm} END`;

api.get('/deals', wrap(async (req, res) => {
  const { where, params } = dealFilters(req.query, req.user);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Number(req.query.size) || 50);
  const months = await histMonths();
  const mMonths = await masterMonths();
  const [totals, rows] = await Promise.all([
    // 件数と完了件数のほかに、値上げ額（1か月あたり）の合計も月ごとに返す。
    // 値上げ幅（その月のA基準−実績単価）× 月平均の数量。
    // 実績はマスタ登録の1~3月出荷実績を優先し、無い行は月別履歴（表示と同じ基準）。
    db.get(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN r2_done = 1 THEN 1 ELSE 0 END) AS r2_done,
             ${[1, 2, 3].map((n) => `
             SUM(CASE WHEN a_price_m${n} > 0 AND ${EFF_PRICE} IS NOT NULL
                       THEN (CAST(a_price_m${n} AS FLOAT) - ${EFF_PRICE})
                            * (${effMonthlyQty(mMonths, months)})
                  END) AS raise_m${n}`).join(',')}
      FROM deal_calc ${where}`, params),
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
  res.json({ rows, totals, page, size, months, masterMonths: mMonths });
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
    { key: 'model', label: '器種名', filter: 'q', items: models },
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
  const months = await histMonths();
  const mMonths = await masterMonths();
  const [rows, priceTypes, aggMetaRow, actualMetaRow] = await Promise.all([
    db.all(`
      SELECT deal_calc.*,
        (SELECT c.status FROM corp_negotiations c WHERE c.corp_code = deal_calc.corp_code) AS corp_status
      FROM deal_calc ${where}
      ORDER BY ${dealOrder(req.query, { hm: months, mm: mMonths })}`, params),
    db.all('SELECT * FROM price_types ORDER BY code'),
    db.get("SELECT value FROM settings WHERE key = 'agg_meta'"),
    db.get("SELECT value FROM settings WHERE key = 'actual_meta'"),
  ]);
  // 実績原価は管理者・開発者のときだけ列に出す（社外秘に準ずる扱い）
  const withCost = isAdminRole(req.user.role);
  let aggMeta = null;
  try { aggMeta = aggMetaRow ? JSON.parse(aggMetaRow.value) : null; } catch { /* 壊れていたら仮の見出し */ }
  let actualMeta = null;
  try { actualMeta = actualMetaRow ? JSON.parse(actualMetaRow.value) : null; } catch { /* 壊れていたら実単価なし */ }
  const buffer = buildWorkbook(rows, priceTypes,
    { months, masterMonths: mMonths, withCost, aggMeta, actualMeta });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', contentDisposition(`値上げ管理表_${stamp}.xlsx`, `price-list_${stamp}.xlsx`));
  res.send(buffer);
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
  res.json({ deal, negotiation: negotiation ?? null, logs });
}));

// 営業担当者が案件一覧から直接入れる項目（合意単価・適用年月・完了）。
// 列名の r2_ は旧・第2弾の名残で、いまは唯一の交渉を指す。
const EDITABLE = [
  'r2_agreed_price', 'r2_applied_ym', 'r2_done',
  'price_type_code',
];

// 目標値上げ単価は管理者だけが直せる。
// 誰でも直せると目標そのものが動いてしまい、進捗の意味が無くなるため。
const ADMIN_ONLY_EDITABLE = ['r2_target_price'];

// 取込で入る残りの列（法人名・器種・出荷単価・支店など）。
// 取込のズレ（列の取り違え・誤記）を直すためのもので、開発者だけが変更できる。
// 通常の運用でここが動くと管理表と食い違うため、管理者にも開放しない。
const DEVELOPER_EDITABLE = FIELDS
  .filter((f) => !EDITABLE.includes(f.key) && !ADMIN_ONLY_EDITABLE.includes(f.key))
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
    if (f.endsWith('_agreed_price')) v = toPrice(v);
    else if (f.endsWith('_applied_ym')) v = normalizeYm(v);
    else if (f.endsWith('_done')) v = v ? 1 : 0;
    else v = nv(v);
    sets.push(`${f} = ?`);
    params.push(v);
  }
  for (const f of ADMIN_ONLY_EDITABLE) {
    if (!(f in body)) continue;
    if (!isAdminRole(user.role)) {
      throw new Error('目標値上げ単価を変更できるのは管理者のみです');
    }
    sets.push(`${f} = ?`);
    params.push(toPrice(body[f]));
  }
  // B基準（実際の決定単価）。同課（営業企画）と管理者が入れる
  if ('b_price' in body) {
    if (!['planning', 'admin', 'developer'].includes(user.role)) {
      throw new Error('決定単価（B基準）を入力できるのは営業企画・管理者のみです');
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
  // これは営業担当者の操作（どの区分の得意先かは担当者が判断する）。
  const extraSets = [];
  const extraParams = [];
  const body = { ...req.body };
  if ('kubun' in body) {
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
      return res.status(e.message.includes('管理者のみ') ? 403 : 400).json({ error: e.message });
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
 * 自分の営業所が取引していない法人は、交渉情報も履歴も見せない。
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
    return res.status(403).json({ error: '記入者本人または営業企画部のみ削除できます' });
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

  // 実体は Private Blob へ。トークン未設定のローカル開発では従来どおり base64 で DB に入れる。
  const filename = decodeUploadName(req.file.originalname);
  let blobUrl = null;
  if (isPrivateBlobConfigured()) {
    try {
      blobUrl = await putAttachment({
        dealId, filename, mimeType: req.file.mimetype, body: req.file.buffer,
      });
    } catch (e) {
      console.error('[attachments] Blobへの保存に失敗:', e?.message || e);
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
  // blob_url があれば Blob から取得して中継する。URL自体はブラウザへ返さない。
  // 無い場合は Blob 移行前の既存行なので、従来どおり DB の base64 を返す。
  let body = null;
  if (a.blob_url) {
    try {
      body = await fetchAttachment(a.blob_url);
    } catch (e) {
      console.error('[attachments] Blobから取得できませんでした:', e?.message || e);
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
    return res.status(403).json({ error: 'アップロードした本人または営業企画部のみ削除できます' });
  }
  await db.run('DELETE FROM attachments WHERE id = ?', [a.id]);
  // DB から消えた後に実体も消す。失敗しても業務は止めない（privateBlob 側でログのみ）
  await deleteAttachment(a.blob_url);
  res.json({ ok: true });
}));

// ---- マスタ登録（集約表）の取込 ----
//
// 案件の土台は出荷実績（法人×品目）。マスタ登録は 得意先×納入先×商品 の
// 細かい単位なので、法人×品目へ集約してからA基準として重ねる。
// 単価は数量で加重平均する（Σ単価×数量 ÷ Σ数量）。
// 法人は、出荷実績の取込で作った対応表（corp_map）で名前から引く。

api.post('/agg-import/start', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const filename = String(req.body?.filename ?? 'マスタ登録.xlsx');
  const { c } = await db.get('SELECT COUNT(*) AS c FROM corp_map');
  if (!Number(c)) {
    return res.status(400).json({
      error: '先に「出荷実績（月別履歴）」を取り込んでください。'
        + '案件一覧は出荷実績の法人×品目が土台で、マスタ登録はそこへ重ねます',
    });
  }
  await db.run('DELETE FROM agg_staging');
  const meta = req.body?.meta;
  if (meta && typeof meta === 'object') {
    await db.run(
      `INSERT INTO settings (key, value) VALUES ('agg_meta', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({
        m0: String(meta.m0 ?? ''),
        m1: String(meta.m1 ?? ''), m2: String(meta.m2 ?? ''), m3: String(meta.m3 ?? ''),
        basePeriod: String(meta.basePeriod ?? ''), filename,
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
  if (rows.length > 500) return res.status(400).json({ error: '一度に送れるのは500行までです' });

  const num = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return 0;
    const n = Number(String(v).replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  // 得意先名 → 法人グループコード（完全一致 → 長い名前からの先頭一致）
  const map = await db.all('SELECT name_key, ent_cd FROM corp_map');
  const byNorm = new Map(map.map((m) => [m.name_key, m.ent_cd]));
  const norms = [...byNorm.keys()].sort((a, b) => b.length - a.length);
  const findEnt = (name) => {
    const n = normCorpName(name);
    if (byNorm.has(n)) return byNorm.get(n);
    for (const cn of norms) if (cn.length >= 3 && n.startsWith(cn)) return byNorm.get(cn);
    return null;
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

  // 法人×品目ごとに、数量と「単価×数量」を足し込む（加重平均のため）
  const acc = new Map();
  let matched = 0;
  let unmatched = 0;
  for (const r of rows) {
    const ent = findEnt(r.customer_name);
    if (!ent) { unmatched += 1; continue; }
    matched += 1;
    const key = `${ent}|${String(r.model_code).trim()}`;
    const qty = num(r.qty);
    const a = acc.get(key) ?? {
      ent, model: String(r.model_code).trim(), qty: 0, base: 0,
      a0: 0, a1: 0, a2: 0, a3: 0, cost: 0,
      d0: null, d1: null, d2: null, d3: null,
      r0: null, r1: null, r2: null, r3: null,
      branch: null, office: null, person: null, top: Number.NEGATIVE_INFINITY,
    };
    // 支店・営業所・担当者は、数量の一番多い行（主な納入先）を代表にする
    if (qty > a.top) {
      a.top = qty;
      a.branch = String(r.branch ?? '').trim() || null;
      a.office = String(r.office ?? '').trim() || null;
      a.person = String(r.sales_person ?? '').trim() || null;
    }
    a.qty += qty;
    a.base += num(r.base_price) * qty;
    a.a0 += num(r.a_price_m0) * qty;
    a.a1 += num(r.a_price_m1) * qty;
    a.a2 += num(r.a_price_m2) * qty;
    a.a3 += num(r.a_price_m3) * qty;
    a.cost += num(r.cost_price) * qty;
    takeApproval(a, 'd0', 'r0', ymd(r.a_date_m0), txt2(r.a_ringi_m0));
    takeApproval(a, 'd1', 'r1', ymd(r.a_date_m1), txt2(r.a_ringi_m1));
    takeApproval(a, 'd2', 'r2', ymd(r.a_date_m2), txt2(r.a_ringi_m2));
    takeApproval(a, 'd3', 'r3', ymd(r.a_date_m3), txt2(r.a_ringi_m3));
    acc.set(key, a);
  }

  // 送りが分かれても最新の日が残るように、日付は加算ではなく大きい方を採る
  const keepNewer = (c) =>
    `${c} = CASE WHEN agg_staging.${c} IS NULL OR excluded.${c} > agg_staging.${c}`
    + ` THEN excluded.${c} ELSE agg_staging.${c} END`;
  // 送りが分かれても、数量の一番多い行の支店・営業所・担当者が残るようにする
  const keepTop = (c) =>
    `${c} = CASE WHEN excluded.top_qty > agg_staging.top_qty THEN excluded.${c} ELSE agg_staging.${c} END`;
  // 稟議Noは承認日とセット。承認日が新しい側の値を採る（同じなら入っている方を残す）
  const keepWithDate = (c, d) =>
    `${c} = CASE WHEN agg_staging.${d} IS NULL OR excluded.${d} > agg_staging.${d}
       THEN COALESCE(excluded.${c}, agg_staging.${c}) ELSE agg_staging.${c} END`;
  const vals = [...acc.values()].map((a) =>
    [a.ent, a.model, a.qty, a.base, a.a0, a.a1, a.a2, a.a3, a.cost, a.d0, a.d1, a.d2, a.d3,
      a.r0, a.r1, a.r2, a.r3,
      a.branch, a.office, a.person, Number.isFinite(a.top) ? a.top : 0]);
  if (vals.length) {
    await db.run(
      `INSERT INTO agg_staging
         (ent_cd, model_code, qty, base_amt, a0_amt, a1_amt, a2_amt, a3_amt, cost_amt,
          d0_max, d1_max, d2_max, d3_max, r0_no, r1_no, r2_no, r3_no,
          branch, office, sales_person, top_qty)
       VALUES ${vals.map(() => `(${'?,'.repeat(20)}?)`).join(',')}
       ON CONFLICT (ent_cd, model_code) DO UPDATE SET
         qty = agg_staging.qty + excluded.qty,
         base_amt = agg_staging.base_amt + excluded.base_amt,
         a0_amt = agg_staging.a0_amt + excluded.a0_amt,
         a1_amt = agg_staging.a1_amt + excluded.a1_amt,
         a2_amt = agg_staging.a2_amt + excluded.a2_amt,
         a3_amt = agg_staging.a3_amt + excluded.a3_amt,
         cost_amt = agg_staging.cost_amt + excluded.cost_amt,
         ${[0, 1, 2, 3].map((n) => keepWithDate(`r${n}_no`, `d${n}_max`)).join(', ')},
         ${['d0_max', 'd1_max', 'd2_max', 'd3_max'].map(keepNewer).join(', ')},
         ${['branch', 'office', 'sales_person', 'top_qty'].map(keepTop).join(', ')}`,
      vals.flat()
    );
  }
  res.json({ matched, unmatched, groups: acc.size });
}));

api.post('/agg-import/finish', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  // 集約した結果を案件へ重ねる。単価は数量での加重平均。
  // 実績にある法人×品目だけが対象（案件の土台は実績）。
  const stamp = now();
  await db.run(`
    UPDATE deals SET
      master_qty = s.qty,
      master_avg_price = CASE WHEN s.qty > 0 THEN s.base_amt / s.qty END,
      a_price_m0 = CASE WHEN s.qty > 0 THEN s.a0_amt / s.qty END,
      a_price_m1 = CASE WHEN s.qty > 0 THEN s.a1_amt / s.qty END,
      a_price_m2 = CASE WHEN s.qty > 0 THEN s.a2_amt / s.qty END,
      a_price_m3 = CASE WHEN s.qty > 0 THEN s.a3_amt / s.qty END,
      a_date_m0 = s.d0_max,
      a_date_m1 = s.d1_max,
      a_date_m2 = s.d2_max,
      a_date_m3 = s.d3_max,
      a_ringi_m0 = s.r0_no,
      a_ringi_m1 = s.r1_no,
      a_ringi_m2 = s.r2_no,
      a_ringi_m3 = s.r3_no,
      cost_price = CASE WHEN s.qty > 0 THEN s.cost_amt / s.qty END,
      -- 支店・営業所・担当者は実績側に無いので、マスタ登録から写す
      -- （まとまりの中で数量の一番多い行のもの）
      branch = s.branch,
      office = s.office,
      sales_person = s.sales_person,
      updated_at = ?
    FROM agg_staging s
    WHERE deals.hist_ent_cd = s.ent_cd AND deals.model_code = s.model_code`, [stamp]);

  const [{ covered }, { total }, { groups }] = await Promise.all([
    db.get('SELECT COUNT(*) AS covered FROM deals WHERE a_price_m3 IS NOT NULL'),
    db.get('SELECT COUNT(*) AS total FROM deals'),
    db.get('SELECT COUNT(*) AS groups FROM agg_staging'),
  ]);
  await db.run('DELETE FROM agg_staging');
  try { await db.run('VACUUM deals'); } catch { /* 自動VACUUMに任せる */ }
  res.json({ covered: Number(covered), total: Number(total), groups: Number(groups) });
}));

// ---- 価格調査（実単価）の取込 ----
//
// マスタ登録と同じ 得意先×納入先×商品 の単位で、月ごとの実際の単価が入っている。
// A基準（値上げの計画）に対して実際いくらで出たのかを並べるために取り込む。
// 案件は 法人×品目 なので、マスタ登録と同じように法人へ集約する。

/** 実単価の月の枠の数。これを超える月数のファイルは受け取らない */
const ACT_SLOTS = 12;
const actCols = (prefix) => Array.from({ length: ACT_SLOTS }, (_, i) => `${prefix}${i + 1}`);

api.post('/survey-import/start', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const filename = String(req.body?.filename ?? '価格調査.xlsx');
  const months = Array.isArray(req.body?.months) ? req.body.months.map(String) : [];
  if (!months.length) return res.status(400).json({ error: '月の並びがありません' });
  if (months.length > ACT_SLOTS) {
    return res.status(400).json({ error: `実単価は${ACT_SLOTS}か月分までしか取り込めません` });
  }
  const { c } = await db.get('SELECT COUNT(*) AS c FROM corp_map');
  if (!Number(c)) {
    return res.status(400).json({
      error: '先に「出荷実績（月別履歴）」を取り込んでください。'
        + '案件一覧は出荷実績の法人×品目が土台で、価格調査はそこへ重ねます',
    });
  }
  await db.run('DELETE FROM act_staging');
  // 前回の取込の残りを消す。月の並びが変わったとき、古い月の値が残らないようにする
  await db.run(`UPDATE deals SET ${actCols('act_price_').map((c2) => `${c2} = NULL`).join(', ')}
                 WHERE ${actCols('act_price_').map((c2) => `${c2} IS NOT NULL`).join(' OR ')}`);
  await db.run(
    `INSERT INTO settings (key, value) VALUES ('actual_meta', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify({ months, filename, updatedAt: new Date().toISOString() })]
  );
  res.json({ ok: true });
}));

api.post('/survey-import/chunk', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '取り込む行がありません' });
  if (rows.length > 500) return res.status(400).json({ error: '一度に送れるのは500行までです' });

  // 得意先名 → 法人グループコード（出荷実績の取込で作った対応表）
  const map = await db.all('SELECT name_key, ent_cd FROM corp_map');
  const byNorm = new Map(map.map((m) => [m.name_key, m.ent_cd]));
  const norms = [...byNorm.keys()].sort((a, b) => b.length - a.length);
  const findEnt = (name) => {
    const n = normCorpName(name);
    if (byNorm.has(n)) return byNorm.get(n);
    for (const cn of norms) if (cn.length >= 3 && n.startsWith(cn)) return byNorm.get(cn);
    return null;
  };

  const num = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return 0;
    const n = Number(String(v).replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  // 法人×品目ごとに、月ごとの「Σ 単価×重み」と「Σ 重み」を足し込む。
  // 重みは1~3月の売上数。売上の無い行（0）は重み1として扱い、
  // 数量の多い行にならされつつ、全行が0のまとまりでは単純な平均になるようにする。
  const acc = new Map();
  let matched = 0;
  let unmatched = 0;
  for (const r of rows) {
    const ent = findEnt(r.customer_name);
    if (!ent) { unmatched += 1; continue; }
    matched += 1;
    const key = `${ent}|${String(r.model_code).trim()}`;
    const a = acc.get(key) ?? {
      ent, model: String(r.model_code).trim(),
      amt: Array(ACT_SLOTS).fill(0), wgt: Array(ACT_SLOTS).fill(0),
    };
    const qty = num(r.qty);
    const w = qty > 0 ? qty : 1;
    const prices = Array.isArray(r.prices) ? r.prices : [];
    for (let i = 0; i < Math.min(prices.length, ACT_SLOTS); i++) {
      const p = num(prices[i]);
      if (p <= 0) continue;   // 単価の無い月はその月だけ飛ばす
      a.amt[i] += p * w;
      a.wgt[i] += w;
    }
    acc.set(key, a);
  }

  const vals = [...acc.values()].map((a) => [a.ent, a.model, ...a.amt, ...a.wgt]);
  if (vals.length) {
    const cols = ['ent_cd', 'model_code', ...actCols('a').map((c) => `${c}_amt`),
      ...actCols('w').map((c) => `${c}_sum`)];
    await db.run(
      `INSERT INTO act_staging (${cols.join(',')})
       VALUES ${vals.map(() => `(${cols.map(() => '?').join(',')})`).join(',')}
       ON CONFLICT (ent_cd, model_code) DO UPDATE SET
         ${cols.slice(2).map((c) => `${c} = act_staging.${c} + excluded.${c}`).join(', ')}`,
      vals.flat()
    );
  }
  res.json({ matched, unmatched, groups: acc.size });
}));

api.post('/survey-import/finish', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  // 集約した実単価を案件へ重ねる。単価は数量での加重平均
  const stamp = now();
  const sets = Array.from({ length: ACT_SLOTS }, (_, i) =>
    `act_price_${i + 1} = CASE WHEN s.w${i + 1}_sum > 0 THEN s.a${i + 1}_amt / s.w${i + 1}_sum END`);
  await db.run(`
    UPDATE deals SET ${sets.join(', ')}, updated_at = ?
    FROM act_staging s
    WHERE deals.hist_ent_cd = s.ent_cd AND deals.model_code = s.model_code`, [stamp]);

  const anyAct = actCols('act_price_').map((c) => `${c} IS NOT NULL`).join(' OR ');
  const [{ covered }, { total }, { groups }] = await Promise.all([
    db.get(`SELECT COUNT(*) AS covered FROM deals WHERE ${anyAct}`),
    db.get('SELECT COUNT(*) AS total FROM deals'),
    db.get('SELECT COUNT(*) AS groups FROM act_staging'),
  ]);
  await db.run('DELETE FROM act_staging');
  res.json({ covered: Number(covered), total: Number(total), groups: Number(groups) });
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

api.post('/hist-import/start', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const corps = Array.isArray(req.body?.corps) ? req.body.corps : [];
  if (!corps.length) return res.status(400).json({ error: '法人の一覧がありません' });

  // 法人名 → 法人グループコードの対応表を作り直す。
  // マスタ登録を法人×品目へ集約するときに、得意先名からこの表を引く。
  await db.run('DELETE FROM corp_map');
  const stamp = new Date().toISOString();
  // 1行1文だとDBとの往復が法人数だけ発生し、遠隔のDBでは時間切れになる。
  // まとめて1文（複数行VALUES）で入れる。
  const entries = corps
    .filter(([cd, name]) => !isBlankCorp(name) && !isBlankCorp(cd))
    .map(([cd, name]) => [normCorpName(name), String(cd), String(name ?? '')])
    .filter(([k]) => k);
  const seenKey = new Set();
  const uniq = entries.filter(([k]) => (seenKey.has(k) ? false : (seenKey.add(k), true)));
  for (let i = 0; i < uniq.length; i += 300) {
    const part = uniq.slice(i, i + 300);
    await db.run(
      `INSERT INTO corp_map (name_key, ent_cd, corp_name)
       VALUES ${part.map(() => '(?,?,?)').join(',')}
       ON CONFLICT (name_key) DO UPDATE SET ent_cd = excluded.ent_cd, corp_name = excluded.corp_name`,
      part.flat()
    );
  }

  const batch = `hist-${Date.now()}`;
  await db.run(
    `INSERT INTO settings (key, value) VALUES ('hist_meta', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify({ filename: String(req.body?.filename ?? ''),
      period: String(req.body?.period ?? ''),
      // 数量は期間全体の合計。月平均を出すため、対象の月数も控えておく
      months: Number(req.body?.months) > 0 ? Number(req.body.months) : null,
      batch, updatedAt: stamp })]
  );
  res.json({ batch, corps: corps.length });
}));

api.post('/hist-import/chunk', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const batch = String(req.body?.batch ?? '');
  if (!rows.length || !batch) return res.status(400).json({ error: '取り込む行がありません' });
  if (rows.length > 500) return res.status(400).json({ error: '一度に送れるのは500行までです' });

  const num = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(String(v).replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const txt = (v) => {
    const s = String(v ?? '').trim();
    return s && s !== '－' && s !== '-' ? s : null;
  };

  const stamp = now();

  const cols = ['agg_key', 'hist_ent_cd', 'corp_code', 'corp_name', 'customer_name', 'model_code',
    'model_name', 'equip_name', 'hist_avg_price', 'hist_qty', 'base_price', 'qty',
    'hist_batch', 'r2_done', 'updated_at'];
  const seen = new Set();
  const values = [];
  let skipped = 0;
  for (const r of rows) {
    const key = `${String(r.ent_cd).trim()}|${String(r.model_code).trim()}`;
    if (seen.has(key)) continue;
    // 法人名が空・「(空白)」の行は取り込まない（一覧で行き先の分からない行になるため）
    if (!txt(r.corp_name) || isBlankCorp(r.corp_name) || isBlankCorp(r.ent_cd)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    values.push([
      key, String(r.ent_cd).trim(), String(r.ent_cd).trim(), txt(r.corp_name), txt(r.corp_name),
      String(r.model_code).trim(), txt(r.model_name), txt(r.equip_name),
      num(r.avg_price), num(r.qty), num(r.avg_price), num(r.qty),
      batch, 0, stamp,
    ]);
  }
  // まとめて1文で入れ替える（1行1文だと数百回の往復になり、遠隔のDBでは時間切れになる）。
  // 決定単価（B基準）など画面で入れた値は列に触れないので残る。
  const upd = cols.filter((c) => c !== 'agg_key' && c !== 'r2_done')
    .map((c) => `${c} = excluded.${c}`).join(', ');
  if (values.length) {
    await db.run(
      `INSERT INTO deals (${cols.join(',')})
       VALUES ${values.map(() => `(${cols.map(() => '?').join(',')})`).join(',')}
       ON CONFLICT (agg_key) WHERE agg_key IS NOT NULL DO UPDATE SET ${upd}`,
      values.flat()
    );
  }
  res.json({ rows: values.length, skipped });
}));

api.post('/hist-import/finish', wrap(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const batch = String(req.body?.batch ?? '');
  let removed = 0;
  if (batch) {
    // 今回の実績に無い行は落とす（案件一覧は実績にある法人×品目だけにする）
    for (const sql of [
      'DELETE FROM attachments WHERE deal_id IN (SELECT id FROM deals WHERE hist_batch IS DISTINCT FROM ?)',
      'DELETE FROM notifications WHERE deal_id IN (SELECT id FROM deals WHERE hist_batch IS DISTINCT FROM ?)',
    ]) {
      try { await db.run(sql, [batch]); } catch { /* 無ければ何もしない */ }
    }
    const r = await db.run('DELETE FROM deals WHERE hist_batch IS DISTINCT FROM ?', [batch]);
    removed = Number(r?.changes ?? 0);
  }
  // 法人名が空の行は残さない（過去の取込で入り込んだものも含めて掃除する）
  for (const sql of [
    `DELETE FROM attachments WHERE deal_id IN (SELECT id FROM deals WHERE ${BLANK_CORP_WHERE})`,
    `DELETE FROM notifications WHERE deal_id IN (SELECT id FROM deals WHERE ${BLANK_CORP_WHERE})`,
  ]) {
    try { await db.run(sql); } catch { /* 無ければ何もしない */ }
  }
  const blank = await db.run(`DELETE FROM deals WHERE ${BLANK_CORP_WHERE}`);
  removed += Number(blank?.changes ?? 0);
  const { total } = await db.get('SELECT COUNT(*) AS total FROM deals');
  try { await db.run('VACUUM deals'); } catch { /* 自動VACUUMに任せる */ }
  res.json({ removed, total: Number(total) });
}));

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
  // 実体（Blob）も一緒に片付ける。行を消す前に URL を控えておく。
  const orphanBlobs = await db.all(
    `SELECT blob_url FROM attachments
      WHERE blob_url IS NOT NULL AND deal_id IN (SELECT id FROM deals WHERE batch_id = ?)`, [id]);
  await db.run('DELETE FROM attachments WHERE deal_id IN (SELECT id FROM deals WHERE batch_id = ?)', [id]);
  for (const o of orphanBlobs) await deleteAttachment(o.blob_url);
  const { changes } = await db.run('DELETE FROM deals WHERE batch_id = ?', [id]);
  await db.run('DELETE FROM import_batches WHERE id = ?', [id]);
  res.json({ deleted: Number(changes ?? batch.row_count) });
}));

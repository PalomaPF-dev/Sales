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
import { buildWorkbook } from './export.js';
import { ssoConfig, verifyToken, safeNextPath, SsoError } from './sso.js';
import {
  deleteAttachment, fetchAttachment, isPrivateBlobConfigured, putAttachment,
} from './privateBlob.js';
import { comparePref } from './prefOrder.js';

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
  res.json({ findings });
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

  res.json({
    priceTypes, equips, persons, customers, branches, offices,
    corps,
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
api.get('/dashboard', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  // 絞り込みは案件一覧と同じものを受ける。閲覧範囲もここに含まれる。
  // 同じ条件で「一覧を見る」「集計を見る」を行き来できるようにするため、
  // 判定を別に持たず dealFilters を共有する。
  const { where, params: p } = dealFilters(req.query, req.user);
  const andWhere = (cond) => (where ? `${where} AND ${cond}` : `WHERE ${cond}`);

  // 進捗の数え方は一箇所にまとめる。集計軸が増えても同じ定義で揃うようにする。
  // （列名の r2_ は旧・第2弾の名残。いまは唯一の交渉を指す）
  const progress = `
    COUNT(*) AS deals,
    SUM(CASE WHEN r2_done = 1 THEN 1 ELSE 0 END) AS r2_done,
    SUM(CASE WHEN r2_state = 'agreed' THEN 1 ELSE 0 END) AS r2_agreed,
    SUM(CASE WHEN r2_state = 'open' THEN 1 ELSE 0 END) AS r2_open,
    SUM(CASE WHEN r2_state <> 'open' AND r2_agreed_price > 0 AND r2_target_price IS NOT NULL
                  AND r2_agreed_price < r2_target_price THEN 1 ELSE 0 END) AS r2_below`;

  // 値上げ額の合計と目標に対する達成率。
  // 目標額 = 目標単価と現行単価の差、実績額 = 実際に上がった幅（deal_calcと同じ定義）。
  const amounts = `
    COUNT(*) AS deals,
    SUM(CASE WHEN r2_target_price IS NOT NULL AND base_price IS NOT NULL
             THEN r2_target_price - base_price ELSE 0 END) AS r2_target_amount,
    SUM(CASE WHEN r2_state <> 'open' THEN COALESCE(r2_raise_unit, 0) ELSE 0 END) AS r2_agreed_amount`;

  const [totals, byOffice, byPerson, byEquip, corpStatus, applied, byBranchAmount, amountTotals] = await Promise.all([
    db.get(`SELECT ${progress} FROM deal_calc ${where}`, p),
    db.all(`SELECT branch, office, ${progress} FROM deal_calc ${where}
             GROUP BY branch, office ORDER BY COUNT(*) DESC`, p),
    db.all(`SELECT sales_person AS name, branch, office, ${progress} FROM deal_calc ${where}
             GROUP BY sales_person, branch, office ORDER BY COUNT(*) DESC`, p),
    db.all(`SELECT equip_name AS name, ${progress} FROM deal_calc ${where}
             GROUP BY equip_name ORDER BY COUNT(*) DESC`, p),
    // 法人ごとの交渉状況の内訳。未設定は「未着手」として数える
    db.all(`
      SELECT COALESCE((SELECT c.status FROM corp_negotiations c
                        WHERE c.corp_code = deal_calc.corp_code), 'not_started') AS status,
             COUNT(DISTINCT corp_code) AS corps
        FROM deal_calc ${andWhere('corp_code IS NOT NULL')}
       GROUP BY 1`, p),
    // 適用年月ごとの件数（いつから効くのかを見るため）
    db.all(`
      SELECT r2_applied_ym AS ym, COUNT(*) AS r2 FROM deal_calc
       ${andWhere('r2_done = 1 AND r2_applied_ym IS NOT NULL')}
       GROUP BY r2_applied_ym ORDER BY r2_applied_ym`, p),
    db.all(`SELECT branch, ${amounts} FROM deal_calc ${where} GROUP BY branch`, p),
    db.get(`SELECT ${amounts} FROM deal_calc ${where}`, p),
  ]);

  // 支店は都道府県順（選択肢と同じ並び）
  byBranchAmount.sort((a, b) => comparePref(a.branch, b.branch));

  res.json({
    scope: scopeInfo(req.user),
    totals,
    byBranchAmount,
    amountTotals,
    byOffice,
    byPerson,
    byEquip,
    corpStatus,
    applied,
    corpStatuses: CORP_STATUSES,
  });
}));

// ---- 案件（deals） ----

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
  ['r2_target_price', 'r2_target_price'],
  ['r2_agreed_price', 'r2_agreed_price'],
  ['r2_raise_unit', 'r2_raise_unit'],
  ['r2_applied_ym', 'r2_applied_ym'],
  ['r2_state', 'r2_state'],
  ['price_type_code', 'price_type_code'],
]);

const DEFAULT_ORDER = 'corp_name, customer_name, equip_name, model_name, id';

/**
 * 並び順を組み立てる。
 * 未入力の行は末尾に寄せる。SQLiteはNULLを先頭、PostgreSQLは末尾に置くため、
 * 「NULLかどうか」を先に並べて、どちらのDBでも同じ見え方にする。
 */
function dealOrder(q) {
  const col = SORTABLE.get(String(q.sort ?? ''));
  if (!col) return DEFAULT_ORDER;
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

api.get('/deals', wrap(async (req, res) => {
  const { where, params } = dealFilters(req.query, req.user);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Number(req.query.size) || 50);
  const [totals, rows] = await Promise.all([
    // 単価だけの管理表のため件数のみ。完了件数が分かれば運用上は足りる
    db.get(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN r2_done = 1 THEN 1 ELSE 0 END) AS r2_done
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
      ORDER BY ${dealOrder(req.query)}
      LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]),
  ]);
  res.json({ rows, totals, page, size });
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
  const [rows, priceTypes] = await Promise.all([
    db.all(`
      SELECT deal_calc.*,
        (SELECT c.status FROM corp_negotiations c WHERE c.corp_code = deal_calc.corp_code) AS corp_status
      FROM deal_calc ${where}
      ORDER BY ${dealOrder(req.query)}`, params),
    db.all('SELECT * FROM price_types ORDER BY code'),
  ]);
  const buffer = buildWorkbook(rows, priceTypes);
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

  let built;
  try {
    built = buildDealUpdate(req.body, deal, req.user);
  } catch (e) {
    return res.status(e.message.includes('管理者のみ') ? 403 : 400).json({ error: e.message });
  }

  const sets = [...built.sets, 'updated_at = ?'];
  const params = [...built.params, now(), req.params.id];
  await db.run(`UPDATE deals SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json(await db.get('SELECT * FROM deal_calc WHERE id = ?', [req.params.id]));
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

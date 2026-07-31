import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { db, initDb } from './db.js';
import {
  addBatchCount, assertNotDuplicate, buildRow, createBatch, importWorkbook,
  insertRows, isSkippableRow, summarizeWarnings, validateMapping,
} from './importer.js';
import { FIELDS } from './fields.js';
import { hashPassword, verifyPassword, generateTempPassword, validatePassword, isLegacyHash } from './passwords.js';
import {
  COOKIE_NAME, createSession, resolveSession, destroySession, destroyUserSessions,
  readCookie, setSessionCookie, clearSessionCookie,
} from './session.js';
import { approversFor, notify } from './notify.js';
import { buildWorkbook } from './export.js';

export const api = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// 分割取込で1回に送る行数。JSONにして数百KBに収まる大きさにする
const IMPORT_CHUNK_ROWS = 500;

const nv = (v) => (v === undefined ? null : v);
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (v == null ? 0 : Number(v));

// 非同期ハンドラのエラーをExpressのエラーハンドラへ渡す
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
 * 認証の無効化（本番でも有効になる設定）。
 *
 * DISABLE_AUTH=true を設定すると、ログインを求めずに全員が同じユーザーとして操作する。
 * DEV_LOGIN_AS と違い本番でも効くため、明示的に "true" と書いたときだけ有効にする。
 *
 * 注意: 有効にすると、URLを知っている人は誰でも価格データを閲覧・変更でき、
 * 承認操作も誰の名義か区別できなくなる。画面上部に常時警告を表示する。
 */
const AUTH_DISABLED = String(process.env.DISABLE_AUTH ?? '').toLowerCase() === 'true';
if (AUTH_DISABLED) {
  console.warn(
    '\n*** 警告: DISABLE_AUTH=true のため認証が無効です。***\n' +
    '*** URLを知っている全員が価格データを閲覧・変更でき、承認者も記録されません。***\n' +
    '*** 社外から到達できる環境では設定を解除してください。***\n'
  );
}

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
const PUBLIC_PATHS = new Set(['/login', '/logout', '/me', '/setup/status', '/setup']);

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

function requireRole(req, res, roles) {
  if (!requireLogin(req, res)) return false;
  if (!roles.includes(req.user.role) && req.user.role !== 'admin') {
    res.status(403).json({ error: 'この操作の権限がありません' });
    return false;
  }
  return true;
}

/** 管理者だけが触れる操作（ユーザー管理・決裁者設定） */
function requireAdmin(req, res) {
  if (!requireLogin(req, res)) return false;
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'この操作は管理者のみ実行できます' });
    return false;
  }
  return true;
}

/** 決裁できる支店の一覧。空配列なら所属支店のみ */
export function approvableBranches(user) {
  return String(user?.approve_branches || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 支店長決裁ができるか。
 * 役割ではなく決裁権限で判定する（副支店長などにも付与できるようにするため）。
 * 対象支店の指定は、明示的に許可された支店か、無指定なら自分の所属支店。
 */
export function canApproveBranch(user, branch) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!Number(user.can_approve_branch)) return false;
  const allowed = approvableBranches(user);
  return allowed.length ? allowed.includes(branch) : user.branch === branch;
}

/** 営業企画部決裁ができるか */
export function canApprovePlanning(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Boolean(Number(user.can_approve_planning));
}

// ---- ログイン / ログアウト ----

// 連続失敗時のロック設定
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const publicUser = (u) => ({
  id: u.id, name: u.name, role: u.role, branch: u.branch, office: u.office,
  loginId: u.login_id, mustChangePassword: Boolean(u.must_change_password),
  // 決裁権限。承認ボタンや承認箱の出し分けに使う（判定はサーバー側でも行う）
  canApproveBranch: Boolean(Number(u.can_approve_branch)),
  canApprovePlanning: Boolean(Number(u.can_approve_planning)),
  approveBranches: approvableBranches(u),
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
    const until = new Date(user.locked_until);
    return res.status(423).json({
      error: `ログインの試行回数が上限を超えました。${until.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}以降に再度お試しください`,
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

const ROLES = ['sales', 'branch_manager', 'planning', 'admin'];
// 名簿では日本語で書かれることが多いため、役割名の表記ゆれを吸収する
const ROLE_ALIASES = {
  '営業担当者': 'sales', '営業': 'sales', '担当者': 'sales', 'sales': 'sales',
  '支店長': 'branch_manager', 'branch_manager': 'branch_manager',
  '営業企画部': 'planning', '企画': 'planning', 'planning': 'planning',
  '管理者': 'admin', 'admin': 'admin',
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

/** 決裁できる支店の指定を正規化する（全角カンマ・読点・空白区切りも受ける） */
function normalizeBranchList(v) {
  if (Array.isArray(v)) v = v.join(',');
  const list = String(v ?? '')
    .split(/[,、，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? [...new Set(list)].join(',') : null;
}

api.get('/admin/users', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = await db.all(`
    SELECT id, name, role, branch, office, active, login_id, last_login_at,
           must_change_password, locked_until,
           can_approve_branch, can_approve_planning, approve_branches,
           CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS has_password
    FROM users ORDER BY id`);
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
  // 決裁権限
  for (const [field, col] of [
    ['canApproveBranch', 'can_approve_branch'],
    ['canApprovePlanning', 'can_approve_planning'],
  ]) {
    if (field in (req.body || {})) { sets.push(`${col} = ?`); params.push(req.body[field] ? 1 : 0); }
  }
  if ('approveBranches' in (req.body || {})) {
    sets.push('approve_branches = ?');
    params.push(normalizeBranchList(req.body.approveBranches));
  }
  if (!sets.length) return res.status(400).json({ error: '更新項目がありません' });
  params.push(user.id);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  if (req.body?.active === false) await destroyUserSessions(user.id);
  res.json(await db.get(
    `SELECT id, name, role, branch, office, active, login_id, last_login_at,
            can_approve_branch, can_approve_planning, approve_branches,
            CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS has_password
     FROM users WHERE id = ?`, [user.id]));
}));

// ---- ユーザーの一括登録 ----

// 名簿の列見出し → 内部項目。表記ゆれをある程度吸収する
const USER_HEADER_MAP = {
  'ログインID': 'loginId', 'ログインid': 'loginId', 'loginid': 'loginId', 'ID': 'loginId', 'id': 'loginId',
  '氏名': 'name', '名前': 'name', '担当者名': 'name', 'name': 'name',
  '役割': 'role', '権限': 'role', 'ロール': 'role', 'role': 'role',
  '支店': 'branch', '支店名': 'branch', 'branch': 'branch',
  '営業所': 'office', '営業所名': 'office', 'office': 'office',
  '支店長決裁': 'canApproveBranch', '支店決裁': 'canApproveBranch',
  '営業企画部決裁': 'canApprovePlanning', '企画決裁': 'canApprovePlanning',
  '決裁できる支店': 'approveBranches', '決裁対象支店': 'approveBranches',
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
    // 決裁権限は列があればその値、無ければ役割から補う
    const canBranch = colIndex.canApproveBranch !== undefined
      ? parseFlag(cell('canApproveBranch')) : role === 'branch_manager';
    const canPlanning = colIndex.canApprovePlanning !== undefined
      ? parseFlag(cell('canApprovePlanning')) : role === 'planning';
    if (canBranch && !branch && !normalizeBranchList(cell('approveBranches'))) {
      errors.push({ line: lineNo, loginId, message: '支店長決裁を与えるには、支店または決裁できる支店の指定が必要です' });
      continue;
    }

    // 「有効」列が無い、または空欄なら有効として扱う
    const activeRaw = colIndex.active === undefined ? '' : String(cell('active') ?? '').trim();
    rows.push({
      line: lineNo,
      loginId,
      name,
      role,
      branch,
      office: nv(cell('office')),
      canApproveBranch: canBranch,
      canApprovePlanning: canPlanning,
      approveBranches: normalizeBranchList(cell('approveBranches')),
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
        `UPDATE users SET name = ?, role = ?, branch = ?, office = ?, active = ?,
                can_approve_branch = ?, can_approve_planning = ?, approve_branches = ?
           WHERE id = ?`,
        [r.name, r.role, r.branch, r.office, r.active ? 1 : 0,
         r.canApproveBranch ? 1 : 0, r.canApprovePlanning ? 1 : 0, r.approveBranches, existing.id]
      );
      updated.push({ id: existing.id, loginId: r.loginId, name: r.name });
      continue;
    }
    // 仮パスワードはこの応答でのみ返す（DBには平文を残さない）
    const temp = generateTempPassword();
    const { lastInsertRowid } = await db.run(
      `INSERT INTO users (name, role, branch, office, login_id, password_hash, must_change_password,
                          active, can_approve_branch, can_approve_planning, approve_branches)
       VALUES (?,?,?,?,?,?,1,?,?,?,?)`,
      [r.name, r.role, r.branch, r.office, r.loginId, await hashPassword(temp),
       r.active ? 1 : 0, r.canApproveBranch ? 1 : 0, r.canApprovePlanning ? 1 : 0, r.approveBranches]
    );
    created.push({ id: Number(lastInsertRowid), loginId: r.loginId, name: r.name, tempPassword: temp });
  }

  res.json({ created, updated, skipped, errors });
}));

/** 名簿の記入例。これを埋めてそのまま取り込める */
api.get('/admin/users/template', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = [
    ['ログインID', '氏名', '役割', '支店', '営業所', '支店長決裁', '営業企画部決裁', '決裁できる支店', '有効'],
    ['yamada.t', '山田 太郎', '営業担当者', '東京中央', '東京中央営業所', '', '', '', '〇'],
    ['suzuki.i', '鈴木 一郎', '支店長', '東京中央', '', '〇', '', '', '〇'],
    ['tanaka.j', '田中 次郎', '営業企画部', '本社', '営業企画部', '', '〇', '', '〇'],
    ['sato.s', '佐藤 三郎', '支店長', '東京中央', '', '〇', '', '東京中央,横浜', '〇'],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 6 }];
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
  const [priceTypes, equips, persons, customers, branches, offices] = await Promise.all([
    db.all('SELECT * FROM price_types ORDER BY code'),
    db.all('SELECT equip_name AS name, COUNT(*) AS count FROM deals WHERE equip_name IS NOT NULL GROUP BY equip_name ORDER BY count DESC'),
    db.all('SELECT sales_person AS name, COUNT(*) AS count FROM deals WHERE sales_person IS NOT NULL GROUP BY sales_person ORDER BY count DESC'),
    db.all('SELECT customer_code AS code, customer_name AS name, COUNT(*) AS count FROM deals WHERE customer_code IS NOT NULL GROUP BY customer_code, customer_name ORDER BY count DESC LIMIT 500'),
    db.all('SELECT branch AS name, COUNT(*) AS count FROM deals WHERE branch IS NOT NULL GROUP BY branch ORDER BY count DESC'),
    db.all('SELECT DISTINCT branch, office AS name, COUNT(*) AS count FROM deals WHERE office IS NOT NULL GROUP BY branch, office ORDER BY count DESC'),
  ]);
  res.json({
    priceTypes, equips, persons, customers, branches, offices,
    exportMaxRows: EXPORT_MAX_ROWS,
    statuses: [
      { code: 'not_started', name: '未着手' },
      { code: 'negotiating', name: '交渉中' },
      { code: 'r1_agreed', name: '第1弾妥結' },
      { code: 'r2_negotiating', name: '第2弾交渉中' },
      { code: 'r2_agreed', name: '第2弾妥結' },
      { code: 'declined', name: '値上げ不可' },
    ],
  });
}));

// ---- 案件（deals） ----
function dealFilters(q) {
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
    ['equip', 'equip_name'], ['status', 'status'], ['person', 'sales_person'],
    ['customer', 'customer_code'], ['priceType', 'price_type_code'],
    ['branch', 'branch'], ['office', 'office'],
  ]) {
    if (q[key]) { where.push(`${col} = ?`); params.push(q[key]); }
  }
  // 第1弾/第2弾の申請対象になりうる明細だけに絞る（一括申請で使う）
  if (q.eligible === '1' || q.eligible === '2') {
    if (q.eligible === '1') {
      where.push('r1_target_price IS NOT NULL AND base_price IS NOT NULL AND r1_target_price > base_price');
      where.push("status IN ('not_started','negotiating')");
    } else {
      where.push('r2_target_price IS NOT NULL AND r2_target_price > COALESCE(r1_agreed_price, base_price)');
      where.push("status IN ('r1_agreed','r2_negotiating')");
    }
    // 進行中・承認済みの申請が既にある明細は除外する
    where.push(`id NOT IN (
      SELECT i.deal_id FROM application_items i JOIN applications a ON a.id = i.application_id
      WHERE a.round = ? AND a.status IN ('draft','pending_branch','pending_planning','approved'))`);
    params.push(Number(q.eligible));
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

api.get('/deals', wrap(async (req, res) => {
  const { where, params } = dealFilters(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Number(req.query.size) || 50);
  const [totals, rows] = await Promise.all([
    db.get(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
             COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
             COALESCE(SUM(r1_target_amount), 0) AS r1_target,
             COALESCE(SUM(r2_target_amount), 0) AS r2_target
      FROM deal_calc ${where}`, params),
    // 交渉の直近状況を一覧で分かるようにするため、最新の交渉履歴を添える。
    // 相関サブクエリにしてあるのは、SQLite/PostgreSQLの双方で同じSQLが通るようにするため
    // （LATERAL join はSQLiteが解釈できない）。
    db.all(`
      SELECT deal_calc.*,
        (SELECT l.contact_date FROM negotiation_logs l WHERE l.deal_id = deal_calc.id
         ORDER BY COALESCE(l.contact_date, l.created_at) DESC, l.id DESC LIMIT 1) AS last_contact_date,
        (SELECT l.result FROM negotiation_logs l WHERE l.deal_id = deal_calc.id
         ORDER BY COALESCE(l.contact_date, l.created_at) DESC, l.id DESC LIMIT 1) AS last_result,
        (SELECT l.note FROM negotiation_logs l WHERE l.deal_id = deal_calc.id
         ORDER BY COALESCE(l.contact_date, l.created_at) DESC, l.id DESC LIMIT 1) AS last_note,
        (SELECT COUNT(*) FROM negotiation_logs l WHERE l.deal_id = deal_calc.id) AS log_count
      FROM deal_calc ${where}
      ORDER BY customer_name, equip_name, model_name, id
      LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]),
  ]);
  res.json({ rows, totals, page, size });
}));

// 集計。絞り込み条件をそのまま引き継ぎ、支店・営業所・器具区分などの単位でまとめる。
const SUMMARY_GROUPS = {
  branch:   { sql: 'branch',                        label: 'branch' },
  office:   { sql: 'branch, office',                label: 'office' },
  equip:    { sql: 'equip_name',                    label: 'equip_name' },
  customer: { sql: 'customer_code, customer_name',  label: 'customer_name' },
  person:   { sql: 'sales_person',                  label: 'sales_person' },
  status:   { sql: 'status',                        label: 'status' },
};

api.get('/deals/summary', wrap(async (req, res) => {
  const g = SUMMARY_GROUPS[req.query.group] || SUMMARY_GROUPS.branch;
  const { where, params } = dealFilters(req.query);
  const select = `
    SELECT COUNT(*) AS deals, COALESCE(SUM(qty),0) AS qty,
           COALESCE(SUM(r1_target_amount),0) AS r1_target,
           COALESCE(SUM(r2_target_amount),0) AS r2_target,
           COALESCE(SUM(r1_target_amount),0) + COALESCE(SUM(r2_target_amount),0) AS total_target,
           COALESCE(SUM(r1_raise_amount),0) AS r1_amount,
           COALESCE(SUM(r2_raise_amount),0) AS r2_amount,
           COALESCE(SUM(r1_raise_amount),0) + COALESCE(SUM(r2_raise_amount),0) AS total_amount,
           -- 交渉の進み具合（明細数）
           SUM(CASE WHEN status = 'not_started' THEN 1 ELSE 0 END) AS cnt_not_started,
           SUM(CASE WHEN status = 'negotiating' THEN 1 ELSE 0 END) AS cnt_negotiating,
           SUM(CASE WHEN status = 'r1_agreed' THEN 1 ELSE 0 END) AS cnt_r1_agreed,
           SUM(CASE WHEN status = 'r2_negotiating' THEN 1 ELSE 0 END) AS cnt_r2_negotiating,
           SUM(CASE WHEN status = 'r2_agreed' THEN 1 ELSE 0 END) AS cnt_r2_agreed,
           SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) AS cnt_declined`;

  const [rows, total] = await Promise.all([
    db.all(`${select}, ${g.sql} FROM deal_calc ${where}
            GROUP BY ${g.sql} ORDER BY total_target DESC, total_amount DESC`, params),
    db.get(`${select} FROM deal_calc ${where}`, params),
  ]);
  res.json({ group: req.query.group || 'branch', labelKey: g.label, rows, total });
}));

// 現行管理表フォーマットでのExcel書き出し。
// Vercelは応答サイズに上限（約4.5MB）があり、実測で約690バイト/行のため
// 安全側に倒して6,000行までとする。自社サーバー運用では制限がゆるい。
const EXPORT_MAX_ROWS = process.env.VERCEL ? 6000 : 100000;

api.get('/deals/export', wrap(async (req, res) => {
  const { where, params } = dealFilters(req.query);
  const { c } = await db.get(`SELECT COUNT(*) AS c FROM deal_calc ${where}`, params);
  if (Number(c) > EXPORT_MAX_ROWS) {
    return res.status(413).json({
      error: `対象が${Number(c).toLocaleString()}件あります。`
        + `一度に書き出せるのは${EXPORT_MAX_ROWS.toLocaleString()}件までです。`
        + '器具区分・担当者・得意先などで絞り込んでから実行してください',
    });
  }
  const [rows, priceTypes] = await Promise.all([
    db.all(`SELECT * FROM deal_calc ${where} ORDER BY customer_name, equip_name, model_name, id`, params),
    db.all('SELECT * FROM price_types ORDER BY code'),
  ]);
  const buffer = buildWorkbook(rows, priceTypes);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', contentDisposition(`値上げ管理表_${stamp}.xlsx`, `price-list_${stamp}.xlsx`));
  res.send(buffer);
}));

api.get('/deals/:id', wrap(async (req, res) => {
  const deal = await db.get('SELECT * FROM deal_calc WHERE id = ?', [req.params.id]);
  if (!deal) return res.status(404).json({ error: '案件が見つかりません' });
  const apps = await db.all(`
    SELECT a.id, a.round, a.status, a.achievement_rate, a.route, a.created_at, i.agreed_price
    FROM application_items i JOIN applications a ON a.id = i.application_id
    WHERE i.deal_id = ? ORDER BY a.id DESC`, [req.params.id]);
  res.json({ deal, applications: apps });
}));

const EDITABLE = ['status', 'negotiation_note', 'negotiated_date', 'price_type_code',
  'offer1_date', 'offer1_rate', 'offer1_price', 'r2_result_symbol'];

api.patch('/deals/:id', wrap(async (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager', 'planning'])) return;
  const sets = [];
  const params = [];
  for (const f of EDITABLE) {
    if (f in req.body) { sets.push(`${f} = ?`); params.push(nv(req.body[f])); }
  }
  if (!sets.length) return res.status(400).json({ error: '更新項目がありません' });
  sets.push('updated_at = ?');
  params.push(now(), req.params.id);
  await db.run(`UPDATE deals SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json(await db.get('SELECT * FROM deal_calc WHERE id = ?', [req.params.id]));
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

// ---- 交渉履歴 ----
api.get('/deals/:id/logs', wrap(async (req, res) => {
  const rows = await db.all(`
    SELECT l.*, u.name AS user_name FROM negotiation_logs l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.deal_id = ? ORDER BY COALESCE(l.contact_date, l.created_at) DESC, l.id DESC`,
    [req.params.id]);
  res.json(rows);
}));

api.post('/deals/:id/logs', wrap(async (req, res) => {
  const deal = await db.get('SELECT id FROM deals WHERE id = ?', [req.params.id]);
  if (!deal) return res.status(404).json({ error: '案件が見つかりません' });
  const note = String(req.body?.note ?? '').trim();
  if (!note) return res.status(400).json({ error: '内容を入力してください' });

  const { lastInsertRowid } = await db.run(
    `INSERT INTO negotiation_logs (deal_id, user_id, contact_date, channel, proposed_price, result, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [deal.id, req.user.id, nv(req.body.contact_date) || null, nv(req.body.channel) || null,
     req.body.proposed_price != null && req.body.proposed_price !== '' ? Number(req.body.proposed_price) : null,
     nv(req.body.result) || null, note, now()]
  );
  res.status(201).json(await db.get(
    `SELECT l.*, u.name AS user_name FROM negotiation_logs l
     LEFT JOIN users u ON u.id = l.user_id WHERE l.id = ?`, [Number(lastInsertRowid)]));
}));

api.delete('/logs/:id', wrap(async (req, res) => {
  const log = await db.get('SELECT * FROM negotiation_logs WHERE id = ?', [req.params.id]);
  if (!log) return res.status(404).json({ error: '履歴が見つかりません' });
  if (log.user_id !== req.user.id && !['planning', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: '記入者本人または営業企画部のみ削除できます' });
  }
  await db.run('DELETE FROM negotiation_logs WHERE id = ?', [log.id]);
  res.json({ ok: true });
}));

// ---- 添付ファイル ----
// 実体をDBに入れるため、1ファイルあたりの上限を設ける
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

api.get('/attachments', wrap(async (req, res) => {
  const { dealId, applicationId } = req.query;
  if (!dealId && !applicationId) return res.status(400).json({ error: '対象を指定してください' });
  const rows = await db.all(`
    SELECT a.id, a.filename, a.mime_type, a.size, a.uploaded_at, u.name AS uploaded_by_name
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE ${dealId ? 'a.deal_id = ?' : 'a.application_id = ?'}
    ORDER BY a.id DESC`, [dealId || applicationId]);
  res.json(rows);
}));

api.post('/attachments', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルを選択してください' });
  const { dealId, applicationId } = req.body;
  if (!dealId && !applicationId) return res.status(400).json({ error: '添付先を指定してください' });
  if (req.file.size > MAX_ATTACHMENT_BYTES) {
    return res.status(413).json({
      error: `ファイルサイズの上限は ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB です`,
    });
  }
  const { lastInsertRowid } = await db.run(
    `INSERT INTO attachments (deal_id, application_id, filename, mime_type, size, content, uploaded_by, uploaded_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [dealId ? Number(dealId) : null, applicationId ? Number(applicationId) : null,
     req.file.originalname, req.file.mimetype, req.file.size,
     req.file.buffer.toString('base64'), req.user.id, now()]
  );
  res.status(201).json({ id: Number(lastInsertRowid), filename: req.file.originalname, size: req.file.size });
}));

api.get('/attachments/:id/download', wrap(async (req, res) => {
  const a = await db.get('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'ファイルが見つかりません' });
  res.set('Content-Type', a.mime_type || 'application/octet-stream');
  res.set('Content-Disposition', contentDisposition(a.filename));
  res.send(Buffer.from(a.content, 'base64'));
}));

api.delete('/attachments/:id', wrap(async (req, res) => {
  const a = await db.get('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'ファイルが見つかりません' });
  if (a.uploaded_by !== req.user.id && !['planning', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'アップロードした本人または営業企画部のみ削除できます' });
  }
  await db.run('DELETE FROM attachments WHERE id = ?', [a.id]);
  res.json({ ok: true });
}));

// ---- 通知 ----
api.get('/notifications', wrap(async (req, res) => {
  const rows = await db.all(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', [req.user.id]);
  const { c } = await db.get(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
  res.json({ rows, unread: Number(c) });
}));

api.post('/notifications/read', wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Number.isFinite) : null;
  if (ids && ids.length) {
    await db.run(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      [now(), req.user.id, ...ids]);
  } else {
    await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
      [now(), req.user.id]);
  }
  res.json({ ok: true });
}));

// ---- 承認ルート判定 ----
async function determineRoute(rate) {
  const rules = await db.all('SELECT * FROM approval_rules WHERE active = 1 ORDER BY priority, id');
  for (const r of rules) {
    if (r.min_rate != null && rate < r.min_rate) continue;
    if (r.max_rate != null && rate >= r.max_rate) continue;
    return { route: r.final_step, ruleName: r.name };
  }
  return { route: 'planning', ruleName: '既定（該当ルールなし→営業企画部決裁）' };
}

async function computeAppTotals(appId) {
  return db.get(`
    SELECT COALESCE(SUM((target_price - base_price) * qty), 0) AS target_amount,
           COALESCE(SUM((agreed_price - base_price) * qty), 0) AS agreed_amount
    FROM application_items WHERE application_id = ?`, [appId]);
}

// ---- 申請（applications） ----
api.post('/applications', wrap(async (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager'])) return;
  const { round, items, price_type_code, title, comment } = req.body;
  if (![1, 2].includes(round)) return res.status(400).json({ error: 'round は 1 または 2 を指定してください' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '対象明細を選択してください' });

  const deals = [];
  for (const it of items) {
    const d = await db.get('SELECT * FROM deals WHERE id = ?', [it.deal_id]);
    deals.push(d ? { deal: d, agreed: Number(it.agreed_price) } : null);
  }
  if (deals.some((x) => !x || !Number.isFinite(x.agreed))) {
    return res.status(400).json({ error: '明細または合意単価が不正です' });
  }
  const customers = new Set(deals.map((x) => x.deal.customer_code));
  if (customers.size > 1) return res.status(400).json({ error: '申請は同一の得意先単位で作成してください' });

  // 同一明細・同一弾の進行中申請の重複を防止
  const dupRow = await db.get(`
    SELECT COUNT(*) AS c FROM application_items i
    JOIN applications a ON a.id = i.application_id
    WHERE a.round = ? AND a.status IN ('draft','pending_branch','pending_planning','approved')
      AND i.deal_id IN (${deals.map(() => '?').join(',')})`,
    [round, ...deals.map((x) => x.deal.id)]);
  if (num(dupRow.c) > 0) return res.status(409).json({ error: '選択明細に進行中または承認済みの申請が既に存在します' });

  const d0 = deals[0].deal;
  const { lastInsertRowid: appId } = await db.run(`
    INSERT INTO applications (round, title, customer_code, customer_name, applicant_id, branch, office, price_type_code, comment, status)
    VALUES (?,?,?,?,?,?,?,?,?,'draft')`,
    [round, nv(title) || `${d0.customer_name} 第${round}弾 値上げ申請`, d0.customer_code, d0.customer_name,
      req.user.id, req.user.branch, req.user.office, nv(price_type_code) ?? d0.price_type_code, nv(comment)]);

  const itemSql = `
    INSERT INTO application_items (application_id, deal_id, base_price, target_price, agreed_price, qty)
    VALUES (?,?,?,?,?,?)`;
  await db.batch(deals.map(({ deal, agreed }) => {
    // 基準単価: 第1弾は❶出荷単価、第2弾は❸値上後単価（未妥結なら出荷単価）
    const base = round === 1 ? deal.base_price : (deal.r1_agreed_price ?? deal.base_price);
    const target = round === 1 ? deal.r1_target_price : deal.r2_target_price;
    return { sql: itemSql, params: [appId, deal.id, nv(base), nv(target), agreed, nv(deal.qty)] };
  }));

  const t = await computeAppTotals(appId);
  const targetAmount = num(t.target_amount);
  const agreedAmount = num(t.agreed_amount);
  const rate = targetAmount > 0 ? Math.round((agreedAmount / targetAmount) * 1000) / 10 : 100;
  await db.run('UPDATE applications SET target_amount = ?, agreed_amount = ?, achievement_rate = ?, updated_at = ? WHERE id = ?',
    [targetAmount, agreedAmount, rate, now(), appId]);
  res.status(201).json(await getApplication(appId));
}));

// 得意先単位の一括申請。対象明細をサーバー側で選ぶため、明細を1件ずつ選ぶ必要がない
api.post('/applications/bulk', wrap(async (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager'])) return;
  const round = Number(req.body?.round);
  const customerCode = String(req.body?.customerCode ?? '');
  if (![1, 2].includes(round)) return res.status(400).json({ error: 'round は 1 または 2 を指定してください' });
  if (!customerCode) return res.status(400).json({ error: '得意先を指定してください' });

  const { where, params } = dealFilters({
    customer: customerCode,
    eligible: String(round),
    equip: req.body?.equip,
    branch: req.body?.branch,
    office: req.body?.office,
  });
  const deals = await db.all(`SELECT * FROM deals ${where}`, params);
  if (!deals.length) {
    return res.status(400).json({ error: '申請できる明細がありません（目標単価が未設定、または既に申請済みです）' });
  }

  const d0 = deals[0];
  const { lastInsertRowid } = await db.run(
    `INSERT INTO applications (round, title, customer_code, customer_name, applicant_id, branch, office, price_type_code, comment, status)
     VALUES (?,?,?,?,?,?,?,?,?,'draft')`,
    [round, nv(req.body?.title) || `${d0.customer_name} 第${round}弾 値上げ申請（一括）`,
     d0.customer_code, d0.customer_name, req.user.id, req.user.branch, req.user.office,
     nv(req.body?.price_type_code) ?? d0.price_type_code, nv(req.body?.comment)]);
  const appId = Number(lastInsertRowid);

  // 既定の合意単価は目標単価。提出前に画面で調整できる
  await db.batch(deals.map((deal) => {
    const base = round === 1 ? deal.base_price : (deal.r1_agreed_price ?? deal.base_price);
    const target = round === 1 ? deal.r1_target_price : deal.r2_target_price;
    return {
      sql: `INSERT INTO application_items (application_id, deal_id, base_price, target_price, agreed_price, qty)
            VALUES (?,?,?,?,?,?)`,
      params: [appId, deal.id, nv(base), nv(target), target, nv(deal.qty)],
    };
  }));

  const t = await computeAppTotals(appId);
  const rate = t.target_amount > 0 ? Math.round((t.agreed_amount / t.target_amount) * 1000) / 10 : 100;
  await db.run(
    'UPDATE applications SET target_amount = ?, agreed_amount = ?, achievement_rate = ?, updated_at = ? WHERE id = ?',
    [t.target_amount, t.agreed_amount, rate, now(), appId]);
  res.status(201).json(await getApplication(appId));
}));

// 一括申請の対象件数を事前に見せる
api.get('/applications/bulk-preview', wrap(async (req, res) => {
  const round = Number(req.query.round);
  if (![1, 2].includes(round)) return res.status(400).json({ error: 'round は 1 または 2 を指定してください' });
  const { where, params } = dealFilters({
    customer: req.query.customer, eligible: String(round),
    equip: req.query.equip, branch: req.query.branch, office: req.query.office,
  });
  const row = await db.get(`
    SELECT COUNT(*) AS count, COALESCE(SUM(qty),0) AS qty,
           COALESCE(SUM(${round === 1
             ? '(r1_target_price - base_price) * qty'
             : '(r2_target_price - COALESCE(r1_agreed_price, base_price)) * qty'}), 0) AS target_amount
    FROM deals ${where}`, params);
  res.json({ count: Number(row.count), qty: Number(row.qty), targetAmount: Number(row.target_amount) });
}));

async function getApplication(id) {
  const app = await db.get(`
    SELECT a.*, u.name AS applicant_name, p.name AS price_type_name, p.category AS price_type_category
    FROM applications a
    LEFT JOIN users u ON u.id = a.applicant_id
    LEFT JOIN price_types p ON p.code = a.price_type_code
    WHERE a.id = ?`, [id]);
  if (!app) return null;
  app.items = await db.all(`
    SELECT i.*, d.customer_name, d.model_name, d.equip_name, d.gas_type, d.sales_ym, d.delivery_name
    FROM application_items i JOIN deals d ON d.id = i.deal_id
    WHERE i.application_id = ? ORDER BY i.id`, [id]);
  app.approvals = await db.all(`
    SELECT ap.*, u.name AS approver_name FROM approvals ap
    LEFT JOIN users u ON u.id = ap.approver_id
    WHERE ap.application_id = ? ORDER BY ap.id`, [id]);
  return app;
}

api.get('/applications', wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('a.status = ?'); params.push(req.query.status); }
  if (req.query.mine === '1' && req.user) { where.push('a.applicant_id = ?'); params.push(req.user.id); }
  if (req.query.inbox === '1' && req.user) {
    // 承認箱: 自分が決裁できるものだけを出す（承認APIの判定と同じ条件にする）
    const clauses = [];
    if (req.user.role === 'admin') {
      clauses.push("a.status IN ('pending_branch','pending_planning')");
    } else {
      if (canApproveBranch(req.user, req.user.branch) || approvableBranches(req.user).length) {
        const branches = approvableBranches(req.user);
        const targets = branches.length ? branches : [req.user.branch];
        const usable = targets.filter(Boolean);
        if (usable.length) {
          clauses.push(`(a.status = 'pending_branch' AND a.branch IN (${usable.map(() => '?').join(',')}))`);
          params.push(...usable);
        }
      }
      if (canApprovePlanning(req.user)) clauses.push("a.status = 'pending_planning'");
    }
    where.push(clauses.length ? `(${clauses.join(' OR ')})` : '1 = 0');
  }
  const rows = await db.all(`
    SELECT a.*, u.name AS applicant_name, p.name AS price_type_name,
           (SELECT COUNT(*) FROM application_items i WHERE i.application_id = a.id) AS item_count
    FROM applications a
    LEFT JOIN users u ON u.id = a.applicant_id
    LEFT JOIN price_types p ON p.code = a.price_type_code
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT 300`, params);
  res.json(rows);
}));

api.get('/applications/:id', wrap(async (req, res) => {
  const app = await getApplication(req.params.id);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  res.json(app);
}));

api.post('/applications/:id/submit', wrap(async (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager'])) return;
  const app = await db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  if (!['draft', 'rejected'].includes(app.status)) return res.status(400).json({ error: 'この申請は提出できません' });
  if (app.applicant_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '申請者本人のみ提出できます' });
  }
  // 提出時点のルールで承認ルートを判定（達成率により承認権限が変わる）
  const { route, ruleName } = await determineRoute(num(app.achievement_rate));
  await db.run("UPDATE applications SET status = 'pending_branch', route = ?, rule_name = ?, updated_at = ? WHERE id = ?",
    [route, ruleName, now(), app.id]);

  await notify(await approversFor('branch', app.branch), {
    kind: 'submitted',
    title: `承認依頼: ${app.title}`,
    body: `${req.user.name} から第${app.round}弾の値上げ申請が提出されました（達成率 ${num(app.achievement_rate).toFixed(1)}%）`,
    link: `/applications/${app.id}`,
  });
  res.json(await getApplication(app.id));
}));

// 承認時に妥結単価を案件へ反映（目標値上げ単価がマスター単価となる）
async function applyToDeals(app) {
  const items = await db.all('SELECT * FROM application_items WHERE application_id = ?', [app.id]);
  const ringi = `APP-${app.id}`;
  const statements = items.map((it) => app.round === 1
    ? {
      sql: `
        UPDATE deals SET r1_agreed_price = ?, r1_ringi_no = ?, r1_raise_date = ?,
          price_type_code = COALESCE(?, price_type_code),
          status = CASE WHEN ? > COALESCE(base_price, 0) THEN 'r1_agreed' ELSE status END,
          updated_at = ?
        WHERE id = ?`,
      params: [it.agreed_price, ringi, today(), nv(app.price_type_code), it.agreed_price, now(), it.deal_id],
    }
    : {
      sql: `
        UPDATE deals SET r2_agreed_price = ?, r2_ringi_no = ?, r2_result_symbol = '〇',
          final_confirm_date = ?, final_raise_date = ?,
          price_type_code = COALESCE(?, price_type_code),
          status = 'r2_agreed', updated_at = ?
        WHERE id = ?`,
      params: [it.agreed_price, ringi, today(), today(), nv(app.price_type_code), now(), it.deal_id],
    });
  if (statements.length) await db.batch(statements);
}

api.post('/applications/:id/approve', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const app = await db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });

  let step;
  if (app.status === 'pending_branch') {
    step = 'branch';
    if (!canApproveBranch(req.user, app.branch)) {
      return res.status(403).json({ error: `${app.branch} の支店長決裁の権限がありません` });
    }
  } else if (app.status === 'pending_planning') {
    step = 'planning';
    if (!canApprovePlanning(req.user)) {
      return res.status(403).json({ error: '営業企画部決裁の権限がありません' });
    }
  } else {
    return res.status(400).json({ error: '承認待ちの申請ではありません' });
  }

  await db.run('INSERT INTO approvals (application_id, step, approver_id, action, comment) VALUES (?,?,?,?,?)',
    [app.id, step, req.user.id, 'approved', nv(req.body?.comment)]);

  if (step === 'branch' && app.route === 'planning') {
    await db.run("UPDATE applications SET status = 'pending_planning', updated_at = ? WHERE id = ?", [now(), app.id]);
    await notify(await approversFor('planning'), {
      kind: 'forwarded',
      title: `承認依頼: ${app.title}`,
      body: `支店長承認が完了しました。営業企画部の承認をお願いします（達成率 ${num(app.achievement_rate).toFixed(1)}%）`,
      link: `/applications/${app.id}`,
    });
    await notify(app.applicant_id, {
      kind: 'approved',
      title: `支店長が承認しました: ${app.title}`,
      body: '営業企画部の承認待ちに進みました',
      link: `/applications/${app.id}`,
    });
  } else {
    await db.run("UPDATE applications SET status = 'approved', decided_at = ?, updated_at = ? WHERE id = ?",
      [now(), now(), app.id]);
    await applyToDeals(app);
    await notify(app.applicant_id, {
      kind: 'approved',
      title: `承認されました: ${app.title}`,
      body: `合意単価が案件へ反映されました（稟議番号 APP-${app.id}）`,
      link: `/applications/${app.id}`,
    });
  }
  res.json(await getApplication(app.id));
}));

api.post('/applications/:id/reject', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const app = await db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  let step;
  if (app.status === 'pending_branch') {
    step = 'branch';
    if (!canApproveBranch(req.user, app.branch)) {
      return res.status(403).json({ error: `${app.branch} の支店長決裁の権限がありません` });
    }
  } else if (app.status === 'pending_planning') {
    step = 'planning';
    if (!canApprovePlanning(req.user)) {
      return res.status(403).json({ error: '営業企画部決裁の権限がありません' });
    }
  } else {
    return res.status(400).json({ error: '承認待ちの申請ではありません' });
  }
  await db.run('INSERT INTO approvals (application_id, step, approver_id, action, comment) VALUES (?,?,?,?,?)',
    [app.id, step, req.user.id, 'rejected', nv(req.body?.comment)]);
  await db.run("UPDATE applications SET status = 'rejected', updated_at = ? WHERE id = ?", [now(), app.id]);
  await notify(app.applicant_id, {
    kind: 'rejected',
    title: `差戻し: ${app.title}`,
    body: [`${req.user.name}（${step === 'branch' ? '支店長' : '営業企画部'}）から差し戻されました`,
           nv(req.body?.comment)].filter(Boolean).join(' / '),
    link: `/applications/${app.id}`,
  });
  res.json(await getApplication(app.id));
}));

api.post('/applications/:id/withdraw', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const app = await db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  if (app.applicant_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '申請者本人のみ取下げできます' });
  }
  if (!['draft', 'pending_branch', 'pending_planning', 'rejected'].includes(app.status)) {
    return res.status(400).json({ error: 'この申請は取下げできません' });
  }
  await db.run("UPDATE applications SET status = 'withdrawn', updated_at = ? WHERE id = ?", [now(), app.id]);
  res.json(await getApplication(app.id));
}));

// ---- 承認ルール（別途設定可能） ----
api.get('/rules', wrap(async (req, res) => {
  res.json(await db.all('SELECT * FROM approval_rules ORDER BY priority, id'));
}));

api.put('/rules', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const rules = req.body;
  if (!Array.isArray(rules)) return res.status(400).json({ error: 'ルールの配列を指定してください' });
  for (const r of rules) {
    if (!['branch', 'planning'].includes(r.final_step)) {
      return res.status(400).json({ error: 'final_step は branch / planning のいずれかです' });
    }
  }
  const sql = 'INSERT INTO approval_rules (name, min_rate, max_rate, final_step, priority, active) VALUES (?,?,?,?,?,?)';
  await db.batch([
    { sql: 'DELETE FROM approval_rules', params: [] },
    ...rules.map((r, i) => ({
      sql,
      params: [nv(r.name) || `ルール${i + 1}`, nv(r.min_rate), nv(r.max_rate), r.final_step, i + 1, r.active === false ? 0 : 1],
    })),
  ]);
  res.json(await db.all('SELECT * FROM approval_rules ORDER BY priority, id'));
}));

// ---- 設定（目標金額など） ----
api.get('/settings', wrap(async (req, res) => {
  const rows = await db.all('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}));

api.put('/settings', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const entries = Object.entries(req.body || {});
  if (entries.length) {
    await db.batch(entries.map(([k, v]) => ({
      sql: 'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      params: [k, String(v)],
    })));
  }
  const rows = await db.all('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}));

// ---- ダッシュボード ----
api.get('/dashboard', wrap(async (req, res) => {
  // 支店・営業所で絞り込める（未指定なら全社）
  const scopeWhere = [];
  const scopeParams = [];
  if (req.query.branch) { scopeWhere.push('branch = ?'); scopeParams.push(req.query.branch); }
  if (req.query.office) { scopeWhere.push('office = ?'); scopeParams.push(req.query.office); }
  const w = scopeWhere.length ? `WHERE ${scopeWhere.join(' AND ')}` : '';
  const andW = scopeWhere.length ? `AND ${scopeWhere.join(' AND ')}` : '';

  const [settingRows, targetRows, totals, byEquip, byPerson, byOffice, statusCounts, appCounts] = await Promise.all([
    db.all('SELECT key, value FROM settings'),
    db.all('SELECT * FROM targets'),
    db.get(`
      SELECT COUNT(*) AS deals,
             COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
             COALESCE(SUM(r2_raise_amount), 0) AS r2_amount
      FROM deal_calc ${w}`, scopeParams),
    db.all(`
      SELECT equip_name, COUNT(*) AS deals,
             COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
             COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
             COALESCE(SUM(r1_raise_amount), 0) + COALESCE(SUM(r2_raise_amount), 0) AS total_amount
      FROM deal_calc WHERE equip_name IS NOT NULL ${andW}
      GROUP BY equip_name ORDER BY total_amount DESC`, scopeParams),
    db.all(`
      SELECT sales_person, COUNT(*) AS deals,
             COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
             COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
             COALESCE(SUM(r1_raise_amount), 0) + COALESCE(SUM(r2_raise_amount), 0) AS total_amount
      FROM deal_calc WHERE sales_person IS NOT NULL ${andW}
      GROUP BY sales_person ORDER BY total_amount DESC`, scopeParams),
    db.all(`
      SELECT branch, office, COUNT(*) AS deals,
             COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
             COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
             COALESCE(SUM(r1_raise_amount), 0) + COALESCE(SUM(r2_raise_amount), 0) AS total_amount
      FROM deal_calc WHERE branch IS NOT NULL ${andW}
      GROUP BY branch, office ORDER BY total_amount DESC`, scopeParams),
    db.all(`SELECT status, COUNT(*) AS count FROM deals ${w} GROUP BY status`, scopeParams),
    db.all('SELECT status, COUNT(*) AS count FROM applications GROUP BY status'),
  ]);

  const settings = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));

  // 目標は絞り込みに合わせて解決する。
  // 営業所指定 → その営業所の目標、支店指定 → 支店の目標、
  // 未指定 → 支店目標の合計（無ければ settings の全社値）
  const pick = (round) => {
    if (req.query.office) {
      const t = targetRows.find((x) => x.scope === 'office' && x.scope_value === req.query.office && x.round === round);
      if (t) return Number(t.amount);
    }
    if (req.query.branch) {
      const t = targetRows.find((x) => x.scope === 'branch' && x.scope_value === req.query.branch && x.round === round);
      if (t) return Number(t.amount);
    }
    if (!req.query.branch && !req.query.office) {
      const branchTotals = targetRows.filter((x) => x.scope === 'branch' && x.round === round);
      if (branchTotals.length) return branchTotals.reduce((s, x) => s + Number(x.amount), 0);
    }
    return Number(settings[`r${round}_target_total`] || 0);
  };

  res.json({
    targets: { r1: pick(1), r2: pick(2) },
    progress: { r1: num(totals.r1_amount), r2: num(totals.r2_amount), deals: num(totals.deals) },
    scope: { branch: req.query.branch || null, office: req.query.office || null },
    byEquip, byPerson, byOffice, statusCounts, appCounts,
  });
}));

// ---- 目標設定（支店 / 営業所 / 担当者別） ----
api.get('/targets', wrap(async (req, res) => {
  res.json(await db.all('SELECT * FROM targets ORDER BY scope, scope_value, round'));
}));

api.put('/targets', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const rows = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: '目標の配列を指定してください' });
  for (const r of rows) {
    if (!['branch', 'office', 'person'].includes(r.scope)) {
      return res.status(400).json({ error: 'scope は branch / office / person のいずれかです' });
    }
    if (![1, 2].includes(Number(r.round))) {
      return res.status(400).json({ error: 'round は 1 または 2 です' });
    }
    if (!String(r.scope_value ?? '').trim()) {
      return res.status(400).json({ error: '対象（支店名・営業所名・担当者名）を入力してください' });
    }
    if (!Number.isFinite(Number(r.amount))) {
      return res.status(400).json({ error: '目標金額は数値で入力してください' });
    }
  }
  await db.run('DELETE FROM targets');
  if (rows.length) {
    await db.batch(rows.map((r) => ({
      sql: 'INSERT INTO targets (scope, scope_value, round, amount) VALUES (?,?,?,?)',
      params: [r.scope, String(r.scope_value).trim(), Number(r.round), Number(r.amount)],
    })));
  }
  res.json(await db.all('SELECT * FROM targets ORDER BY scope, scope_value, round'));
}));

// ---- Excel取込 ----

/**
 * multerのoriginalnameはUTF-8のバイト列をlatin-1として解釈した文字列で渡ってくるため、
 * 日本語のファイル名が「çµ¦æ¹¯å™¨…」のように化ける。バイト列へ戻してUTF-8で読み直す。
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
// 取り込める項目の一覧。画面で列を合わせるときの選択肢になる
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
  const { filename, contentHash, mapping, force } = req.body || {};
  if (!mapping || typeof mapping !== 'object') {
    return res.status(400).json({ error: '列の対応が指定されていません' });
  }
  try {
    validateMapping(mapping);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (contentHash && !force) {
    try {
      await assertNotDuplicate(String(contentHash));
    } catch (e) {
      if (e.isDuplicate) return res.status(409).json({ error: e.message, duplicate: true, batch: e.batch });
      throw e;
    }
  }
  const batchId = await createBatch(String(filename || '（名称不明）'), req.user.id, contentHash || null);
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
  await insertRows(batchId, built);
  const total = await addBatchCount(batchId, built.length);
  res.json({ added: built.length, total, skipped: summarizeWarnings(warnings) });
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

  const used = await db.get(
    `SELECT COUNT(*) AS c FROM application_items ai
       JOIN deals d ON d.id = ai.deal_id
      WHERE d.batch_id = ?`,
    [id]
  );
  if (Number(used?.c || 0) > 0) {
    return res.status(400).json({
      error: `この取込には申請済みの明細が${Number(used.c).toLocaleString()}件含まれているため取り消せません。`
        + '該当の申請を取下げてから実行してください',
    });
  }

  await db.run('DELETE FROM negotiation_logs WHERE deal_id IN (SELECT id FROM deals WHERE batch_id = ?)', [id]);
  await db.run('DELETE FROM attachments WHERE deal_id IN (SELECT id FROM deals WHERE batch_id = ?)', [id]);
  const { changes } = await db.run('DELETE FROM deals WHERE batch_id = ?', [id]);
  await db.run('DELETE FROM import_batches WHERE id = ?', [id]);
  res.json({ deleted: Number(changes ?? batch.row_count) });
}));

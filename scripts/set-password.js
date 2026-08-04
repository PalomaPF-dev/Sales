// ユーザーのパスワードを設定する（初回セットアップ・パスワード紛失時の復旧用）
//
//   npm run set-password -- <ログインID> [パスワード]
//   npm run set-password -- --list            … ユーザー一覧を表示
//   npm run set-password -- --create <ログインID> <氏名> [--role <役割>] [パスワード]
//                                             … ユーザーを作って同時にパスワードを設定
//
// パスワードを省略すると安全な仮パスワードを生成し、初回ログイン時に変更を求めます。
// --role は sales / branch_manager / planning / admin / developer（既定は admin）。
// 本番DBに対して実行する場合は DATABASE_URL を設定してください。
import { db, initDb } from '../server/db.js';
import { hashPassword, generateTempPassword, validatePassword } from '../server/passwords.js';
import { destroyUserSessions } from '../server/session.js';

const args = process.argv.slice(2);
await initDb();
console.log(`接続先: ${db.kind === 'postgres' ? 'PostgreSQL' : 'ローカルSQLite'}`);

if (args.includes('--list') || args.length === 0) {
  const rows = await db.all(`
    SELECT id, login_id, name, role, active, last_login_at,
           CASE WHEN password_hash IS NULL THEN 'なし' ELSE 'あり' END AS pw
    FROM users ORDER BY id`);
  console.log('\nID  ログインID        氏名             役割              PW    最終ログイン');
  console.log('─'.repeat(88));
  for (const r of rows) {
    const line = [
      String(r.id).padEnd(3),
      String(r.login_id ?? '—').padEnd(17),
      String(r.name).padEnd(16),
      String(r.role).padEnd(17),
      String(r.pw).padEnd(5),
      r.last_login_at ? String(r.last_login_at).slice(0, 16).replace('T', ' ') : '—',
    ].join(' ');
    console.log(r.active ? line : `${line}  (無効)`);
  }
  if (args.length === 0) {
    console.log('\n使い方: npm run set-password -- <ログインID> [パスワード]');
  }
  db.close?.();
  process.exit(0);
}

const ROLES = ['sales', 'branch_manager', 'planning', 'admin', 'developer'];
const create = args.includes('--create');

// --role の値はフラグの直後に来る。位置引数と混ざらないよう先に取り除く
const roleIndex = args.indexOf('--role');
const role = roleIndex >= 0 ? args[roleIndex + 1] : 'admin';
if (roleIndex >= 0 && !ROLES.includes(role)) {
  console.error(`--role は ${ROLES.join(' / ')} のいずれかを指定してください（受け取った値: ${role}）`);
  db.close?.();
  process.exit(1);
}
// --role が無いときは roleIndex が -1 になる。そのまま roleIndex+1 を除くと
// 先頭の引数（ログインID）まで落ちてしまうので、指定があるときだけ除く。
const roleValueIndex = roleIndex >= 0 ? roleIndex + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== roleValueIndex);

let user;
let explicitPassword;

if (create) {
  const [newLoginId, name, pw] = positional;
  explicitPassword = pw;
  if (!newLoginId || !name) {
    console.error('使い方: npm run set-password -- --create <ログインID> <氏名> [--role <役割>] [パスワード]');
    db.close?.();
    process.exit(1);
  }
  const exists = await db.get('SELECT id FROM users WHERE login_id = ?', [newLoginId]);
  if (exists) {
    console.error(`ログインID "${newLoginId}" は既に使われています。作成せずに終了します。`);
    db.close?.();
    process.exit(1);
  }
  const created = await db.run(
    `INSERT INTO users (name, role, branch, office, active, login_id, must_change_password)
     VALUES (?,?,?,?,1,?,0)`,
    [name, role, null, null, newLoginId]);
  user = await db.get('SELECT * FROM users WHERE id = ?', [created.lastInsertRowid]);
  console.log(`\nユーザーを作成しました: ${name}（${role}）`);
} else {
  const [loginId, pw] = positional;
  explicitPassword = pw;
  user = await db.get('SELECT * FROM users WHERE login_id = ?', [loginId]);
  if (!user) {
    console.error(`ログインID "${loginId}" のユーザーが見つかりません。--list で一覧を確認してください。`);
    console.error('新しく作る場合は --create を付けてください。');
    db.close?.();
    process.exit(1);
  }
}

let password = explicitPassword;
let mustChange = 0;
if (password) {
  const problem = validatePassword(password);
  if (problem) {
    console.error(`エラー: ${problem}`);
    db.close?.();
    process.exit(1);
  }
} else {
  password = generateTempPassword();
  mustChange = 1; // 生成した仮パスワードは初回ログイン時に変更させる
}

await db.run(
  `UPDATE users SET password_hash = ?, must_change_password = ?,
          failed_attempts = 0, locked_until = NULL WHERE id = ?`,
  [await hashPassword(password), mustChange, user.id]
);
await destroyUserSessions(user.id); // 既存のログインを打ち切る

console.log(`\n${user.name}（${user.role}）のパスワードを設定しました。`);
console.log(`  ログインID : ${user.login_id}`);
if (!explicitPassword) {
  console.log(`  仮パスワード: ${password}`);
  console.log('\n※ このパスワードは再表示できません。本人に安全な手段で伝えてください。');
  console.log('※ 初回ログイン時にパスワードの変更が求められます。');
}
db.close?.();

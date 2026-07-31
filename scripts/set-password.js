// ユーザーのパスワードを設定する（初回セットアップ・パスワード紛失時の復旧用）
//
//   npm run set-password -- <ログインID> [パスワード]
//   npm run set-password -- --list            … ユーザー一覧を表示
//
// パスワードを省略すると安全な仮パスワードを生成し、初回ログイン時に変更を求めます。
// Turso本番に対して実行する場合は TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を設定してください。
import { db, initDb, isTurso } from '../server/db.js';
import { hashPassword, generateTempPassword, validatePassword } from '../server/passwords.js';
import { destroyUserSessions } from '../server/session.js';

const args = process.argv.slice(2);
await initDb();
console.log(`接続先: ${isTurso ? 'Turso' : 'ローカルSQLite'}`);

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

const [loginId, explicitPassword] = args.filter((a) => !a.startsWith('--'));
const user = await db.get('SELECT * FROM users WHERE login_id = ?', [loginId]);
if (!user) {
  console.error(`ログインID "${loginId}" のユーザーが見つかりません。--list で一覧を確認してください。`);
  db.close?.();
  process.exit(1);
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

// データアクセス層。ローカル開発は node:sqlite、本番は PostgreSQL を
// 同一の非同期インターフェースで扱う。
//
//   DATABASE_URL（または POSTGRES_URL）が設定されていれば PostgreSQL、
//   未設定ならローカルのSQLiteファイル。
//
// 提供するメソッド:
//   get(sql, params)   -> 1行 or undefined
//   all(sql, params)   -> 行の配列
//   run(sql, params)   -> { lastInsertRowid, changes }
//   exec(sql)          -> 複数ステートメントの実行（スキーマ適用など）
//   batch(statements)  -> トランザクションでまとめて実行
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
export const isPostgres = Boolean(PG_URL);

// 相乗り先のDBで既存テーブルと衝突しないよう、専用スキーマに配置する
const PG_SCHEMA = process.env.DB_SCHEMA || 'sales_pricing';

// SQLiteは boolean をそのまま扱えないため数値へ、undefined は null へ正規化する
function normalizeParams(params = []) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

// SQLファイルを個別のステートメントへ分割する。
// CREATE VIEW / CREATE TRIGGER のように本体にセミコロンを含む定義があるため、
// 単純な `split(';')` ではなく行頭キーワードの追跡が必要になる。
function splitStatements(sql) {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = [];
  let current = '';
  for (const part of withoutComments.split(';')) {
    current += part + ';';
    // CREATE VIEW ... AS SELECT の途中では分割しない
    const upper = current.toUpperCase();
    const isView = /\bCREATE\s+(OR\s+REPLACE\s+)?VIEW\b/.test(upper);
    const hasSelect = /\bSELECT\b/.test(upper);
    const balanced = (current.match(/\(/g) || []).length === (current.match(/\)/g) || []).length;
    if (isView && !(hasSelect && balanced && /\bFROM\b/.test(upper))) continue;
    if (!balanced) continue;
    const trimmed = current.trim();
    if (trimmed && trimmed !== ';') statements.push(trimmed);
    current = '';
  }
  const rest = current.trim();
  if (rest && rest !== ';') statements.push(rest);
  return statements;
}

function createLocalDb() {
  // 動的インポート: PostgreSQL利用時は node:sqlite を読み込まない
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  mkdirSync(DATA_DIR, { recursive: true });
  const raw = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  return {
    kind: 'sqlite',
    async get(sql, params = []) {
      return raw.prepare(sql).get(...normalizeParams(params));
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...normalizeParams(params));
    },
    async run(sql, params = []) {
      const r = raw.prepare(sql).run(...normalizeParams(params));
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async exec(sql) {
      for (const stmt of splitStatements(sql)) raw.exec(stmt);
    },
    async batch(statements) {
      raw.exec('BEGIN');
      try {
        const results = [];
        for (const { sql, params } of statements) {
          const r = raw.prepare(sql).run(...normalizeParams(params));
          results.push({ lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) });
        }
        raw.exec('COMMIT');
        return results;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    close() {
      raw.close();
    },
  };
}

/**
 * SQLiteの `?` プレースホルダを PostgreSQL の `$1, $2...` へ変換する。
 * 文字列リテラル内の `?` は変換しない。
 */
function toPgPlaceholders(sql) {
  let out = '';
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) { out += ch; if (ch === "'") inSingle = false; continue; }
    if (inDouble) { out += ch; if (ch === '"') inDouble = false; continue; }
    if (ch === "'") { inSingle = true; out += ch; continue; }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    if (ch === '?') { out += '$' + (++n); continue; }
    out += ch;
  }
  return out;
}

// id列を持たないテーブル。INSERT時に RETURNING id を付けるとエラーになる。
const TABLES_WITHOUT_ID = new Set(['settings', 'price_types']);

/** SQLiteの方言をPostgreSQLへ寄せる */
function toPgSql(sql) {
  let out = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
  const wasOrIgnore = out !== sql;
  if (wasOrIgnore && !/ON\s+CONFLICT/i.test(out)) {
    out = out.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  }
  return toPgPlaceholders(out);
}

/** INSERTに RETURNING id を足して lastInsertRowid 相当を得られるようにする */
function withReturningId(sql) {
  const m = /^\s*insert\s+into\s+"?([a-z_][a-z0-9_]*)"?/i.exec(sql);
  if (!m) return { sql, hasReturning: false };
  if (/\breturning\b/i.test(sql)) return { sql, hasReturning: true };
  if (TABLES_WITHOUT_ID.has(m[1].toLowerCase())) return { sql, hasReturning: false };
  return { sql: sql.replace(/;?\s*$/, ' RETURNING id'), hasReturning: true };
}

function createPostgresDb() {
  const { Pool, types } = require('pg');
  // COUNT(*) 等の bigint は既定で文字列になるため、数値として受け取る
  types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  // numeric も数値へ（金額計算で文字列連結にならないように）
  types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(PG_URL) || PG_URL.includes('host=/');
  const pool = new Pool({
    connectionString: PG_URL,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 10000,
    // マネージドDBはTLS必須のことが多い。社内CAで検証が通らない場合は
    // DB_SSL_NO_VERIFY=true で緩められるようにしておく。
    ssl: isLocal ? false
      : (String(process.env.DB_SSL_NO_VERIFY).toLowerCase() === 'true'
          ? { rejectUnauthorized: false }
          : true),
    // 専用スキーマを既定の検索先にする
    options: `-c search_path=${PG_SCHEMA},public`,
  });

  const query = async (sql, params = []) =>
    pool.query(toPgSql(sql), normalizeParams(params));

  return {
    kind: 'postgres',
    async get(sql, params = []) {
      const r = await query(sql, params);
      return r.rows[0];
    },
    async all(sql, params = []) {
      return (await query(sql, params)).rows;
    },
    async run(sql, params = []) {
      const { sql: withRet, hasReturning } = withReturningId(sql);
      const r = await pool.query(toPgSql(withRet), normalizeParams(params));
      return {
        lastInsertRowid: hasReturning && r.rows[0]?.id != null ? Number(r.rows[0].id) : null,
        changes: Number(r.rowCount || 0),
      };
    },
    async exec(sql) {
      // スキーマ適用。パラメータを含まないため、まとめて実行できる
      await pool.query(sql);
    },
    async batch(statements) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const results = [];
        for (const { sql, params } of statements) {
          const { sql: withRet, hasReturning } = withReturningId(sql);
          const r = await client.query(toPgSql(withRet), normalizeParams(params));
          results.push({
            lastInsertRowid: hasReturning && r.rows[0]?.id != null ? Number(r.rows[0].id) : null,
            changes: Number(r.rowCount || 0),
          });
        }
        await client.query('COMMIT');
        return results;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

// ESM から CommonJS の require を使うためのブリッジ
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// サーバーレス環境（Vercel）はファイルシステムが揮発性のため、
// ローカルSQLiteへのフォールバックは許可しない。
const isServerless = Boolean(process.env.VERCEL);

export class DbConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DbConfigError';
    this.isConfigError = true;
  }
}

// 接続の生成は初回アクセスまで遅延させる。
// モジュール読み込み時に生成すると、設定不備のときに関数全体が起動できず、
// 原因の分からない500になってしまうため。
let impl = null;
function getImpl() {
  if (impl) return impl;
  if (isPostgres) {
    impl = createPostgresDb();
  } else if (isServerless) {
    throw new DbConfigError(
      '環境変数 DATABASE_URL が設定されていません。' +
      'Vercelではファイルシステムが揮発性のためデータを保存できません。' +
      'PostgreSQL の接続文字列（DATABASE_URL）を設定してください。詳細は SETUP-WEB.md を参照してください。'
    );
  } else {
    impl = createLocalDb();
  }
  return impl;
}

export const db = {
  get kind() {
    if (isPostgres) return 'postgres';
    return isServerless ? 'unconfigured' : 'sqlite';
  },
  async get(sql, params) { return getImpl().get(sql, params); },
  async all(sql, params) { return getImpl().all(sql, params); },
  async run(sql, params) { return getImpl().run(sql, params); },
  async exec(sql) { return getImpl().exec(sql); },
  async batch(statements) { return getImpl().batch(statements); },
  close() { impl?.close?.(); },
};

let initialized = null;

/** スキーマ適用とマスタ初期データ投入（初回のみ実行） */
export async function initDb() {
  if (initialized) return initialized;
  initialized = (async () => {
    if (isPostgres) await preparePostgresSchema();
    const schemaFile = isPostgres ? 'schema.postgres.sql' : 'schema.sql';
    const schema = readFileSync(path.join(__dirname, schemaFile), 'utf8');
    await db.exec(schema);
    await migrate();
    await seedMasters();
  })();
  try {
    return await initialized;
  } catch (e) {
    initialized = null; // 失敗を記憶せず、設定修正後の再試行を可能にする
    throw e;
  }
}

/**
 * 専用スキーマを用意し、接続時の search_path が実際に効いているかを確認する。
 *
 * PgBouncer等の接続プーラーを経由すると、接続オプション（-c search_path=...）が
 * 無視されることがある。その状態で進めると「テーブルが存在しない」という
 * 原因の分かりにくい失敗になるため、先に検知して対処法を示す。
 */
async function preparePostgresSchema() {
  // スキーマ名は識別子なのでプレースホルダを使えない。想定外の文字は弾く
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(PG_SCHEMA)) {
    throw new DbConfigError(`DB_SCHEMA に使用できない文字が含まれています: ${PG_SCHEMA}`);
  }
  await db.exec(`CREATE SCHEMA IF NOT EXISTS "${PG_SCHEMA}"`);

  const row = await db.get('SELECT current_schema() AS schema');
  if (row?.schema === PG_SCHEMA) return;
  throw new DbConfigError(
    `テーブルの作成先が「${row?.schema ?? '不明'}」になっており、想定の「${PG_SCHEMA}」が適用されていません。`
    + ' 接続プーラー（PgBouncer等）を経由すると接続時のオプションが無視されることがあります。'
    + ' プーラーを経由しない接続文字列（Neonの場合はホスト名に -pooler が付かない方）をお試しください。'
  );
}

/**
 * 既存DBへの列追加。
 * CREATE TABLE IF NOT EXISTS は既存テーブルを変更しないため、
 * 認証機能の追加前に作られたDBには列が無い。既にある場合のエラーは無視する。
 */
async function migrate() {
  const additions = [
    'ALTER TABLE users ADD COLUMN login_id TEXT',
    'ALTER TABLE users ADD COLUMN password_hash TEXT',
    'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN locked_until TEXT',
    'ALTER TABLE users ADD COLUMN last_login_at TEXT',
  ];
  for (const sql of additions) {
    try {
      await db.run(sql);
    } catch (e) {
      // 列が既にある場合のエラーは想定内（SQLite: duplicate column name /
      // PostgreSQL: column ... already exists）。それ以外は設計上の問題なので出す
      if (!/duplicate column|already exists/i.test(e?.message || '')) {
        console.warn(`マイグレーション警告: ${sql} → ${e.message}`);
      }
    }
  }
  // 認証機能より前から居るユーザーはログインIDを持たないため補完する。
  // これが無いとログインもパスワード設定もできない状態になる。
  try {
    await db.run("UPDATE users SET login_id = 'user' || id WHERE login_id IS NULL OR login_id = ''");
  } catch (e) {
    console.warn(`マイグレーション警告: ログインIDを補完できませんでした → ${e.message}`);
  }

  // 列追加後でないとインデックスを張れないため、ここで実行する
  try {
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_id ON users(login_id)');
  } catch (e) {
    console.warn(`マイグレーション警告: login_id の一意制約を作成できませんでした → ${e.message}`);
  }
}

async function seedMasters() {
  const { c: priceTypeCount } = await db.get('SELECT COUNT(*) AS c FROM price_types');
  if (Number(priceTypeCount) === 0) {
    // 添付資料「単価（標準単価）」の6種類
    await db.batch([
      { sql: 'INSERT INTO price_types (code, name, category, note) VALUES (?,?,?,?)', params: [1, '取引先G商品G', '標準', '取引先グループ×商品グループ。掛率で登録'] },
      { sql: 'INSERT INTO price_types (code, name, category, note) VALUES (?,?,?,?)', params: [2, '取引先G商品', '標準', '取引先グループ×商品（商品毎の価格対応）'] },
      { sql: 'INSERT INTO price_types (code, name, category, note) VALUES (?,?,?,?)', params: [3, '取引先商品G', '標準', '取引先×商品グループ（エリア毎の価格対応）'] },
      { sql: 'INSERT INTO price_types (code, name, category, note) VALUES (?,?,?,?)', params: [4, '取引先商品', '標準', '取引先×商品'] },
      { sql: 'INSERT INTO price_types (code, name, category, note) VALUES (?,?,?,?)', params: [5, '納入先別単価', '販売店対応', '販売先と納入先が設定される'] },
      { sql: 'INSERT INTO price_types (code, name, category, note) VALUES (?,?,?,?)', params: [6, '見積伝票', '物件対応', '販売先と納入先が設定される（物件単位）'] },
    ]);
  }

  const { c: userCount } = await db.get('SELECT COUNT(*) AS c FROM users');
  if (Number(userCount) === 0) {
    // password_hash は意図的にNULLのまま。既定パスワードを埋め込むと
    // 設定変更を忘れたときにそのまま入られてしまうため、
    // 初回は `npm run set-password` で明示的に設定させる。
    const sql = 'INSERT INTO users (name, role, branch, office, login_id) VALUES (?,?,?,?,?)';
    await db.batch([
      { sql, params: ['営業 太郎', 'sales', '東京中央', '東京中央営業所', 'sales1'] },
      { sql, params: ['営業 花子', 'sales', '東京中央', '東京中央営業所', 'sales2'] },
      { sql, params: ['支店長 一郎', 'branch_manager', '東京中央', null, 'branch1'] },
      { sql, params: ['企画 次郎', 'planning', '本社', '営業企画部', 'planning1'] },
      { sql, params: ['管理者', 'admin', '本社', null, 'admin'] },
    ]);
  }

  const { c: ruleCount } = await db.get('SELECT COUNT(*) AS c FROM approval_rules');
  if (Number(ruleCount) === 0) {
    const sql = 'INSERT INTO approval_rules (name, min_rate, max_rate, final_step, priority) VALUES (?,?,?,?,?)';
    // 既定: 目標達成（100%以上）なら支店長決裁で完結、未達なら営業企画部決裁まで
    await db.batch([
      { sql, params: ['目標達成（達成率100%以上）→ 支店長決裁', 100, null, 'branch', 1] },
      { sql, params: ['目標未達（達成率100%未満）→ 営業企画部決裁', null, 100, 'planning', 2] },
    ]);
  }

  const setSql = 'INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)';
  await db.batch([
    { sql: setSql, params: ['r1_target_total', '5042350'] }, // 第1弾 支店値上げ目標金額（管理表より）
    { sql: setSql, params: ['r2_target_total', '8622667'] }, // 第2弾 支店値上げ目標金額（管理表より）
    { sql: setSql, params: ['branch_name', '東京中央'] },
  ]);
}

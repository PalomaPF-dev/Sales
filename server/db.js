// データアクセス層。ローカル開発は node:sqlite、本番(Vercel)は Turso(libSQL) を
// 同一の非同期インターフェースで扱う。
//
//   TURSO_DATABASE_URL が設定されていれば Turso、未設定ならローカルのSQLiteファイル。
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

const TURSO_URL = process.env.TURSO_DATABASE_URL;
export const isTurso = Boolean(TURSO_URL);

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
  // 動的インポート: Vercel(Turso)環境では node:sqlite を読み込まない
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

function createTursoDb() {
  const { createClient } = require('@libsql/client');
  const client = createClient({
    url: TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const toRow = (row) => (row === undefined ? undefined : { ...row });

  return {
    kind: 'turso',
    async get(sql, params = []) {
      const rs = await client.execute({ sql, args: normalizeParams(params) });
      return toRow(rs.rows[0]);
    },
    async all(sql, params = []) {
      const rs = await client.execute({ sql, args: normalizeParams(params) });
      return rs.rows.map(toRow);
    },
    async run(sql, params = []) {
      const rs = await client.execute({ sql, args: normalizeParams(params) });
      return {
        lastInsertRowid: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : null,
        changes: Number(rs.rowsAffected || 0),
      };
    },
    async exec(sql) {
      for (const stmt of splitStatements(sql)) {
        await client.execute(stmt);
      }
    },
    async batch(statements) {
      // libSQLのbatchは全体が1トランザクションとして実行される
      const rs = await client.batch(
        statements.map(({ sql, params }) => ({ sql, args: normalizeParams(params) })),
        'write'
      );
      return rs.map((r) => ({
        lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null,
        changes: Number(r.rowsAffected || 0),
      }));
    },
    close() {
      client.close();
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
  if (isTurso) {
    impl = createTursoDb();
  } else if (isServerless) {
    throw new DbConfigError(
      '環境変数 TURSO_DATABASE_URL が設定されていません。' +
      'Vercelではファイルシステムが揮発性のためデータを保存できません。' +
      'Turso の接続情報（TURSO_DATABASE_URL / TURSO_AUTH_TOKEN）を設定してください。詳細は DEPLOY.md を参照してください。'
    );
  } else {
    impl = createLocalDb();
  }
  return impl;
}

export const db = {
  get kind() {
    if (isTurso) return 'turso';
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
    const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await db.exec(schema);
    await seedMasters();
  })();
  try {
    return await initialized;
  } catch (e) {
    initialized = null; // 失敗を記憶せず、設定修正後の再試行を可能にする
    throw e;
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
    const sql = 'INSERT INTO users (name, role, branch, office) VALUES (?,?,?,?)';
    await db.batch([
      { sql, params: ['営業 太郎', 'sales', '東京中央', '東京中央営業所'] },
      { sql, params: ['営業 花子', 'sales', '東京中央', '東京中央営業所'] },
      { sql, params: ['支店長 一郎', 'branch_manager', '東京中央', null] },
      { sql, params: ['企画 次郎', 'planning', '本社', '営業企画部'] },
      { sql, params: ['管理者', 'admin', '本社', null] },
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

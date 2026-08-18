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

// 接続文字列。VercelのNeon連携はプール接続と直接接続の両方を環境変数に入れるため、
// 直接接続（UNPOOLED / NON_POOLING）があればそちらを優先する。
// 本アプリは接続時に search_path を指定しており、プーラー（PgBouncer）経由では
// この指定が拒否されるため（unsupported startup parameter）。
const RAW_PG_URL =
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL;

/**
 * Neonのプール接続URL（ホスト名に -pooler が付く）を直接接続へ読み替える。
 * Neonでは両者はホスト名だけの違いで同じDBを指す。プーラー経由のままだと
 * search_path 指定が拒否されて起動できないため、貼られた文字列がどちらでも
 * 動くようにここで吸収する。
 */
function normalizePgUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith('.neon.tech') && u.hostname.includes('-pooler')) {
      u.hostname = u.hostname.replace('-pooler', '');
      console.warn(
        'DATABASE_URL がNeonのプール接続（-pooler付き）だったため、直接接続へ読み替えました。'
      );
      return u.toString();
    }
  } catch {
    // URL形式でない（host=/var/run/... 等）場合はそのまま使う
  }
  return raw;
}

const PG_URL = normalizePgUrl(RAW_PG_URL);
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
// 主キーがidでないテーブルを足すときは、ここにも必ず追加すること。
const TABLES_WITHOUT_ID = new Set([
  'settings', 'price_types', 'corp_negotiations', 'sso_used_tokens',
  'corp_map', 'agg_staging', 'act_staging', 'corp_plans',
]);

/** SQLiteの方言をPostgreSQLへ寄せる */
function toPgSql(sql) {
  let out = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
  const wasOrIgnore = out !== sql;
  if (wasOrIgnore && !/ON\s+CONFLICT/i.test(out)) {
    out = out.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  }
  return toPgPlaceholders(out);
}

// 1文あたりのバインド変数はPostgreSQLで65535個まで。余裕をみて上限を決める
const PG_MAX_BIND_PARAMS = 60000;
const PG_MAX_ROWS_PER_INSERT = 1000;

/**
 * 同じINSERT文が並んでいるとき、VALUES を複数タプルに展開して1文にまとめる。
 * 取込では2万行を超えるINSERTが並ぶため、1行1文のままだと
 * DBとの往復回数がそのまま行数になり、遠隔のDBでは実行時間が桁違いになる。
 * 展開できない形（OR IGNORE、プレースホルダ以外を含むVALUESなど）は null を返す。
 */
function expandInsertValues(sql, rowCount) {
  if (rowCount < 2) return null;
  if (/\binsert\s+or\s+ignore\b/i.test(sql)) return null; // 競合でスキップされると件数が対応づかない
  const trimmed = sql.trim().replace(/;$/, '');
  const m = /\bvalues\s*(\(\s*\?(?:\s*,\s*\?)*\s*\))\s*$/i.exec(trimmed);
  if (!m) return null;
  const tuple = m[1];
  const perRow = (tuple.match(/\?/g) || []).length;
  if (perRow === 0) return null;
  const head = trimmed.slice(0, m.index);
  return {
    perRow,
    build: (n) => `${head}VALUES ${Array(n).fill(tuple).join(',')}`,
  };
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

  // Neon以外のプーラー（Supabase等）で同じ拒否が起きた場合に、対処が分かる形で返す
  const translate = (e) => {
    if (/unsupported startup parameter/i.test(String(e?.message || ''))) {
      return new DbConfigError(
        '接続先がプーラー（PgBouncer）経由のため、本アプリが必要とする接続時のスキーマ指定を受け付けません。'
        + 'プーラーを経由しない接続文字列（ホスト名に -pooler や pooler. が付かない直接接続）に差し替えてください。'
      );
    }
    return e;
  };

  const query = async (sql, params = []) => {
    try {
      return await pool.query(toPgSql(sql), normalizeParams(params));
    } catch (e) {
      throw translate(e);
    }
  };

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
      let r;
      try {
        r = await pool.query(toPgSql(withRet), normalizeParams(params));
      } catch (e) {
        throw translate(e);
      }
      return {
        lastInsertRowid: hasReturning && r.rows[0]?.id != null ? Number(r.rows[0].id) : null,
        changes: Number(r.rowCount || 0),
      };
    },
    async exec(sql) {
      // スキーマ適用。パラメータを含まないため、まとめて実行できる
      try {
        await pool.query(sql);
      } catch (e) {
        throw translate(e);
      }
    },
    async batch(statements) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const results = [];
        let i = 0;
        while (i < statements.length) {
          const { sql } = statements[i];
          // 同じINSERT文が続く区間を探し、まとめて1文で送る
          let end = i + 1;
          while (end < statements.length && statements[end].sql === sql) end++;
          const expandable = expandInsertValues(sql, end - i);
          if (!expandable) {
            const { sql: withRet, hasReturning } = withReturningId(sql);
            const r = await client.query(toPgSql(withRet), normalizeParams(statements[i].params));
            results.push({
              lastInsertRowid: hasReturning && r.rows[0]?.id != null ? Number(r.rows[0].id) : null,
              changes: Number(r.rowCount || 0),
            });
            i++;
            continue;
          }
          const chunkRows = Math.max(1, Math.min(
            PG_MAX_ROWS_PER_INSERT,
            Math.floor(PG_MAX_BIND_PARAMS / expandable.perRow)
          ));
          for (let from = i; from < end; from += chunkRows) {
            const slice = statements.slice(from, Math.min(from + chunkRows, end));
            const { sql: withRet, hasReturning } = withReturningId(expandable.build(slice.length));
            const params = normalizeParams(slice.flatMap((s) => s.params));
            const r = await client.query(toPgSql(withRet), params);
            // RETURNING は挿入順に返るため、そのまま各文の結果へ割り当てる
            slice.forEach((_, k) => results.push({
              lastInsertRowid: hasReturning && r.rows[k]?.id != null ? Number(r.rows[k].id) : null,
              changes: 1,
            }));
          }
          i = end;
        }
        await client.query('COMMIT');
        return results;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw translate(e);
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
// スキーマの版。schema.sql / beforeSchema / migrate を変えたら必ず上げること。
// この版がDBに記録されていれば、起動のたびの重い確認（数十回のDB往復）を省ける。
const SCHEMA_VERSION = '2026-08-18-survey-source';

/**
 * すでに同じ版で初期化済みかを1回の問い合わせで確かめる。
 * サーバーレスでは起動のたびに initDb が走るため、
 * ここを省けるかどうかが初回表示の速さに直結する。
 */
async function isUpToDate() {
  try {
    const row = await db.get("SELECT value FROM settings WHERE key = 'schema_version'");
    return row?.value === SCHEMA_VERSION;
  } catch {
    return false;   // settings が無い＝初回。通常の初期化へ
  }
}

export async function initDb() {
  if (initialized) return initialized;
  initialized = (async () => {
    if (isPostgres) await preparePostgresSchema();
    if (await isUpToDate()) return;
    // スキーマ適用より先に、既存DBの形をそろえておく。
    // 計算列ビューは列構成が変わると作り直しになり、
    // ビューが参照する列はスキーマ適用前に存在している必要がある。
    await beforeSchema();
    const schemaFile = isPostgres ? 'schema.postgres.sql' : 'schema.sql';
    const schema = readFileSync(path.join(__dirname, schemaFile), 'utf8');
    await db.exec(schema);
    await migrate();
    await seedMasters();
    // 次回以降の起動で重い確認を省くための印
    try {
      await db.run(
        `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [SCHEMA_VERSION]);
    } catch { /* 印を残せなくても動作に支障はない（毎回確認になるだけ） */ }
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
/** 既にある列を足す。テーブルが無い（新規DB）場合と、列が既にある場合は何もしない */
async function tryAlter(sql) {
  try {
    await db.run(sql);
  } catch (e) {
    const m = e?.message || '';
    if (/duplicate column|already exists|no such table|does not exist/i.test(m)) return;
    console.warn(`マイグレーション警告: ${sql} → ${m}`);
  }
}

/**
 * スキーマ適用の前に済ませておくこと。
 * 計算列ビューは列構成が変わったら作り直す必要があり、
 * かつビューが参照する列はスキーマ適用時点で存在していなければならない。
 */
async function beforeSchema() {
  // SQLiteの CREATE VIEW IF NOT EXISTS は旧定義を置き換えないため落としておく。
  // PostgreSQLは CREATE OR REPLACE VIEW で置き換わるので落とさない。
  // （本番はサーバーが並行して起動する。ここで落とすと、作り直すまでの
  //   一瞬の隙間に他のサーバーの問い合わせが「deal_calc が無い」で失敗する）
  if (!isPostgres) {
    try { await db.run('DROP VIEW IF EXISTS deal_calc'); } catch { /* 無ければよい */ }
  }

  // 第1弾の廃止。r1_ 列が残っている既存DBから列ごと削除する（データも不要と確認済み）。
  // ビューが列を参照しているため、先にビューを落とす。
  // 列の構成が変わるので CREATE OR REPLACE では置き換えられず、
  // この一度だけは PostgreSQL でも DROP → CREATE になる。
  try {
    await db.get('SELECT r1_done FROM deals LIMIT 1');   // 旧DBでだけ成功する
    console.log('第1弾の列を削除します（旧スキーマからの移行）');
    try { await db.run('DROP VIEW IF EXISTS deal_calc'); } catch { /* 無ければよい */ }
    for (const col of [
      'r1_target_rate', 'r1_target_price', 'negotiated_date', 'negotiation_note',
      'r1_agreed_price', 'r1_raise_date', 'r1_ringi_no', 'r1_after_rate',
      'r1_applied_ym', 'r1_done',
    ]) {
      await tryAlter(`ALTER TABLE deals DROP COLUMN ${col}`);
    }
  } catch { /* 列が無い＝移行済みか新規DB。何もしない */ }

  for (const sql of [
    'ALTER TABLE users ADD COLUMN login_id TEXT',
    'ALTER TABLE users ADD COLUMN password_hash TEXT',
    'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN locked_until TEXT',
    'ALTER TABLE users ADD COLUMN last_login_at TEXT',
    // 同じファイルの二重取込を検知するための内容ハッシュとデータ指紋
    'ALTER TABLE import_batches ADD COLUMN content_hash TEXT',
    'ALTER TABLE import_batches ADD COLUMN data_hash TEXT',
    // 基準価格表の区分（担当者が選ぶ。目標はマスターから入る）
    'ALTER TABLE deals ADD COLUMN kubun TEXT',
    // マスタ登録（集約表）の取込。得意先×納入先×商品の単位で管理する
    'ALTER TABLE deals ADD COLUMN agg_key TEXT',
    'ALTER TABLE deals ADD COLUMN qty REAL',
    'ALTER TABLE deals ADD COLUMN cost_price REAL',
    'ALTER TABLE deals ADD COLUMN a_price_m0 REAL',
    'ALTER TABLE deals ADD COLUMN a_price_m1 REAL',
    'ALTER TABLE deals ADD COLUMN a_price_m2 REAL',
    'ALTER TABLE deals ADD COLUMN a_price_m3 REAL',
    // A基準それぞれの承認日（マスタ登録の「登録日」）
    'ALTER TABLE deals ADD COLUMN a_date_m0 TEXT',
    'ALTER TABLE deals ADD COLUMN a_date_m1 TEXT',
    'ALTER TABLE deals ADD COLUMN a_date_m2 TEXT',
    'ALTER TABLE deals ADD COLUMN a_date_m3 TEXT',
    // A基準それぞれの稟議No（マスタ登録に「稟議」列があるときだけ入る）
    'ALTER TABLE deals ADD COLUMN a_ringi_m0 TEXT',
    'ALTER TABLE deals ADD COLUMN a_ringi_m1 TEXT',
    'ALTER TABLE deals ADD COLUMN a_ringi_m2 TEXT',
    'ALTER TABLE deals ADD COLUMN a_ringi_m3 TEXT',
    'ALTER TABLE agg_staging ADD COLUMN r0_no TEXT',
    'ALTER TABLE agg_staging ADD COLUMN r1_no TEXT',
    'ALTER TABLE agg_staging ADD COLUMN r2_no TEXT',
    'ALTER TABLE agg_staging ADD COLUMN r3_no TEXT',
    'ALTER TABLE deals ADD COLUMN b_price REAL',
    // 集約の作業表にも当月分と承認日を足す
    'ALTER TABLE agg_staging ADD COLUMN a0_amt REAL NOT NULL DEFAULT 0',
    'ALTER TABLE agg_staging ADD COLUMN d0_max TEXT',
    'ALTER TABLE agg_staging ADD COLUMN d1_max TEXT',
    'ALTER TABLE agg_staging ADD COLUMN d2_max TEXT',
    'ALTER TABLE agg_staging ADD COLUMN d3_max TEXT',
    // 支店・営業所・担当者は、数量の一番多い行を代表として案件へ写す
    'ALTER TABLE agg_staging ADD COLUMN branch TEXT',
    'ALTER TABLE agg_staging ADD COLUMN office TEXT',
    'ALTER TABLE agg_staging ADD COLUMN sales_person TEXT',
    'ALTER TABLE agg_staging ADD COLUMN top_qty REAL',
    // 出荷実績（月別履歴）。法人×品目の平均単価と数量合計を参照用に持つ
    'ALTER TABLE deals ADD COLUMN hist_ent_cd TEXT',
    'ALTER TABLE deals ADD COLUMN hist_avg_price REAL',
    'ALTER TABLE deals ADD COLUMN hist_qty REAL',
    'ALTER TABLE deals ADD COLUMN master_qty REAL',
    'ALTER TABLE deals ADD COLUMN master_avg_price REAL',
    'ALTER TABLE deals ADD COLUMN hist_batch TEXT',
    // 適用年月と完了（案件一覧から営業担当者が入れる）
    'ALTER TABLE deals ADD COLUMN r2_applied_ym TEXT',
    'ALTER TABLE deals ADD COLUMN r2_done INTEGER NOT NULL DEFAULT 0',
    // 交渉履歴を法人単位にする
    'ALTER TABLE negotiation_logs ADD COLUMN corp_code TEXT',
    // 添付の実体を Vercel Blob（Privateストア）へ移す。
    // blob_url があればそちらが正、無ければ従来どおり content（base64）を読む。
    'ALTER TABLE attachments ADD COLUMN blob_url TEXT',
    // 価格調査（実単価）の受け皿。月の並びは settings の actual_meta に持つ
    // 価格調査から現状（1-3月出荷単価・売上数）も取り込むための集計列
    'ALTER TABLE act_staging ADD COLUMN base_amt REAL NOT NULL DEFAULT 0',
    'ALTER TABLE act_staging ADD COLUMN qty_sum REAL NOT NULL DEFAULT 0',
    'ALTER TABLE act_staging ADD COLUMN cost_amt REAL NOT NULL DEFAULT 0',
    // 価格調査だけで案件の行を作れるようにするための代表項目
    'ALTER TABLE act_staging ADD COLUMN corp_name TEXT',
    'ALTER TABLE act_staging ADD COLUMN customer_name TEXT',
    'ALTER TABLE act_staging ADD COLUMN model_name TEXT',
    'ALTER TABLE act_staging ADD COLUMN equip_name TEXT',
    'ALTER TABLE act_staging ADD COLUMN gas_type TEXT',
    'ALTER TABLE act_staging ADD COLUMN branch TEXT',
    'ALTER TABLE act_staging ADD COLUMN office TEXT',
    'ALTER TABLE act_staging ADD COLUMN sales_person TEXT',
    'ALTER TABLE act_staging ADD COLUMN top_qty REAL',
    'ALTER TABLE deals ADD COLUMN act_price_1 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_2 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_3 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_4 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_5 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_6 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_7 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_8 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_9 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_10 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_11 REAL',
    'ALTER TABLE deals ADD COLUMN act_price_12 REAL',
  ]) {
    await tryAlter(sql);
  }

  // 価格調査の枠として作った仮の列。実単価（act_price_*）に置き換えたので落とす。
  // 一度も値が入っていないため、消してもデータは失われない。
  // deal_calc が d.* でこの列を参照しているので、先にビューを落とす
  // （このあとスキーマ適用で作り直される）。
  try {
    await db.get('SELECT survey_price FROM deals LIMIT 1');   // 残っているDBでだけ成功する
    console.log('価格調査の仮の列を削除します（実単価へ移行）');
    try { await db.run('DROP VIEW IF EXISTS deal_calc'); } catch { /* 無ければよい */ }
    for (const col of ['survey_price', 'survey_qty']) {
      await tryAlter(`ALTER TABLE deals DROP COLUMN ${col}`);
    }
  } catch { /* 列が無い＝移行済みか新規DB。何もしない */ }

  // マスタ登録の列追加で deal_calc の列構成が変わる。CREATE OR REPLACE では
  // 途中への列の挿入ができないため、旧構成のビューだけ一度落として作り直す
  // （新しい列がまだビューに無い＝旧構成、のときだけ落とす）。
  try {
    await db.get('SELECT act_price_12 FROM deal_calc LIMIT 1');
  } catch {
    try { await db.run('DROP VIEW IF EXISTS deal_calc'); } catch { /* 無ければよい */ }
  }

  // 実体を Blob へ移した行では content が空になるため NOT NULL を外す。
  // SQLite は列制約の変更ができないので Postgres のときだけ実施する
  // （ローカル開発は従来どおり content に入れるため実害はない）。
  if (isPostgres) {
    await tryAlter('ALTER TABLE attachments ALTER COLUMN content DROP NOT NULL');

    // 役割に「開発者」を追加。既存DBはCHECK制約が古い一覧のままなので作り直す。
    // （SQLiteはCHECKを変更できないが、新規作成分は schema.sql が対応済み。
    //   既存のSQLite開発DBで必要になったら reset-db で作り直す）
    await tryAlter('ALTER TABLE users DROP CONSTRAINT users_role_check');
    await tryAlter(
      "ALTER TABLE users ADD CONSTRAINT users_role_check"
      + " CHECK (role IN ('sales','branch_manager','planning','admin','developer'))"
    );
  }
}

/** スキーマ適用後のデータ移行と後片付け */
async function migrate() {
  // 認証機能より前から居るユーザーはログインIDを持たないため補完する。
  // これが無いとログインもパスワード設定もできない状態になる。
  try {
    await db.run("UPDATE users SET login_id = 'user' || id WHERE login_id IS NULL OR login_id = ''");
  } catch (e) {
    console.warn(`マイグレーション警告: ログインIDを補完できませんでした → ${e.message}`);
  }

  try {
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_id ON users(login_id)');
  } catch (e) {
    console.warn(`マイグレーション警告: login_id の一意制約を作成できませんでした → ${e.message}`);
  }

  // 交渉履歴が案件単位だった頃の行を、案件の法人へ付け替える。
  // 付け替えないと、法人ごとの履歴から過去の記録が見えなくなる。
  try {
    await db.run(`
      UPDATE negotiation_logs SET corp_code =
        (SELECT d.corp_code FROM deals d WHERE d.id = negotiation_logs.deal_id)
       WHERE corp_code IS NULL`);
  } catch { /* deal_id 列が無い（新しいDB）場合は何もしない */ }
  try {
    await db.run('DELETE FROM negotiation_logs WHERE corp_code IS NULL');
  } catch (e) {
    console.warn(`マイグレーション警告: 法人が特定できない交渉履歴を整理できませんでした → ${e.message}`);
  }
  // 旧テーブルの deal_id は NOT NULL のため、残したままだと法人単位の記録が入らない。
  // 付け替えが済んだあとに列ごと落とす（索引が残っていると落とせないので先に消す）。
  try { await db.run('DROP INDEX IF EXISTS idx_logs_deal'); } catch { /* 無ければよい */ }
  try {
    await db.run('ALTER TABLE negotiation_logs DROP COLUMN deal_id');
  } catch (e) {
    if (!/no such column|does not exist|no column named/i.test(e?.message || '')) {
      console.warn(`マイグレーション警告: 交渉履歴の deal_id を削除できませんでした → ${e.message}`);
    }
  }

  // 妥結済みの明細は完了として引き継ぐ。
  // 引き継がないと、これまでの妥結がすべて未完了に見えてしまう。
  try {
    const { c } = await db.get('SELECT COUNT(*) AS c FROM deals WHERE r2_done = 1');
    if (Number(c) === 0) {
      await db.run(`
        UPDATE deals SET r2_done = 1
         WHERE r2_agreed_price IS NOT NULL AND r2_agreed_price > 0
           AND (r2_result_symbol LIKE '〇%' OR r2_result_symbol LIKE '○%' OR r2_result_symbol LIKE '◯%')`);
    }
  } catch (e) {
    console.warn(`マイグレーション警告: 完了を引き継げませんでした → ${e.message}`);
  }

  // 申請ワークフローの廃止にともない使わなくなったテーブルを片付ける。
  // 残しておくと、次にスキーマを読む人がまだ使われていると誤解する。
  const cascade = isPostgres ? ' CASCADE' : '';
  try { await db.run('DELETE FROM attachments WHERE application_id IS NOT NULL'); } catch { /* 列が無ければよい */ }
  for (const t of ['approvals', 'application_items', 'applications', 'approval_rules', 'notifications', 'targets']) {
    try {
      await db.run(`DROP TABLE IF EXISTS ${t}${cascade}`);
    } catch (e) {
      console.warn(`マイグレーション警告: ${t} を削除できませんでした → ${e.message}`);
    }
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

  await db.batch([
    { sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', params: ['branch_name', '東京中央'] },
  ]);
}

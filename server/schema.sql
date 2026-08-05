-- =============================================================
-- 値上げ単価 管理アプリ スキーマ
-- =============================================================

-- ※ PRAGMA（journal_mode / foreign_keys）は接続時に server/db.js で設定する。
--    Turso ではPRAGMAを受け付けないため、このファイルには含めない。

-- ユーザー（営業担当者 / 支店長 / 営業企画部 / 管理者）
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('sales','branch_manager','planning','admin','developer')),
  branch     TEXT,
  office     TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  login_id   TEXT,               -- ログインID（社内で一意）
  password_hash TEXT,            -- scrypt形式。NULLの間はログイン不可
  must_change_password INTEGER NOT NULL DEFAULT 0, -- 仮パスワードの初回変更を強制
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,             -- 連続失敗による一時ロックの解除時刻
  last_login_at TEXT
);

-- ※ login_id の一意インデックスは server/db.js の migrate() で作成する。
--    認証機能より前に作られたDBでは、この時点でまだ列が存在しないため。

-- ログインセッション
-- サーバーレスでは各リクエストが別プロセスになるため、セッションはDBで共有する
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,   -- ランダムトークン（Cookieに保存する値のハッシュ）
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ポータルからのSSOで使い終えたトークン。
-- 同じトークンを2回使えないようにするための記録で、
-- 有効期限（60秒）を過ぎた行は次回のSSO時にまとめて消す。
CREATE TABLE IF NOT EXISTS sso_used_tokens (
  jti        TEXT PRIMARY KEY,   -- トークンの識別子
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  used_at    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sso_expires ON sso_used_tokens(expires_at);

-- マスター単価種別（6種類）
CREATE TABLE IF NOT EXISTS price_types (
  code     INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,
  note     TEXT
);

-- Excel取込バッチ
CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT,
  row_count   INTEGER NOT NULL DEFAULT 0,
  imported_by INTEGER REFERENCES users(id),
  content_hash TEXT,  -- 同じファイルの二重取込を検知する
  data_hash    TEXT,  -- 再保存でバイト列が変わっても同じデータだと分かるようにする
  imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 案件明細（現行管理表の1行 = 1明細）
CREATE TABLE IF NOT EXISTS deals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER REFERENCES import_batches(id),
  sales_ym        TEXT,   -- A  売上年月
  corp_code       TEXT,   -- B  法人コード
  corp_name       TEXT,   -- C  法人名
  customer_code   TEXT,   -- D  得意先コード
  customer_name   TEXT,   -- E  得意先名
  delivery_code   TEXT,   -- F  納入先コード
  delivery_name   TEXT,   -- G  納入先名
  handler_code    TEXT,   -- H  扱い先コード
  handler_name    TEXT,   -- I  扱い先名
  industry        TEXT,   -- J  業種名
  equip_code      TEXT,   -- K  器具区分
  equip_name      TEXT,   -- L  器具区分名
  category_code   TEXT,   -- S  カテゴリーコード
  category_name   TEXT,   -- T  カテゴリー名
  model_code      TEXT,   -- U  器種コード
  gas_code        TEXT,   -- V  ガスコード
  model_name      TEXT,   -- W  器種名
  gas_type        TEXT,   -- X  ガス種
  qty             REAL,   -- Y  出荷数
  list_price      REAL,   -- Z  定価
  rate            REAL,   -- AA 掛け率
  base_price      REAL,   -- AB 出荷単価（❶ 値上げ前単価）
  ship_amount     REAL,   -- AF 出荷金額
  final_price     REAL,   -- AM 最終単価
  voucher_no      TEXT,   -- AP 売上伝票NO
  quote_no        TEXT,   -- AQ 見積伝票番号
  order_date      TEXT,   -- AR 受注日
  sales_date      TEXT,   -- AS 売上日
  branch          TEXT,   -- AT 売上担当者支店名
  office          TEXT,   -- AU 売上担当者営業所名
  sales_person    TEXT,   -- AV 売上担当者名
  customer_person TEXT,   -- AY 得意先担当者名
  new_list_price  REAL,   -- BQ 新定価
  kubun           TEXT,   -- 基準価格表の区分（大手 / 中規模 / 小規模）。担当者が選ぶ
  r2_target_price REAL,   -- ❷ 目標値上げ単価（列名の r2_ は旧・第2弾の名残）
  offer1_date     TEXT,   -- BW 1回目提示日
  offer1_rate     REAL,   -- BX 1回目提示率
  offer1_price    REAL,   -- BY 1回目提示単価
  r2_result_symbol TEXT,  -- CB 商談結果（記号入力）※「〇」で確定
  final_confirm_date TEXT,-- CC 最終確定日
  final_raise_date   TEXT,-- CD 最終確定値上日
  r2_ringi_no     TEXT,   -- CE 稟議NO
  final_rate      REAL,   -- CF 最終確定掛率
  r2_agreed_price REAL,   -- ❸ 合意単価（最終確定単価）
  price_type_code INTEGER REFERENCES price_types(code), -- マスター単価種別（6種）
  -- 弾ごとの進捗。営業担当者が案件一覧で合意単価と適用年月を入れ、弾ごとに完了にする
  r2_applied_ym   TEXT,   -- 値上げの適用年月（YYYY-MM）
  r2_done         INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_deals_customer ON deals(customer_code);
CREATE INDEX IF NOT EXISTS idx_deals_equip    ON deals(equip_name);
CREATE INDEX IF NOT EXISTS idx_deals_person   ON deals(sales_person);
CREATE INDEX IF NOT EXISTS idx_deals_corp     ON deals(corp_code);

-- 各種設定
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 法人ごとの交渉情報
-- 単価は器種ごとでも、交渉そのものは法人（本部）単位で進むため、
-- 交渉状況とメモは法人に紐づけて持つ。
CREATE TABLE IF NOT EXISTS corp_negotiations (
  corp_code    TEXT PRIMARY KEY,
  corp_name    TEXT,
  status       TEXT NOT NULL DEFAULT 'not_started',
    -- not_started / negotiating / agreed / declined
  contact_date TEXT,             -- 直近の商談日
  note         TEXT,             -- 交渉メモ
  updated_at   TEXT,
  updated_by   INTEGER REFERENCES users(id)
);

-- 交渉履歴（法人ごとに商談の経緯を時系列で残す）
CREATE TABLE IF NOT EXISTS negotiation_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  corp_code    TEXT NOT NULL,
  user_id      INTEGER REFERENCES users(id),
  contact_date TEXT,             -- 商談日
  channel      TEXT,             -- 訪問 / 電話 / メール / 本部商談 など
  result       TEXT,             -- 継続交渉 / 合意 / 保留 / 不可
  note         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_corp ON negotiation_logs(corp_code);

-- 添付ファイル（見積書・稟議書類など）
-- 実体は Vercel Blob の Private ストア（pf-project-private）に置く。
-- 見積書などの機密文書のため公開ストアは使わず、ダウンロードは必ず
-- アプリ経由で権限確認したうえでサーバーが中継する。
CREATE TABLE IF NOT EXISTS attachments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id        INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mime_type      TEXT,
  size           INTEGER,
  -- 実体は Vercel Blob（Privateストア）へ。blob_url があればそちらが正。
  -- content は Blob 移行前の既存行のために残す（新規保存では使わない）。
  content        TEXT,
  blob_url       TEXT,
  uploaded_by    INTEGER REFERENCES users(id),
  uploaded_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attach_deal ON attachments(deal_id);

-- 計算列ビュー
--   単価だけの管理表のため、台数を掛けた金額は扱わない。
--   ❹ r2_raise_unit = ❸合意単価 - ❶出荷単価
--   r2_state … 交渉の進み具合（未入力 / 合意済 / 完了）
--   列名の r2_ は旧・第2弾の名残（第1弾は廃止済み）
CREATE VIEW IF NOT EXISTS deal_calc AS
SELECT
  d.*,
  CASE WHEN d.r2_agreed_price IS NOT NULL AND d.base_price IS NOT NULL
       THEN d.r2_agreed_price - d.base_price END AS r2_raise_unit,
  -- 管理表では未交渉の行にも値上後単価に現行単価が入っているため、
  -- 「値が入っている」ではなく「実際に上がっている」を合意済みとみなす
  CASE WHEN d.r2_done = 1 THEN 'done'
       WHEN d.r2_agreed_price > d.base_price THEN 'agreed'
       ELSE 'open' END AS r2_state
FROM deals d;

-- 全国基準価格表（マスター）。器種 × 区分ごとの基準単価。
-- 案件で区分を選ぶと、この表の値上後単価が目標値上げ単価になる。
CREATE TABLE IF NOT EXISTS standard_prices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  region        TEXT NOT NULL DEFAULT '全国', -- 全国 / 北海道 など（地域シート）
  category      TEXT,           -- 【給湯器】などのまとまり
  model_gas_code TEXT,          -- 器種ガスコード（器種コード＋ガスコード）
  model_name    TEXT NOT NULL,  -- 品名
  model_key     TEXT NOT NULL,  -- 品名の正規化（案件との突き合わせ用）
  kubun         TEXT NOT NULL,  -- 大手 / 中規模 / 小規模
  kubun_note    TEXT,           -- 見出しの説明（例企業）
  current_price REAL,           -- 現単価（想定）
  target_price  REAL NOT NULL,  -- 値上後（これが目標になる）
  source_file   TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_std_model ON standard_prices(region, kubun, model_key);
CREATE INDEX IF NOT EXISTS idx_std_code  ON standard_prices(region, kubun, model_gas_code);

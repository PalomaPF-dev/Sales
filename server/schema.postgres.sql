-- =============================================================
-- 値上げ交渉・合意価格申請 管理アプリ スキーマ（PostgreSQL）
--
-- 既存の社内DBに相乗りする前提のため、専用スキーマに配置して
-- ポータル等の既存テーブル（users / sessions / accounts など）と
-- 名前が衝突しないようにする。スキーマ名は DB_SCHEMA で変更できる。
-- =============================================================

-- スキーマの作成と search_path の確認は server/db.js が接続時に行う。
-- ここで SET search_path を書くと、接続オプションが効いていないことに
-- 気づけなくなる（接続プーラー経由で起きうる）ため、あえて書かない。

-- ユーザー（営業担当者 / 支店長 / 営業企画部 / 管理者）
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('sales','branch_manager','planning','admin')),
  branch     TEXT,
  office     TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  login_id   TEXT,
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  -- 決裁権限。役割とは別に管理者が個別に付け外しできる
  can_approve_branch   INTEGER NOT NULL DEFAULT 0,
  can_approve_planning INTEGER NOT NULL DEFAULT 0,
  approve_branches     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_id ON users(login_id);

-- ログインセッション
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- マスター単価種別（6種類）
CREATE TABLE IF NOT EXISTS price_types (
  code     INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,
  note     TEXT
);

-- Excel取込バッチ
CREATE TABLE IF NOT EXISTS import_batches (
  id          SERIAL PRIMARY KEY,
  filename    TEXT,
  row_count   INTEGER NOT NULL DEFAULT 0,
  imported_by INTEGER REFERENCES users(id),
  content_hash TEXT,  -- 同じファイルの二重取込を検知する
  imported_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS')
);

-- 案件明細（現行管理表の1行 = 1明細）
CREATE TABLE IF NOT EXISTS deals (
  id              SERIAL PRIMARY KEY,
  batch_id        INTEGER REFERENCES import_batches(id),
  sales_ym        TEXT,
  corp_code       TEXT,
  corp_name       TEXT,
  customer_code   TEXT,
  customer_name   TEXT,
  delivery_code   TEXT,
  delivery_name   TEXT,
  handler_code    TEXT,
  handler_name    TEXT,
  industry        TEXT,
  equip_code      TEXT,
  equip_name      TEXT,
  category_code   TEXT,
  category_name   TEXT,
  model_code      TEXT,
  gas_code        TEXT,
  model_name      TEXT,
  gas_type        TEXT,
  qty             DOUBLE PRECISION,
  list_price      DOUBLE PRECISION,
  rate            DOUBLE PRECISION,
  base_price      DOUBLE PRECISION,   -- ❶ 出荷単価
  r1_target_rate  DOUBLE PRECISION,
  r1_target_price DOUBLE PRECISION,   -- ❷ 第1弾 目標値上げ単価
  ship_amount     DOUBLE PRECISION,
  final_price     DOUBLE PRECISION,
  voucher_no      TEXT,
  quote_no        TEXT,
  order_date      TEXT,
  sales_date      TEXT,
  branch          TEXT,
  office          TEXT,
  sales_person    TEXT,
  customer_person TEXT,
  negotiated_date TEXT,
  negotiation_note TEXT,
  r1_agreed_price DOUBLE PRECISION,   -- ❸ 値上後単価
  r1_raise_date   TEXT,
  r1_ringi_no     TEXT,
  new_list_price  DOUBLE PRECISION,
  r1_after_rate   DOUBLE PRECISION,
  r2_target_price DOUBLE PRECISION,   -- ❻ 第2弾 目標値上げ単価
  offer1_date     TEXT,
  offer1_rate     DOUBLE PRECISION,
  offer1_price    DOUBLE PRECISION,
  r2_result_symbol TEXT,
  final_confirm_date TEXT,
  final_raise_date   TEXT,
  r2_ringi_no     TEXT,
  final_rate      DOUBLE PRECISION,
  r2_agreed_price DOUBLE PRECISION,   -- ❼ 最終確定単価
  price_type_code INTEGER REFERENCES price_types(code),
  status          TEXT NOT NULL DEFAULT 'not_started',
  updated_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_deals_customer ON deals(customer_code);
CREATE INDEX IF NOT EXISTS idx_deals_equip    ON deals(equip_name);
CREATE INDEX IF NOT EXISTS idx_deals_person   ON deals(sales_person);
CREATE INDEX IF NOT EXISTS idx_deals_status   ON deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_branch   ON deals(branch, office);

-- 申請（合意価格の申請）
CREATE TABLE IF NOT EXISTS applications (
  id              SERIAL PRIMARY KEY,
  round           INTEGER NOT NULL CHECK (round IN (1,2)),
  title           TEXT,
  customer_code   TEXT,
  customer_name   TEXT,
  applicant_id    INTEGER NOT NULL REFERENCES users(id),
  branch          TEXT,
  office          TEXT,
  price_type_code INTEGER REFERENCES price_types(code),
  status          TEXT NOT NULL DEFAULT 'draft',
  route           TEXT,
  rule_name       TEXT,
  target_amount   DOUBLE PRECISION,
  agreed_amount   DOUBLE PRECISION,
  achievement_rate DOUBLE PRECISION,
  comment         TEXT,
  created_at      TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS'),
  updated_at      TEXT,
  decided_at      TEXT
);

CREATE TABLE IF NOT EXISTS application_items (
  id             SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  deal_id        INTEGER NOT NULL REFERENCES deals(id),
  base_price     DOUBLE PRECISION,
  target_price   DOUBLE PRECISION,
  agreed_price   DOUBLE PRECISION NOT NULL,
  qty            DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_items_app  ON application_items(application_id);
CREATE INDEX IF NOT EXISTS idx_items_deal ON application_items(deal_id);

-- 承認履歴
CREATE TABLE IF NOT EXISTS approvals (
  id             SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  step           TEXT NOT NULL,
  approver_id    INTEGER REFERENCES users(id),
  action         TEXT NOT NULL,
  comment        TEXT,
  acted_at       TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS')
);

-- 承認権限ルール
CREATE TABLE IF NOT EXISTS approval_rules (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  min_rate   DOUBLE PRECISION,
  max_rate   DOUBLE PRECISION,
  final_step TEXT NOT NULL CHECK (final_step IN ('branch','planning')),
  priority   INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

-- 各種設定
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 交渉履歴
CREATE TABLE IF NOT EXISTS negotiation_logs (
  id           SERIAL PRIMARY KEY,
  deal_id      INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id),
  contact_date TEXT,
  channel      TEXT,
  proposed_price DOUBLE PRECISION,
  result       TEXT,
  note         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_deal ON negotiation_logs(deal_id);

-- 添付ファイル
CREATE TABLE IF NOT EXISTS attachments (
  id             SERIAL PRIMARY KEY,
  deal_id        INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mime_type      TEXT,
  size           INTEGER,
  content        TEXT NOT NULL,
  uploaded_by    INTEGER REFERENCES users(id),
  uploaded_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attach_deal ON attachments(deal_id);
CREATE INDEX IF NOT EXISTS idx_attach_app  ON attachments(application_id);

-- アプリ内通知
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

-- 値上げ目標（支店 / 営業所 / 担当者の単位）
CREATE TABLE IF NOT EXISTS targets (
  id          SERIAL PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('branch','office','person')),
  scope_value TEXT NOT NULL,
  round       INTEGER NOT NULL CHECK (round IN (1,2)),
  amount      DOUBLE PRECISION NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_key ON targets(scope, scope_value, round);

-- 計算列ビュー（Excelの意味合いを再現）
--   ❹ = ❸ - ❶ / ❺ = ❹ × 台数 / ❽ = ❼ - ❸ / ❾ = ❽ × 台数
CREATE OR REPLACE VIEW deal_calc AS
SELECT
  d.*,
  CASE WHEN d.r1_agreed_price IS NOT NULL AND d.base_price IS NOT NULL
       THEN d.r1_agreed_price - d.base_price ELSE 0 END AS r1_raise_unit,
  (CASE WHEN d.r1_agreed_price IS NOT NULL AND d.base_price IS NOT NULL
        THEN d.r1_agreed_price - d.base_price ELSE 0 END) * COALESCE(d.qty, 0) AS r1_raise_amount,
  CASE WHEN (d.r2_result_symbol LIKE '〇%' OR d.r2_result_symbol LIKE '○%' OR d.r2_result_symbol LIKE '◯%')
            AND COALESCE(d.r2_agreed_price, 0) > 0
       THEN d.r2_agreed_price - COALESCE(d.r1_agreed_price, d.base_price, 0) ELSE 0 END AS r2_raise_unit,
  (CASE WHEN (d.r2_result_symbol LIKE '〇%' OR d.r2_result_symbol LIKE '○%' OR d.r2_result_symbol LIKE '◯%')
             AND COALESCE(d.r2_agreed_price, 0) > 0
        THEN d.r2_agreed_price - COALESCE(d.r1_agreed_price, d.base_price, 0) ELSE 0 END) * COALESCE(d.qty, 0) AS r2_raise_amount,
  COALESCE(d.r1_target_price - d.base_price, 0) * COALESCE(d.qty, 0) AS r1_target_amount,
  COALESCE(d.r2_target_price - COALESCE(d.r1_agreed_price, d.base_price), 0) * COALESCE(d.qty, 0) AS r2_target_amount
FROM deals d;

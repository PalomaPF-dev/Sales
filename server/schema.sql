-- =============================================================
-- 値上げ交渉・合意価格申請 管理アプリ スキーマ
-- =============================================================

-- ※ PRAGMA（journal_mode / foreign_keys）は接続時に server/db.js で設定する。
--    Turso ではPRAGMAを受け付けないため、このファイルには含めない。

-- ユーザー（営業担当者 / 支店長 / 営業企画部 / 管理者）
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('sales','branch_manager','planning','admin')),
  branch     TEXT,
  office     TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  login_id   TEXT,               -- ログインID（社内で一意）
  password_hash TEXT,            -- scrypt形式。NULLの間はログイン不可
  must_change_password INTEGER NOT NULL DEFAULT 0, -- 仮パスワードの初回変更を強制
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,             -- 連続失敗による一時ロックの解除時刻
  last_login_at TEXT,
  -- 決裁権限。役割とは別に管理者が個別に付け外しできる
  can_approve_branch   INTEGER NOT NULL DEFAULT 0,  -- 支店長決裁ができる
  can_approve_planning INTEGER NOT NULL DEFAULT 0,  -- 営業企画部決裁ができる
  approve_branches     TEXT     -- 決裁できる支店（カンマ区切り。空なら所属支店のみ）
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
  r1_target_rate  REAL,   -- AC 新値上げ後掛け率
  r1_target_price REAL,   -- AD 新出荷単価（❷ 第1弾 目標値上げ単価）
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
  negotiated_date TEXT,   -- BJ 確定商談日
  negotiation_note TEXT,  -- BK 商談結果
  r1_agreed_price REAL,   -- BL 値上後単価（❸ 第1弾 妥結単価）
  r1_raise_date   TEXT,   -- BM 値上日時
  r1_ringi_no     TEXT,   -- BN 稟議NO
  new_list_price  REAL,   -- BQ 新定価
  r1_after_rate   REAL,   -- BR 第1弾値上げ後掛率
  r2_target_price REAL,   -- BS 第2弾新値上げ単価（❻ 第2弾 目標値上げ単価）
  offer1_date     TEXT,   -- BW 1回目提示日
  offer1_rate     REAL,   -- BX 1回目提示率
  offer1_price    REAL,   -- BY 1回目提示単価
  r2_result_symbol TEXT,  -- CB 商談結果（記号入力）※「〇」で第2弾確定
  final_confirm_date TEXT,-- CC 最終確定日
  final_raise_date   TEXT,-- CD 最終確定値上日
  r2_ringi_no     TEXT,   -- CE 第2弾稟議NO
  final_rate      REAL,   -- CF 最終確定掛率
  r2_agreed_price REAL,   -- CG 最終確定単価（❼ 第2弾 妥結単価）
  price_type_code INTEGER REFERENCES price_types(code), -- マスター単価種別（6種）
  status          TEXT NOT NULL DEFAULT 'not_started',
    -- not_started / negotiating / r1_agreed / r2_negotiating / r2_agreed / declined
  updated_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_deals_customer ON deals(customer_code);
CREATE INDEX IF NOT EXISTS idx_deals_equip    ON deals(equip_name);
CREATE INDEX IF NOT EXISTS idx_deals_person   ON deals(sales_person);
CREATE INDEX IF NOT EXISTS idx_deals_status   ON deals(status);

-- 申請（合意価格の申請）
CREATE TABLE IF NOT EXISTS applications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round           INTEGER NOT NULL CHECK (round IN (1,2)),
  title           TEXT,
  customer_code   TEXT,
  customer_name   TEXT,
  applicant_id    INTEGER NOT NULL REFERENCES users(id),
  branch          TEXT,
  office          TEXT,
  price_type_code INTEGER REFERENCES price_types(code),
  status          TEXT NOT NULL DEFAULT 'draft',
    -- draft / pending_branch / pending_planning / approved / rejected / withdrawn
  route           TEXT,   -- 'branch'（支店長決裁で完結） / 'planning'（営業企画部決裁まで）
  rule_name       TEXT,   -- 適用された承認ルール名
  target_amount   REAL,   -- 目標値上金額 Σ(目標単価-基準単価)×台数
  agreed_amount   REAL,   -- 申請値上金額 Σ(合意単価-基準単価)×台数
  achievement_rate REAL,  -- 達成率(%)
  comment         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT,
  decided_at      TEXT
);

CREATE TABLE IF NOT EXISTS application_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  deal_id        INTEGER NOT NULL REFERENCES deals(id),
  base_price     REAL,  -- 基準単価（第1弾: 出荷単価❶ / 第2弾: 値上後単価❸）
  target_price   REAL,  -- 目標単価（第1弾: ❷ / 第2弾: ❻）
  agreed_price   REAL NOT NULL,  -- 合意単価
  qty            REAL
);

-- 承認履歴
CREATE TABLE IF NOT EXISTS approvals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  step           TEXT NOT NULL,   -- 'branch' | 'planning'
  approver_id    INTEGER REFERENCES users(id),
  action         TEXT NOT NULL,   -- 'approved' | 'rejected'
  comment        TEXT,
  acted_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 承認権限ルール（達成率で承認ルートを判定・別途設定可能）
CREATE TABLE IF NOT EXISTS approval_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  min_rate   REAL,   -- 達成率下限（この値以上, NULLは下限なし）
  max_rate   REAL,   -- 達成率上限（この値未満, NULLは上限なし）
  final_step TEXT NOT NULL CHECK (final_step IN ('branch','planning')),
  priority   INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

-- 各種設定（支店目標金額など）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 交渉履歴（商談の経緯を時系列で残す）
CREATE TABLE IF NOT EXISTS negotiation_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id      INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id),
  contact_date TEXT,             -- 商談日
  channel      TEXT,             -- 訪問 / 電話 / メール / 本部商談 など
  proposed_price REAL,           -- その場で提示した単価
  result       TEXT,             -- 継続交渉 / 合意 / 保留 / 不可
  note         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_deal ON negotiation_logs(deal_id);

-- 添付ファイル（見積書・稟議書類など）
-- 外部ストレージを増やさずに済むよう、実体はbase64でDBに保存する
CREATE TABLE IF NOT EXISTS attachments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,   -- submitted / approved / rejected / forwarded
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,            -- 画面内のリンク先（例: /applications/12）
  read_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

-- 値上げ目標（支店 / 営業所 / 担当者の単位で設定）
CREATE TABLE IF NOT EXISTS targets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL CHECK (scope IN ('branch','office','person')),
  scope_value TEXT NOT NULL,
  round       INTEGER NOT NULL CHECK (round IN (1,2)),
  amount      REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_key ON targets(scope, scope_value, round);

-- 計算列ビュー（Excelの意味合いを再現）
--   ❹ r1_raise_unit   = ❸値上後単価 - ❶出荷単価         (BO列)
--   ❺ r1_raise_amount = ❹ × 台数                          (BP列)
--   ❽ r2_raise_unit   = ❼最終確定単価 - ❸値上後単価      (CH列, CB列が〇のとき有効)
--   ❾ r2_raise_amount = ❽ × 台数                          (CI列)
--   ❺+❾ = 値上げ金額総数
CREATE VIEW IF NOT EXISTS deal_calc AS
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

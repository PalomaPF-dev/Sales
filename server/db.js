import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

export function seedMasters() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM price_types').get().c;
  if (count === 0) {
    const ins = db.prepare(
      'INSERT INTO price_types (code, name, category, note) VALUES (?,?,?,?)'
    );
    // 添付資料「単価（標準単価）」の6種類
    ins.run(1, '取引先G商品G', '標準', '取引先グループ×商品グループ。掛率で登録');
    ins.run(2, '取引先G商品', '標準', '取引先グループ×商品（商品毎の価格対応）');
    ins.run(3, '取引先商品G', '標準', '取引先×商品グループ（エリア毎の価格対応）');
    ins.run(4, '取引先商品', '標準', '取引先×商品');
    ins.run(5, '納入先別単価', '販売店対応', '販売先と納入先が設定される');
    ins.run(6, '見積伝票', '物件対応', '販売先と納入先が設定される（物件単位）');
  }

  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (users === 0) {
    const ins = db.prepare(
      'INSERT INTO users (name, role, branch, office) VALUES (?,?,?,?)'
    );
    ins.run('営業 太郎', 'sales', '東京中央', '東京中央営業所');
    ins.run('営業 花子', 'sales', '東京中央', '東京中央営業所');
    ins.run('支店長 一郎', 'branch_manager', '東京中央', null);
    ins.run('企画 次郎', 'planning', '本社', '営業企画部');
    ins.run('管理者', 'admin', '本社', null);
  }

  const rules = db.prepare('SELECT COUNT(*) AS c FROM approval_rules').get().c;
  if (rules === 0) {
    const ins = db.prepare(
      'INSERT INTO approval_rules (name, min_rate, max_rate, final_step, priority) VALUES (?,?,?,?,?)'
    );
    // 既定: 目標達成（100%以上）なら支店長決裁で完結、未達なら営業企画部決裁まで
    ins.run('目標達成（達成率100%以上）→ 支店長決裁', 100, null, 'branch', 1);
    ins.run('目標未達（達成率100%未満）→ 営業企画部決裁', null, 100, 'planning', 2);
  }

  const set = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)'
  );
  set.run('r1_target_total', '5042350');   // 第1弾 支店値上げ目標金額（管理表より）
  set.run('r2_target_total', '8622667');   // 第2弾 支店値上げ目標金額（管理表より）
  set.run('branch_name', '東京中央');
}

seedMasters();

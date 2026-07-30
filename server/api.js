import { Router } from 'express';
import multer from 'multer';
import { db } from './db.js';
import { importWorkbook } from './importer.js';

export const api = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const nv = (v) => (v === undefined ? null : v);
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

// ---- 認証（プロトタイプ: x-user-id ヘッダー。実運用ではSSO等に置換） ----
api.use((req, res, next) => {
  const uid = Number(req.header('x-user-id'));
  req.user = uid ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(uid) : null;
  next();
});

function requireLogin(req, res) {
  if (!req.user) {
    res.status(401).json({ error: 'ログインしてください' });
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

// ---- ユーザー / メタ情報 ----
api.get('/users', (req, res) => {
  res.json(db.prepare('SELECT id, name, role, branch, office FROM users WHERE active = 1 ORDER BY id').all());
});

api.get('/meta', (req, res) => {
  res.json({
    priceTypes: db.prepare('SELECT * FROM price_types ORDER BY code').all(),
    equips: db.prepare('SELECT equip_name AS name, COUNT(*) AS count FROM deals WHERE equip_name IS NOT NULL GROUP BY equip_name ORDER BY count DESC').all(),
    persons: db.prepare('SELECT sales_person AS name, COUNT(*) AS count FROM deals WHERE sales_person IS NOT NULL GROUP BY sales_person ORDER BY count DESC').all(),
    customers: db.prepare('SELECT customer_code AS code, customer_name AS name, COUNT(*) AS count FROM deals WHERE customer_code IS NOT NULL GROUP BY customer_code, customer_name ORDER BY count DESC LIMIT 500').all(),
    statuses: [
      { code: 'not_started', name: '未着手' },
      { code: 'negotiating', name: '交渉中' },
      { code: 'r1_agreed', name: '第1弾妥結' },
      { code: 'r2_negotiating', name: '第2弾交渉中' },
      { code: 'r2_agreed', name: '第2弾妥結' },
      { code: 'declined', name: '値上げ不可' },
    ],
  });
});

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
  ]) {
    if (q[key]) { where.push(`${col} = ?`); params.push(q[key]); }
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

api.get('/deals', (req, res) => {
  const { where, params } = dealFilters(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Number(req.query.size) || 50);
  const totals = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
           COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
           COALESCE(SUM(r1_target_amount), 0) AS r1_target,
           COALESCE(SUM(r2_target_amount), 0) AS r2_target
    FROM deal_calc ${where}`).get(...params);
  const rows = db.prepare(`
    SELECT * FROM deal_calc ${where}
    ORDER BY customer_name, equip_name, model_name, id
    LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
  res.json({ rows, totals, page, size });
});

api.get('/deals/summary', (req, res) => {
  const group = { customer: 'customer_code, customer_name', equip: 'equip_name', person: 'sales_person' }[req.query.group] || 'customer_code, customer_name';
  const { where, params } = dealFilters(req.query);
  const rows = db.prepare(`
    SELECT ${group}, COUNT(*) AS deals, COALESCE(SUM(qty),0) AS qty,
           COALESCE(SUM(r1_raise_amount),0) AS r1_amount,
           COALESCE(SUM(r2_raise_amount),0) AS r2_amount,
           COALESCE(SUM(r1_raise_amount),0) + COALESCE(SUM(r2_raise_amount),0) AS total_amount,
           COALESCE(SUM(r1_target_amount),0) AS r1_target,
           COALESCE(SUM(r2_target_amount),0) AS r2_target
    FROM deal_calc ${where}
    GROUP BY ${group} ORDER BY total_amount DESC`).all(...params);
  res.json(rows);
});

api.get('/deals/:id', (req, res) => {
  const deal = db.prepare('SELECT * FROM deal_calc WHERE id = ?').get(req.params.id);
  if (!deal) return res.status(404).json({ error: '案件が見つかりません' });
  const apps = db.prepare(`
    SELECT a.id, a.round, a.status, a.achievement_rate, a.route, a.created_at, i.agreed_price
    FROM application_items i JOIN applications a ON a.id = i.application_id
    WHERE i.deal_id = ? ORDER BY a.id DESC`).all(req.params.id);
  res.json({ deal, applications: apps });
});

const EDITABLE = ['status', 'negotiation_note', 'negotiated_date', 'price_type_code',
  'offer1_date', 'offer1_rate', 'offer1_price', 'r2_result_symbol'];

api.patch('/deals/:id', (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager', 'planning'])) return;
  const sets = [];
  const params = [];
  for (const f of EDITABLE) {
    if (f in req.body) { sets.push(`${f} = ?`); params.push(nv(req.body[f])); }
  }
  if (!sets.length) return res.status(400).json({ error: '更新項目がありません' });
  sets.push('updated_at = ?');
  params.push(now(), req.params.id);
  db.prepare(`UPDATE deals SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM deal_calc WHERE id = ?').get(req.params.id));
});

// ---- 承認ルート判定 ----
function determineRoute(rate) {
  const rules = db.prepare('SELECT * FROM approval_rules WHERE active = 1 ORDER BY priority, id').all();
  for (const r of rules) {
    if (r.min_rate != null && rate < r.min_rate) continue;
    if (r.max_rate != null && rate >= r.max_rate) continue;
    return { route: r.final_step, ruleName: r.name };
  }
  return { route: 'planning', ruleName: '既定（該当ルールなし→営業企画部決裁）' };
}

function computeAppTotals(appId) {
  return db.prepare(`
    SELECT COALESCE(SUM((target_price - base_price) * qty), 0) AS target_amount,
           COALESCE(SUM((agreed_price - base_price) * qty), 0) AS agreed_amount
    FROM application_items WHERE application_id = ?`).get(appId);
}

// ---- 申請（applications） ----
api.post('/applications', (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager'])) return;
  const { round, items, price_type_code, title, comment } = req.body;
  if (![1, 2].includes(round)) return res.status(400).json({ error: 'round は 1 または 2 を指定してください' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '対象明細を選択してください' });

  const deals = items.map((it) => {
    const d = db.prepare('SELECT * FROM deals WHERE id = ?').get(it.deal_id);
    return d ? { deal: d, agreed: Number(it.agreed_price) } : null;
  });
  if (deals.some((x) => !x || !Number.isFinite(x.agreed))) {
    return res.status(400).json({ error: '明細または合意単価が不正です' });
  }
  const customers = new Set(deals.map((x) => x.deal.customer_code));
  if (customers.size > 1) return res.status(400).json({ error: '申請は同一の得意先単位で作成してください' });

  // 同一明細・同一弾の進行中申請の重複を防止
  const dup = db.prepare(`
    SELECT COUNT(*) AS c FROM application_items i
    JOIN applications a ON a.id = i.application_id
    WHERE a.round = ? AND a.status IN ('draft','pending_branch','pending_planning','approved')
      AND i.deal_id IN (${deals.map(() => '?').join(',')})`)
    .get(round, ...deals.map((x) => x.deal.id)).c;
  if (dup > 0) return res.status(409).json({ error: '選択明細に進行中または承認済みの申請が既に存在します' });

  const d0 = deals[0].deal;
  const appId = db.prepare(`
    INSERT INTO applications (round, title, customer_code, customer_name, applicant_id, branch, office, price_type_code, comment, status)
    VALUES (?,?,?,?,?,?,?,?,?,'draft')`)
    .run(round, nv(title) || `${d0.customer_name} 第${round}弾 値上げ申請`, d0.customer_code, d0.customer_name,
      req.user.id, req.user.branch, req.user.office, nv(price_type_code) ?? d0.price_type_code, nv(comment)).lastInsertRowid;

  const insItem = db.prepare(`
    INSERT INTO application_items (application_id, deal_id, base_price, target_price, agreed_price, qty)
    VALUES (?,?,?,?,?,?)`);
  for (const { deal, agreed } of deals) {
    // 基準単価: 第1弾は❶出荷単価、第2弾は❸値上後単価（未妥結なら出荷単価）
    const base = round === 1 ? deal.base_price : (deal.r1_agreed_price ?? deal.base_price);
    const target = round === 1 ? deal.r1_target_price : deal.r2_target_price;
    insItem.run(appId, deal.id, nv(base), nv(target), agreed, nv(deal.qty));
  }
  const t = computeAppTotals(appId);
  const rate = t.target_amount > 0 ? Math.round((t.agreed_amount / t.target_amount) * 1000) / 10 : 100;
  db.prepare('UPDATE applications SET target_amount = ?, agreed_amount = ?, achievement_rate = ?, updated_at = ? WHERE id = ?')
    .run(t.target_amount, t.agreed_amount, rate, now(), appId);
  res.status(201).json(getApplication(appId));
});

function getApplication(id) {
  const app = db.prepare(`
    SELECT a.*, u.name AS applicant_name, p.name AS price_type_name, p.category AS price_type_category
    FROM applications a
    LEFT JOIN users u ON u.id = a.applicant_id
    LEFT JOIN price_types p ON p.code = a.price_type_code
    WHERE a.id = ?`).get(id);
  if (!app) return null;
  app.items = db.prepare(`
    SELECT i.*, d.customer_name, d.model_name, d.equip_name, d.gas_type, d.sales_ym, d.delivery_name
    FROM application_items i JOIN deals d ON d.id = i.deal_id
    WHERE i.application_id = ? ORDER BY i.id`).all(id);
  app.approvals = db.prepare(`
    SELECT ap.*, u.name AS approver_name FROM approvals ap
    LEFT JOIN users u ON u.id = ap.approver_id
    WHERE ap.application_id = ? ORDER BY ap.id`).all(id);
  return app;
}

api.get('/applications', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('a.status = ?'); params.push(req.query.status); }
  if (req.query.mine === '1' && req.user) { where.push('a.applicant_id = ?'); params.push(req.user.id); }
  if (req.query.inbox === '1' && req.user) {
    // 承認箱: 自分の役割で承認待ちのもの
    if (req.user.role === 'branch_manager') { where.push("a.status = 'pending_branch' AND a.branch = ?"); params.push(req.user.branch); }
    else if (req.user.role === 'planning') { where.push("a.status = 'pending_planning'"); }
    else if (req.user.role === 'admin') { where.push("a.status IN ('pending_branch','pending_planning')"); }
    else { where.push('1 = 0'); }
  }
  const rows = db.prepare(`
    SELECT a.*, u.name AS applicant_name, p.name AS price_type_name,
           (SELECT COUNT(*) FROM application_items i WHERE i.application_id = a.id) AS item_count
    FROM applications a
    LEFT JOIN users u ON u.id = a.applicant_id
    LEFT JOIN price_types p ON p.code = a.price_type_code
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT 300`).all(...params);
  res.json(rows);
});

api.get('/applications/:id', (req, res) => {
  const app = getApplication(req.params.id);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  res.json(app);
});

api.post('/applications/:id/submit', (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager'])) return;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  if (!['draft', 'rejected'].includes(app.status)) return res.status(400).json({ error: 'この申請は提出できません' });
  if (app.applicant_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '申請者本人のみ提出できます' });
  }
  // 提出時点のルールで承認ルートを判定（達成率により承認権限が変わる）
  const { route, ruleName } = determineRoute(app.achievement_rate ?? 0);
  db.prepare("UPDATE applications SET status = 'pending_branch', route = ?, rule_name = ?, updated_at = ? WHERE id = ?")
    .run(route, ruleName, now(), app.id);
  res.json(getApplication(app.id));
});

// 承認時に妥結単価を案件へ反映（目標値上げ単価がマスター単価となる）
function applyToDeals(app) {
  const items = db.prepare('SELECT * FROM application_items WHERE application_id = ?').all(app.id);
  const ringi = `APP-${app.id}`;
  for (const it of items) {
    if (app.round === 1) {
      db.prepare(`
        UPDATE deals SET r1_agreed_price = ?, r1_ringi_no = ?, r1_raise_date = ?,
          price_type_code = COALESCE(?, price_type_code),
          status = CASE WHEN ? > COALESCE(base_price, 0) THEN 'r1_agreed' ELSE status END,
          updated_at = ?
        WHERE id = ?`)
        .run(it.agreed_price, ringi, today(), nv(app.price_type_code), it.agreed_price, now(), it.deal_id);
    } else {
      db.prepare(`
        UPDATE deals SET r2_agreed_price = ?, r2_ringi_no = ?, r2_result_symbol = '〇',
          final_confirm_date = ?, final_raise_date = ?,
          price_type_code = COALESCE(?, price_type_code),
          status = 'r2_agreed', updated_at = ?
        WHERE id = ?`)
        .run(it.agreed_price, ringi, today(), today(), nv(app.price_type_code), now(), it.deal_id);
    }
  }
}

api.post('/applications/:id/approve', (req, res) => {
  if (!requireLogin(req, res)) return;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });

  let step;
  if (app.status === 'pending_branch') {
    step = 'branch';
    const ok = req.user.role === 'admin' ||
      (req.user.role === 'branch_manager' && req.user.branch === app.branch);
    if (!ok) return res.status(403).json({ error: '支店長（同一支店）のみ承認できます' });
  } else if (app.status === 'pending_planning') {
    step = 'planning';
    if (!['planning', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '営業企画部のみ承認できます' });
    }
  } else {
    return res.status(400).json({ error: '承認待ちの申請ではありません' });
  }

  db.prepare('INSERT INTO approvals (application_id, step, approver_id, action, comment) VALUES (?,?,?,?,?)')
    .run(app.id, step, req.user.id, 'approved', nv(req.body?.comment));

  if (step === 'branch' && app.route === 'planning') {
    db.prepare("UPDATE applications SET status = 'pending_planning', updated_at = ? WHERE id = ?").run(now(), app.id);
  } else {
    db.prepare("UPDATE applications SET status = 'approved', decided_at = ?, updated_at = ? WHERE id = ?")
      .run(now(), now(), app.id);
    applyToDeals(app);
  }
  res.json(getApplication(app.id));
});

api.post('/applications/:id/reject', (req, res) => {
  if (!requireLogin(req, res)) return;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  let step;
  if (app.status === 'pending_branch') {
    step = 'branch';
    const ok = req.user.role === 'admin' ||
      (req.user.role === 'branch_manager' && req.user.branch === app.branch);
    if (!ok) return res.status(403).json({ error: '支店長（同一支店）のみ差戻しできます' });
  } else if (app.status === 'pending_planning') {
    step = 'planning';
    if (!['planning', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '営業企画部のみ差戻しできます' });
    }
  } else {
    return res.status(400).json({ error: '承認待ちの申請ではありません' });
  }
  db.prepare('INSERT INTO approvals (application_id, step, approver_id, action, comment) VALUES (?,?,?,?,?)')
    .run(app.id, step, req.user.id, 'rejected', nv(req.body?.comment));
  db.prepare("UPDATE applications SET status = 'rejected', updated_at = ? WHERE id = ?").run(now(), app.id);
  res.json(getApplication(app.id));
});

api.post('/applications/:id/withdraw', (req, res) => {
  if (!requireLogin(req, res)) return;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  if (app.applicant_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '申請者本人のみ取下げできます' });
  }
  if (!['draft', 'pending_branch', 'pending_planning', 'rejected'].includes(app.status)) {
    return res.status(400).json({ error: 'この申請は取下げできません' });
  }
  db.prepare("UPDATE applications SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(now(), app.id);
  res.json(getApplication(app.id));
});

// ---- 承認ルール（別途設定可能） ----
api.get('/rules', (req, res) => {
  res.json(db.prepare('SELECT * FROM approval_rules ORDER BY priority, id').all());
});

api.put('/rules', (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const rules = req.body;
  if (!Array.isArray(rules)) return res.status(400).json({ error: 'ルールの配列を指定してください' });
  for (const r of rules) {
    if (!['branch', 'planning'].includes(r.final_step)) {
      return res.status(400).json({ error: 'final_step は branch / planning のいずれかです' });
    }
  }
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM approval_rules');
    const ins = db.prepare('INSERT INTO approval_rules (name, min_rate, max_rate, final_step, priority, active) VALUES (?,?,?,?,?,?)');
    rules.forEach((r, i) => ins.run(nv(r.name) || `ルール${i + 1}`, nv(r.min_rate), nv(r.max_rate), r.final_step, i + 1, r.active === false ? 0 : 1));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json(db.prepare('SELECT * FROM approval_rules ORDER BY priority, id').all());
});

// ---- 設定（目標金額など） ----
api.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

api.put('/settings', (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(req.body || {})) up.run(k, String(v));
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

// ---- ダッシュボード ----
api.get('/dashboard', (req, res) => {
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  const totals = db.prepare(`
    SELECT COUNT(*) AS deals,
           COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
           COALESCE(SUM(r2_raise_amount), 0) AS r2_amount
    FROM deal_calc`).get();
  const byEquip = db.prepare(`
    SELECT equip_name, COUNT(*) AS deals,
           COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
           COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
           COALESCE(SUM(r1_raise_amount), 0) + COALESCE(SUM(r2_raise_amount), 0) AS total_amount
    FROM deal_calc WHERE equip_name IS NOT NULL
    GROUP BY equip_name ORDER BY total_amount DESC`).all();
  const byPerson = db.prepare(`
    SELECT sales_person, COUNT(*) AS deals,
           COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
           COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
           COALESCE(SUM(r1_raise_amount), 0) + COALESCE(SUM(r2_raise_amount), 0) AS total_amount
    FROM deal_calc WHERE sales_person IS NOT NULL
    GROUP BY sales_person ORDER BY total_amount DESC`).all();
  const statusCounts = db.prepare('SELECT status, COUNT(*) AS count FROM deals GROUP BY status').all();
  const appCounts = db.prepare('SELECT status, COUNT(*) AS count FROM applications GROUP BY status').all();
  res.json({
    targets: {
      r1: Number(settings.r1_target_total || 0),
      r2: Number(settings.r2_target_total || 0),
    },
    progress: { r1: totals.r1_amount, r2: totals.r2_amount, deals: totals.deals },
    byEquip, byPerson, statusCounts, appCounts,
  });
});

// ---- Excel取込 ----
api.post('/import', upload.single('file'), (req, res) => {
  if (!requireLogin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'ファイルを選択してください' });
  try {
    const result = importWorkbook(req.file.buffer, req.file.originalname, req.user.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

api.get('/import/batches', (req, res) => {
  res.json(db.prepare(`
    SELECT b.*, u.name AS imported_by_name FROM import_batches b
    LEFT JOIN users u ON u.id = b.imported_by
    ORDER BY b.id DESC LIMIT 50`).all());
});

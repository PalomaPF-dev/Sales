import { Router } from 'express';
import multer from 'multer';
import { db, initDb } from './db.js';
import { importWorkbook } from './importer.js';

export const api = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const nv = (v) => (v === undefined ? null : v);
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (v == null ? 0 : Number(v));

// 非同期ハンドラのエラーをExpressのエラーハンドラへ渡す
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- 認証（プロトタイプ: x-user-id ヘッダー。実運用ではSSO等に置換） ----
api.use(wrap(async (req, res, next) => {
  await initDb();
  const uid = Number(req.header('x-user-id'));
  req.user = uid
    ? await db.get('SELECT * FROM users WHERE id = ? AND active = 1', [uid])
    : null;
  next();
}));

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
api.get('/users', wrap(async (req, res) => {
  res.json(await db.all('SELECT id, name, role, branch, office FROM users WHERE active = 1 ORDER BY id'));
}));

api.get('/meta', wrap(async (req, res) => {
  const [priceTypes, equips, persons, customers] = await Promise.all([
    db.all('SELECT * FROM price_types ORDER BY code'),
    db.all('SELECT equip_name AS name, COUNT(*) AS count FROM deals WHERE equip_name IS NOT NULL GROUP BY equip_name ORDER BY count DESC'),
    db.all('SELECT sales_person AS name, COUNT(*) AS count FROM deals WHERE sales_person IS NOT NULL GROUP BY sales_person ORDER BY count DESC'),
    db.all('SELECT customer_code AS code, customer_name AS name, COUNT(*) AS count FROM deals WHERE customer_code IS NOT NULL GROUP BY customer_code, customer_name ORDER BY count DESC LIMIT 500'),
  ]);
  res.json({
    priceTypes, equips, persons, customers,
    statuses: [
      { code: 'not_started', name: '未着手' },
      { code: 'negotiating', name: '交渉中' },
      { code: 'r1_agreed', name: '第1弾妥結' },
      { code: 'r2_negotiating', name: '第2弾交渉中' },
      { code: 'r2_agreed', name: '第2弾妥結' },
      { code: 'declined', name: '値上げ不可' },
    ],
  });
}));

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

api.get('/deals', wrap(async (req, res) => {
  const { where, params } = dealFilters(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Number(req.query.size) || 50);
  const [totals, rows] = await Promise.all([
    db.get(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
             COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
             COALESCE(SUM(r1_target_amount), 0) AS r1_target,
             COALESCE(SUM(r2_target_amount), 0) AS r2_target
      FROM deal_calc ${where}`, params),
    db.all(`
      SELECT * FROM deal_calc ${where}
      ORDER BY customer_name, equip_name, model_name, id
      LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]),
  ]);
  res.json({ rows, totals, page, size });
}));

api.get('/deals/summary', wrap(async (req, res) => {
  const group = { customer: 'customer_code, customer_name', equip: 'equip_name', person: 'sales_person' }[req.query.group] || 'customer_code, customer_name';
  const { where, params } = dealFilters(req.query);
  const rows = await db.all(`
    SELECT ${group}, COUNT(*) AS deals, COALESCE(SUM(qty),0) AS qty,
           COALESCE(SUM(r1_raise_amount),0) AS r1_amount,
           COALESCE(SUM(r2_raise_amount),0) AS r2_amount,
           COALESCE(SUM(r1_raise_amount),0) + COALESCE(SUM(r2_raise_amount),0) AS total_amount,
           COALESCE(SUM(r1_target_amount),0) AS r1_target,
           COALESCE(SUM(r2_target_amount),0) AS r2_target
    FROM deal_calc ${where}
    GROUP BY ${group} ORDER BY total_amount DESC`, params);
  res.json(rows);
}));

api.get('/deals/:id', wrap(async (req, res) => {
  const deal = await db.get('SELECT * FROM deal_calc WHERE id = ?', [req.params.id]);
  if (!deal) return res.status(404).json({ error: '案件が見つかりません' });
  const apps = await db.all(`
    SELECT a.id, a.round, a.status, a.achievement_rate, a.route, a.created_at, i.agreed_price
    FROM application_items i JOIN applications a ON a.id = i.application_id
    WHERE i.deal_id = ? ORDER BY a.id DESC`, [req.params.id]);
  res.json({ deal, applications: apps });
}));

const EDITABLE = ['status', 'negotiation_note', 'negotiated_date', 'price_type_code',
  'offer1_date', 'offer1_rate', 'offer1_price', 'r2_result_symbol'];

api.patch('/deals/:id', wrap(async (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager', 'planning'])) return;
  const sets = [];
  const params = [];
  for (const f of EDITABLE) {
    if (f in req.body) { sets.push(`${f} = ?`); params.push(nv(req.body[f])); }
  }
  if (!sets.length) return res.status(400).json({ error: '更新項目がありません' });
  sets.push('updated_at = ?');
  params.push(now(), req.params.id);
  await db.run(`UPDATE deals SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json(await db.get('SELECT * FROM deal_calc WHERE id = ?', [req.params.id]));
}));

// ---- 承認ルート判定 ----
async function determineRoute(rate) {
  const rules = await db.all('SELECT * FROM approval_rules WHERE active = 1 ORDER BY priority, id');
  for (const r of rules) {
    if (r.min_rate != null && rate < r.min_rate) continue;
    if (r.max_rate != null && rate >= r.max_rate) continue;
    return { route: r.final_step, ruleName: r.name };
  }
  return { route: 'planning', ruleName: '既定（該当ルールなし→営業企画部決裁）' };
}

async function computeAppTotals(appId) {
  return db.get(`
    SELECT COALESCE(SUM((target_price - base_price) * qty), 0) AS target_amount,
           COALESCE(SUM((agreed_price - base_price) * qty), 0) AS agreed_amount
    FROM application_items WHERE application_id = ?`, [appId]);
}

// ---- 申請（applications） ----
api.post('/applications', wrap(async (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager'])) return;
  const { round, items, price_type_code, title, comment } = req.body;
  if (![1, 2].includes(round)) return res.status(400).json({ error: 'round は 1 または 2 を指定してください' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '対象明細を選択してください' });

  const deals = [];
  for (const it of items) {
    const d = await db.get('SELECT * FROM deals WHERE id = ?', [it.deal_id]);
    deals.push(d ? { deal: d, agreed: Number(it.agreed_price) } : null);
  }
  if (deals.some((x) => !x || !Number.isFinite(x.agreed))) {
    return res.status(400).json({ error: '明細または合意単価が不正です' });
  }
  const customers = new Set(deals.map((x) => x.deal.customer_code));
  if (customers.size > 1) return res.status(400).json({ error: '申請は同一の得意先単位で作成してください' });

  // 同一明細・同一弾の進行中申請の重複を防止
  const dupRow = await db.get(`
    SELECT COUNT(*) AS c FROM application_items i
    JOIN applications a ON a.id = i.application_id
    WHERE a.round = ? AND a.status IN ('draft','pending_branch','pending_planning','approved')
      AND i.deal_id IN (${deals.map(() => '?').join(',')})`,
    [round, ...deals.map((x) => x.deal.id)]);
  if (num(dupRow.c) > 0) return res.status(409).json({ error: '選択明細に進行中または承認済みの申請が既に存在します' });

  const d0 = deals[0].deal;
  const { lastInsertRowid: appId } = await db.run(`
    INSERT INTO applications (round, title, customer_code, customer_name, applicant_id, branch, office, price_type_code, comment, status)
    VALUES (?,?,?,?,?,?,?,?,?,'draft')`,
    [round, nv(title) || `${d0.customer_name} 第${round}弾 値上げ申請`, d0.customer_code, d0.customer_name,
      req.user.id, req.user.branch, req.user.office, nv(price_type_code) ?? d0.price_type_code, nv(comment)]);

  const itemSql = `
    INSERT INTO application_items (application_id, deal_id, base_price, target_price, agreed_price, qty)
    VALUES (?,?,?,?,?,?)`;
  await db.batch(deals.map(({ deal, agreed }) => {
    // 基準単価: 第1弾は❶出荷単価、第2弾は❸値上後単価（未妥結なら出荷単価）
    const base = round === 1 ? deal.base_price : (deal.r1_agreed_price ?? deal.base_price);
    const target = round === 1 ? deal.r1_target_price : deal.r2_target_price;
    return { sql: itemSql, params: [appId, deal.id, nv(base), nv(target), agreed, nv(deal.qty)] };
  }));

  const t = await computeAppTotals(appId);
  const targetAmount = num(t.target_amount);
  const agreedAmount = num(t.agreed_amount);
  const rate = targetAmount > 0 ? Math.round((agreedAmount / targetAmount) * 1000) / 10 : 100;
  await db.run('UPDATE applications SET target_amount = ?, agreed_amount = ?, achievement_rate = ?, updated_at = ? WHERE id = ?',
    [targetAmount, agreedAmount, rate, now(), appId]);
  res.status(201).json(await getApplication(appId));
}));

async function getApplication(id) {
  const app = await db.get(`
    SELECT a.*, u.name AS applicant_name, p.name AS price_type_name, p.category AS price_type_category
    FROM applications a
    LEFT JOIN users u ON u.id = a.applicant_id
    LEFT JOIN price_types p ON p.code = a.price_type_code
    WHERE a.id = ?`, [id]);
  if (!app) return null;
  app.items = await db.all(`
    SELECT i.*, d.customer_name, d.model_name, d.equip_name, d.gas_type, d.sales_ym, d.delivery_name
    FROM application_items i JOIN deals d ON d.id = i.deal_id
    WHERE i.application_id = ? ORDER BY i.id`, [id]);
  app.approvals = await db.all(`
    SELECT ap.*, u.name AS approver_name FROM approvals ap
    LEFT JOIN users u ON u.id = ap.approver_id
    WHERE ap.application_id = ? ORDER BY ap.id`, [id]);
  return app;
}

api.get('/applications', wrap(async (req, res) => {
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
  const rows = await db.all(`
    SELECT a.*, u.name AS applicant_name, p.name AS price_type_name,
           (SELECT COUNT(*) FROM application_items i WHERE i.application_id = a.id) AS item_count
    FROM applications a
    LEFT JOIN users u ON u.id = a.applicant_id
    LEFT JOIN price_types p ON p.code = a.price_type_code
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT 300`, params);
  res.json(rows);
}));

api.get('/applications/:id', wrap(async (req, res) => {
  const app = await getApplication(req.params.id);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  res.json(app);
}));

api.post('/applications/:id/submit', wrap(async (req, res) => {
  if (!requireRole(req, res, ['sales', 'branch_manager'])) return;
  const app = await db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  if (!['draft', 'rejected'].includes(app.status)) return res.status(400).json({ error: 'この申請は提出できません' });
  if (app.applicant_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '申請者本人のみ提出できます' });
  }
  // 提出時点のルールで承認ルートを判定（達成率により承認権限が変わる）
  const { route, ruleName } = await determineRoute(num(app.achievement_rate));
  await db.run("UPDATE applications SET status = 'pending_branch', route = ?, rule_name = ?, updated_at = ? WHERE id = ?",
    [route, ruleName, now(), app.id]);
  res.json(await getApplication(app.id));
}));

// 承認時に妥結単価を案件へ反映（目標値上げ単価がマスター単価となる）
async function applyToDeals(app) {
  const items = await db.all('SELECT * FROM application_items WHERE application_id = ?', [app.id]);
  const ringi = `APP-${app.id}`;
  const statements = items.map((it) => app.round === 1
    ? {
      sql: `
        UPDATE deals SET r1_agreed_price = ?, r1_ringi_no = ?, r1_raise_date = ?,
          price_type_code = COALESCE(?, price_type_code),
          status = CASE WHEN ? > COALESCE(base_price, 0) THEN 'r1_agreed' ELSE status END,
          updated_at = ?
        WHERE id = ?`,
      params: [it.agreed_price, ringi, today(), nv(app.price_type_code), it.agreed_price, now(), it.deal_id],
    }
    : {
      sql: `
        UPDATE deals SET r2_agreed_price = ?, r2_ringi_no = ?, r2_result_symbol = '〇',
          final_confirm_date = ?, final_raise_date = ?,
          price_type_code = COALESCE(?, price_type_code),
          status = 'r2_agreed', updated_at = ?
        WHERE id = ?`,
      params: [it.agreed_price, ringi, today(), today(), nv(app.price_type_code), now(), it.deal_id],
    });
  if (statements.length) await db.batch(statements);
}

api.post('/applications/:id/approve', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const app = await db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);
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

  await db.run('INSERT INTO approvals (application_id, step, approver_id, action, comment) VALUES (?,?,?,?,?)',
    [app.id, step, req.user.id, 'approved', nv(req.body?.comment)]);

  if (step === 'branch' && app.route === 'planning') {
    await db.run("UPDATE applications SET status = 'pending_planning', updated_at = ? WHERE id = ?", [now(), app.id]);
  } else {
    await db.run("UPDATE applications SET status = 'approved', decided_at = ?, updated_at = ? WHERE id = ?",
      [now(), now(), app.id]);
    await applyToDeals(app);
  }
  res.json(await getApplication(app.id));
}));

api.post('/applications/:id/reject', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const app = await db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);
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
  await db.run('INSERT INTO approvals (application_id, step, approver_id, action, comment) VALUES (?,?,?,?,?)',
    [app.id, step, req.user.id, 'rejected', nv(req.body?.comment)]);
  await db.run("UPDATE applications SET status = 'rejected', updated_at = ? WHERE id = ?", [now(), app.id]);
  res.json(await getApplication(app.id));
}));

api.post('/applications/:id/withdraw', wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  const app = await db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  if (!app) return res.status(404).json({ error: '申請が見つかりません' });
  if (app.applicant_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '申請者本人のみ取下げできます' });
  }
  if (!['draft', 'pending_branch', 'pending_planning', 'rejected'].includes(app.status)) {
    return res.status(400).json({ error: 'この申請は取下げできません' });
  }
  await db.run("UPDATE applications SET status = 'withdrawn', updated_at = ? WHERE id = ?", [now(), app.id]);
  res.json(await getApplication(app.id));
}));

// ---- 承認ルール（別途設定可能） ----
api.get('/rules', wrap(async (req, res) => {
  res.json(await db.all('SELECT * FROM approval_rules ORDER BY priority, id'));
}));

api.put('/rules', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const rules = req.body;
  if (!Array.isArray(rules)) return res.status(400).json({ error: 'ルールの配列を指定してください' });
  for (const r of rules) {
    if (!['branch', 'planning'].includes(r.final_step)) {
      return res.status(400).json({ error: 'final_step は branch / planning のいずれかです' });
    }
  }
  const sql = 'INSERT INTO approval_rules (name, min_rate, max_rate, final_step, priority, active) VALUES (?,?,?,?,?,?)';
  await db.batch([
    { sql: 'DELETE FROM approval_rules', params: [] },
    ...rules.map((r, i) => ({
      sql,
      params: [nv(r.name) || `ルール${i + 1}`, nv(r.min_rate), nv(r.max_rate), r.final_step, i + 1, r.active === false ? 0 : 1],
    })),
  ]);
  res.json(await db.all('SELECT * FROM approval_rules ORDER BY priority, id'));
}));

// ---- 設定（目標金額など） ----
api.get('/settings', wrap(async (req, res) => {
  const rows = await db.all('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}));

api.put('/settings', wrap(async (req, res) => {
  if (!requireRole(req, res, ['planning'])) return;
  const entries = Object.entries(req.body || {});
  if (entries.length) {
    await db.batch(entries.map(([k, v]) => ({
      sql: 'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      params: [k, String(v)],
    })));
  }
  const rows = await db.all('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}));

// ---- ダッシュボード ----
api.get('/dashboard', wrap(async (req, res) => {
  const [settingRows, totals, byEquip, byPerson, statusCounts, appCounts] = await Promise.all([
    db.all('SELECT key, value FROM settings'),
    db.get(`
      SELECT COUNT(*) AS deals,
             COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
             COALESCE(SUM(r2_raise_amount), 0) AS r2_amount
      FROM deal_calc`),
    db.all(`
      SELECT equip_name, COUNT(*) AS deals,
             COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
             COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
             COALESCE(SUM(r1_raise_amount), 0) + COALESCE(SUM(r2_raise_amount), 0) AS total_amount
      FROM deal_calc WHERE equip_name IS NOT NULL
      GROUP BY equip_name ORDER BY total_amount DESC`),
    db.all(`
      SELECT sales_person, COUNT(*) AS deals,
             COALESCE(SUM(r1_raise_amount), 0) AS r1_amount,
             COALESCE(SUM(r2_raise_amount), 0) AS r2_amount,
             COALESCE(SUM(r1_raise_amount), 0) + COALESCE(SUM(r2_raise_amount), 0) AS total_amount
      FROM deal_calc WHERE sales_person IS NOT NULL
      GROUP BY sales_person ORDER BY total_amount DESC`),
    db.all('SELECT status, COUNT(*) AS count FROM deals GROUP BY status'),
    db.all('SELECT status, COUNT(*) AS count FROM applications GROUP BY status'),
  ]);
  const settings = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));
  res.json({
    targets: {
      r1: Number(settings.r1_target_total || 0),
      r2: Number(settings.r2_target_total || 0),
    },
    progress: { r1: num(totals.r1_amount), r2: num(totals.r2_amount), deals: num(totals.deals) },
    byEquip, byPerson, statusCounts, appCounts,
  });
}));

// ---- Excel取込 ----
api.post('/import', upload.single('file'), wrap(async (req, res) => {
  if (!requireLogin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'ファイルを選択してください' });
  try {
    const result = await importWorkbook(req.file.buffer, req.file.originalname, req.user.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

api.get('/import/batches', wrap(async (req, res) => {
  res.json(await db.all(`
    SELECT b.*, u.name AS imported_by_name FROM import_batches b
    LEFT JOIN users u ON u.id = b.imported_by
    ORDER BY b.id DESC LIMIT 50`));
}));

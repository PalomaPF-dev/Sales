// 出荷実績の色分け（色塗り判定）。
//
// MBの出荷明細（毎日の出荷データ）を取り込み、これまでExcelで手作業で
// 行っていた「出荷単価の色塗り」と同じ条件で自動的に区分けする。
// 判定条件は「色塗り資料の判定条件」（まとめシート）をそのまま写したもので、
// 上から順に当てはめ、原則として後の処理では上書きしない。
//
//   1. 法人名が「輸出」の行は対象外
//   2. 基準価格（器種コードで突き合わせ）以上なら 値上済（水色）
//   3. 大和ハウス・積水ハウス・器種名がDK始まり・IG終わりは 値上単価未締結（ピンク）
//   4. 見積伝票番号が先方契約済物件リストにあれば 先方契約済物件リスト分（黄）
//   5. 過去の色塗り（得意先・納入先・器種・ガス・出荷単価がすべて一致）を引き継ぐ
//   6. 特定の法人コード・期間指定の得意先は 受注分（緑）
//   7. 過去の最大単価を上回れば 値上済（水色）※例外的に上書きする
//   8. 受注日が締め日以前なら 受注分（緑）
//   9. 湯沸の黄色は色なしへ戻し、特定の器種名・機種は その他（灰）
//
// どれにも当たらない行は「未判定（目視確認）」として残し、画面で区分を選ぶ。
// 画面で選んだ区分（手動）と、色塗り済みのファイルから読んだ色は、
// 自動判定より優先し、以後の取込では「過去の色塗り」（5・7）として使う。
import { db } from './db.js';
import { IZ_CONTRACT_QUOTES } from './shipContractQuotes.js';

/** 区分。並びは色塗り資料の凡例と同じ */
export const CATEGORIES = [
  { key: 'raised', label: '値上済', color: '#CAEEFB' },
  { key: 'ordered', label: '受注分', color: '#D9F2D0' },
  { key: 'contract', label: '先方契約済物件リスト分', color: '#FFFF00' },
  { key: 'unsigned', label: '値上単価未締結', color: '#FFCCFF' },
  { key: 'nonpos', label: '非ポジ・長期在庫', color: '#FFC000' },
  { key: 'other', label: 'その他', color: '#BFBFBF' },
];
const CAT_KEYS = new Set(CATEGORIES.map((c) => c.key));
/** 自動判定の対象外（輸出）。集計では別に数える */
export const EXCLUDED = 'excluded';

/** 判定理由（どの条件で決まったか） */
export const RULE_LABELS = {
  1: '1. 輸出のため対象外',
  2: '2. 基準価格以上',
  3: '3. 特定条件（法人・器種名）',
  4: '4. 先方契約済物件リスト',
  5: '5. 過去の色塗りと一致',
  6: '6. 特定コード・期間指定（受注日で判定）',
  7: '7. 過去の最大単価を上回る',
  8: '8. 受注日が締め日以前',
  '9-1': '9-1. 湯沸の黄色を色なしへ',
  '9-2': '9-2. 器種名に特定の文字',
  '9-3': '9-3. 対象機種',
};

/**
 * 判定条件の既定値。色塗り資料（まとめシート）に書かれている内容。
 * 画面から直せるので、ここは初めて使うときの値にすぎない。
 * 先方契約済物件・期間指定は色塗り資料のファイルから取り込む。
 */
export const DEFAULT_RULES = {
  // 判定の対象にするカテゴリー名大。MBの月全体のファイルにはすべての器種が入っているため、
  // これ以外（ロードヒーター・ビルトインなど）は取り込まない
  targetCategories: ['湯沸', 'PH', 'PR', 'FH'],
  excludeCorps: ['輸出'],
  pinkCorps: ['大和ハウス工業㈱', '積水ハウス㈱'],
  pinkPrefixes: ['DK'],
  pinkExcept: ['DKDU-K20W(E)'],
  pinkSuffixes: ['IG'],
  contractQuotes: [],
  // 法人コード（出荷明細のB列）で決める特定コード。期限は受注日で見る（空欄は期限なし）
  greenCorpCodes: [
    { code: 'M0817', name: 'アイエスジー', until: '2026-09-30' },
    { code: 'M0036', name: '堀川産業', until: '2026-09-20' },
  ],
  // 期間指定（得意先コード）。期限は受注日で見る
  periodCustomers: [],
  orderCutoff: '2026-08-31',
  // 過去の色塗り（条件5・7）に使う出荷データの起点。この日より前の売上日の行は使わない
  // （ヒアリング：9月1日以降のものを基準にしている）
  historyFrom: '2026-09-01',
  kettleCategory: '湯沸',
  grayKeywords: ['＋', 'KOS', 'EAP', 'KFAWL', 'KSAWL'],
  grayModels: [
    'FH-2010AW', 'PH-2017AW-OK', 'PH-2027AW-OK', 'HBF-E242SAWL', 'HBF-E242FAWL',
    'PH-2427AW', 'HBF-E242FARL', 'PH-2017AML', 'FH-E208AWL',
  ],
  grayPrefixes: ['TW-EM'],
};

const SETTINGS_KEY = 'ship_rules';

/** この機能を使える権限。画面側の client/src/shipColor.ts の SHIP_VIEW_ROLES と合わせる */
export const SHIP_VIEW_ROLES = ['admin', 'developer'];

/**
 * 突き合わせ用の正規化。全角・半角（㈱と(株)、＋と+）と空白の違いを無視する。
 * 法人名・器種名は元の表記が揺れるため、比べる前に必ずこれを通す。
 */
export const nk = (v) => String(v ?? '').normalize('NFKC').replace(/[\s　]/g, '').toUpperCase();

/** コード類。「< NULL >」は空として扱う */
const code = (v) => {
  const s = String(v ?? '').trim();
  return s === '< NULL >' ? '' : s;
};

/** 日付を YYYY-MM-DD に。読めなければ空 */
export function ymd(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const m = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(String(v));
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,，¥￥\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 過去の色塗りの突き合わせキー（得意先・納入先・器種・ガス） */
const key4 = (r) => [code(r.customer_code), code(r.delivery_code), code(r.model_code), code(r.gas_code)].join('|');
/** 出荷単価まで含めたキー。単価は小数の誤差をならして比べる */
const key5 = (r) => `${key4(r)}|${Math.round(Number(r.price) * 100) / 100}`;

/** 保存されている判定条件を読む。欠けている項目は既定値で補う */
export async function loadRules() {
  let saved = {};
  try {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY]);
    if (row?.value) saved = JSON.parse(row.value);
  } catch { /* 読めなければ既定値 */ }
  const rules = upgradeRules({ ...DEFAULT_RULES, ...saved }, saved);
  if ((Number(saved?.rulesVersion) || 1) < RULES_VERSION) {
    // 版を上げた内容を保存しておく。保存できなくても、読むたびに同じ更新が当たるので動作は変わらない
    try { await saveRules(sanitizeRules(rules, rules)); } catch { /* 次に読むときにやり直す */ }
  }
  return rules;
}

/** 保存されている判定条件の版。既定値を直したときに、保存済みの設定へも反映するために使う */
const RULES_VERSION = 3;

/**
 * 保存済みの判定条件を今の版へそろえる（読むたびに当てる。保存は画面で保存したとき）。
 * 版2：ヒアリングの回答を反映。アイエスジー（M0817）の期限を9月末にする（期限が空のときだけ）
 * 版3：先方契約済物件（条件4）の見積伝票番号を、iZの見積リスト（2026-10-01受領）の全件に入れ替える
 */
function upgradeRules(rules, saved) {
  const from = Number(saved?.rulesVersion) || 1;
  if (from < 3) rules.contractQuotes = [...IZ_CONTRACT_QUOTES];
  if (from < 2) {
    rules.greenCorpCodes = (rules.greenCorpCodes ?? []).map((x) => (
      String(x?.code ?? '').trim().toUpperCase() === 'M0817' && !x?.until ? { ...x, until: '2026-09-30' } : x));
  }
  return rules;
}

const strList = (v, max = 20000) => (Array.isArray(v) ? v : [])
  .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max);
const codeList = (v) => (Array.isArray(v) ? v : [])
  .map((x) => ({
    code: String(x?.code ?? '').trim(),
    name: String(x?.name ?? '').trim(),
    until: ymd(x?.until),
  }))
  .filter((x) => x.code)
  .slice(0, 5000);

/** 画面から来た判定条件を、決まった形にそろえる（知らない項目は捨てる） */
export function sanitizeRules(input, base = DEFAULT_RULES) {
  const src = { ...base, ...(input ?? {}) };
  return {
    targetCategories: strList(src.targetCategories),
    excludeCorps: strList(src.excludeCorps),
    pinkCorps: strList(src.pinkCorps),
    pinkPrefixes: strList(src.pinkPrefixes),
    pinkExcept: strList(src.pinkExcept),
    pinkSuffixes: strList(src.pinkSuffixes),
    contractQuotes: [...new Set(strList(src.contractQuotes, 50000))],
    greenCorpCodes: codeList(src.greenCorpCodes),
    periodCustomers: codeList(src.periodCustomers),
    orderCutoff: ymd(src.orderCutoff),
    historyFrom: ymd(src.historyFrom),
    kettleCategory: String(src.kettleCategory ?? '').trim(),
    grayKeywords: strList(src.grayKeywords),
    grayModels: strList(src.grayModels),
    grayPrefixes: strList(src.grayPrefixes),
  };
}

async function saveRules(rules) {
  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_KEY, JSON.stringify({ ...rules, rulesVersion: RULES_VERSION })]);
}

/** 「受注分」の見出し。締め日の月から「8月受注分」のように付ける */
export function orderedLabel(rules) {
  const m = /^\d{4}-(\d{2})/.exec(rules?.orderCutoff ?? '');
  return m ? `${Number(m[1])}月受注分` : '受注分';
}

/**
 * 判定に使う材料をまとめる。判定条件の文字列は正規化した形で持っておく
 * （1行ごとに正規化し直すと、数千行の判定で無駄が大きいため）。
 */
export function buildContext(rules, basePrices, history = { exact: new Map(), max: new Map() }) {
  const until = (list) => new Map(list.map((x) => [nk(x.code), x.until || '']));
  return {
    excludeCorps: new Set(rules.excludeCorps.map(nk)),
    pinkCorps: new Set(rules.pinkCorps.map(nk)),
    pinkPrefixes: rules.pinkPrefixes.map(nk),
    pinkExcept: new Set(rules.pinkExcept.map(nk)),
    pinkSuffixes: rules.pinkSuffixes.map(nk),
    contracts: new Set(rules.contractQuotes.map(nk)),
    greenCorpCodes: until(rules.greenCorpCodes),
    periodCustomers: until(rules.periodCustomers),
    orderCutoff: rules.orderCutoff || '',
    kettle: nk(rules.kettleCategory),
    grayKeywords: rules.grayKeywords.map(nk).filter(Boolean),
    grayModels: new Set(rules.grayModels.map(nk)),
    grayPrefixes: rules.grayPrefixes.map(nk).filter(Boolean),
    basePrices,          // Map<器種コード, 基準価格>
    history,             // { exact: Map<key5, 区分>, max: Map<key4, 最大単価> }
  };
}

/**
 * 期限つきのコード表に当たるか。期限は受注日で見る（売上日では見ない）。
 * 期限があるのに受注日が無い行は当てない（値段を見て目視で決めるため、未判定に回す）。
 */
const withinUntil = (map, k, orderDay) => {
  if (!map.has(k)) return false;
  const u = map.get(k);
  if (!u) return true;
  return Boolean(orderDay) && orderDay <= u;
};

/**
 * 1行を判定する。戻り値は { cat, rule }。
 * cat が null なら未判定（目視確認）。rule はどの条件で決まったか。
 * 条件の順番・上書きの有無は色塗り資料の「判定処理の基本方針」のとおり。
 */
export function classifyShipRow(r, ctx) {
  const corp = nk(r.corp_name);
  if (ctx.excludeCorps.has(corp)) return { cat: EXCLUDED, rule: '1' };

  const name = nk(r.model_name);
  const price = toNum(r.price);
  const orderDay = r.order_date || '';
  let cat = null;
  let rule = null;
  const set = (c, why) => { cat = c; rule = why; };

  // 2. 基準価格との比較（未満は色を付けず、後の条件へ回す）
  const base = ctx.basePrices.get(code(r.model_code));
  if (base != null && price != null && price >= base) set('raised', '2');

  // 3. 特定条件は無条件でピンク
  if (!cat) {
    const pink = ctx.pinkCorps.has(corp)
      || (ctx.pinkPrefixes.some((p) => p && name.startsWith(p)) && !ctx.pinkExcept.has(name))
      || ctx.pinkSuffixes.some((s) => s && name.endsWith(s));
    if (pink) set('unsigned', '3');
  }

  // 4. 先方契約済物件（見積伝票番号）
  if (!cat) {
    const q = nk(code(r.quote_no));
    if (q && ctx.contracts.has(q)) set('contract', '4');
  }

  // 5. 過去の色塗り（5項目すべて一致）
  if (!cat && price != null) {
    const past = ctx.history.exact.get(key5(r));
    if (past) set(past, '5');
  }

  // 6. 特定コード（法人コード）・期間指定（得意先コード）
  if (!cat) {
    if (withinUntil(ctx.greenCorpCodes, nk(code(r.corp_code)), orderDay)
      || withinUntil(ctx.periodCustomers, nk(code(r.customer_code)), orderDay)) {
      set('ordered', '6');
    }
  }

  // 7. 過去の最大単価を上回るものは値上済。例外的に既存の色を上書きする
  if (price != null) {
    const max = ctx.history.max.get(key4(r));
    if (max != null && price > max) set('raised', '7');
  }

  // 8. 受注日が締め日以前
  if (!cat && ctx.orderCutoff && orderDay && orderDay <= ctx.orderCutoff) set('ordered', '8');

  // 9-1. 湯沸の黄色は色なしへ
  if (cat === 'contract' && ctx.kettle && nk(r.cat_large) === ctx.kettle) {
    cat = null;
    rule = '9-1';
  }
  // 9-2・9-3. 特定の器種名・対象機種は灰色（その他）
  if (!cat) {
    if (ctx.grayKeywords.some((k) => name.includes(k))) set('other', '9-2');
    else if (ctx.grayModels.has(name) || ctx.grayPrefixes.some((p) => name.startsWith(p))) set('other', '9-3');
  }
  return { cat, rule };
}

/** 最終の区分（手動 > ファイルの色 > 自動）を出すSQL */
const FINAL_CAT = "COALESCE(o.category, r.file_cat, r.auto_cat, 'unset')";
const SOURCE = "CASE WHEN o.category IS NOT NULL THEN 'manual' WHEN r.file_cat IS NOT NULL THEN 'file' ELSE 'auto' END";
const ROW_FROM = `ship_rows r
  JOIN ship_batches b ON b.id = r.batch_id
  LEFT JOIN ship_overrides o ON o.slip_no = r.slip_no`;

/** 取り込む列。画面から送られてくる形と、テーブルの列は同じ名前にしてある */
const ROW_COLS = [
  'slip_no', 'sale_date', 'order_date', 'corp_code', 'corp_name', 'customer_code', 'customer_name',
  'delivery_code', 'delivery_name', 'industry', 'equip_name', 'cat_large', 'cat_name',
  'model_code', 'gas_code', 'model_name', 'gas_type', 'qty', 'price', 'amount', 'list_price',
  'quote_no', 'branch', 'office', 'person', 'file_cat',
];
const NUM_COLS = new Set(['qty', 'price', 'amount', 'list_price']);
const DATE_COLS = new Set(['sale_date', 'order_date']);

function cleanRow(src) {
  const out = {};
  for (const c of ROW_COLS) {
    const v = src?.[c];
    if (NUM_COLS.has(c)) out[c] = toNum(v);
    else if (DATE_COLS.has(c)) out[c] = ymd(v) || null;
    else out[c] = code(v).slice(0, 200) || null;
  }
  if (out.file_cat && !CAT_KEYS.has(out.file_cat)) out.file_cat = null;
  return out;
}

/**
 * 過去の色塗り（条件5・7の材料）。この取込より前の日付の行から作る。
 * 区分は画面で選んだもの・ファイルの色・自動判定の順で、最後に決まったもの。
 * 器種コードで絞ってから読む（全件を読むと、月をまたいで数万行になるため）。
 */
async function loadHistory(dataDate, modelCodes, historyFrom = '') {
  const exact = new Map();
  const max = new Map();
  const codes = [...new Set(modelCodes.filter(Boolean))];
  const latest = new Map();
  for (let i = 0; i < codes.length; i += 500) {
    const part = codes.slice(i, i + 500);
    const rows = await db.all(
      `SELECT r.customer_code, r.delivery_code, r.model_code, r.gas_code, r.price,
              ${FINAL_CAT} AS cat, b.data_date
         FROM ${ROW_FROM}
        WHERE b.data_date < ? AND b.status = 'done'
          ${historyFrom ? 'AND r.sale_date >= ?' : ''}
          AND r.model_code IN (${part.map(() => '?').join(',')})`,
      [dataDate, ...(historyFrom ? [historyFrom] : []), ...part]);
    for (const h of rows) {
      if (!CAT_KEYS.has(h.cat) || h.price == null) continue;
      const k5 = key5(h);
      if (!latest.has(k5) || latest.get(k5) <= h.data_date) {
        latest.set(k5, h.data_date);
        exact.set(k5, h.cat);
      }
      const k4 = key4(h);
      const p = Number(h.price);
      if (!max.has(k4) || max.get(k4) < p) max.set(k4, p);
    }
  }
  return { exact, max };
}

async function loadBasePrices() {
  const rows = await db.all('SELECT code, base_price FROM ship_base_prices');
  return new Map(rows.filter((r) => r.base_price != null).map((r) => [String(r.code), Number(r.base_price)]));
}

const INSERT_ROW_SQL = `INSERT INTO ship_rows (batch_id, ${ROW_COLS.join(', ')}, auto_cat, auto_rule)
  VALUES (${Array(ROW_COLS.length + 3).fill('?').join(', ')})`;
const insertStmt = (batchId, r) => ({
  sql: INSERT_ROW_SQL,
  params: [batchId, ...ROW_COLS.map((c) => r[c] ?? null), r.auto_cat ?? null, r.auto_rule ?? null],
});

/**
 * 取込1回ぶん（1日ぶん）を判定し直す。
 * 行を読み、判定して、まとめて書き戻す（1行ずつUPDATEすると遠隔のDBでは
 * 往復回数がそのまま行数になるため、消して入れ直す）。
 */
export async function classifyBatch(batchId) {
  const batch = await db.get('SELECT * FROM ship_batches WHERE id = ?', [batchId]);
  if (!batch) return null;
  const rows = await db.all(`SELECT ${ROW_COLS.join(', ')} FROM ship_rows WHERE batch_id = ?`, [batchId]);
  const rules = await loadRules();
  const ctx = buildContext(rules, await loadBasePrices(),
    await loadHistory(batch.data_date, rows.map((r) => r.model_code), rules.historyFrom));
  const counts = {};
  for (const r of rows) {
    const { cat, rule } = classifyShipRow(r, ctx);
    r.auto_cat = cat;
    r.auto_rule = rule;
    const k = r.file_cat || cat || 'unset';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  await db.batch([
    { sql: 'DELETE FROM ship_rows WHERE batch_id = ?', params: [batchId] },
    ...rows.map((r) => insertStmt(batchId, r)),
    {
      sql: 'UPDATE ship_batches SET row_count = ?, colored_count = ?, classified_at = ? WHERE id = ?',
      params: [rows.length, rows.filter((r) => r.file_cat).length, new Date().toISOString(), batchId],
    },
  ]);
  return { rows: rows.length, counts };
}

/**
 * 画面・APIを api ルーターへ取り付ける。
 * 認証・権限・閲覧範囲の部品は api.js のものをそのまま使う（二重に持たないため）。
 */
export function mountShipColor(api, { wrap, requireLogin, requireRole, scopeConditions }) {
  // 公開の範囲。まずは管理者だけで試す（開発者は管理者と同じ扱い）。広げるときはここ（と画面の SHIP_VIEW_ROLES）を変える。
  // 個々の経路に書き忘れても漏れないよう、/ship-color の入口でまとめて止める
  api.use('/ship-color', (req, res, next) => {
    if (!requireLogin(req, res)) return;
    if (!SHIP_VIEW_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'この画面は管理者のみ利用できます' });
    }
    next();
  });
  // 取込・判定条件の変更・区分の手直しは本社（営業部・製品企画部）と管理者
  // （入口で管理者に絞っているため、いまは管理者だけが通る）
  const requireHq = (req, res) => requireRole(req, res, ['planning']);
  const userName = (req) => req.user?.name ?? '';

  /** 絞り込み（期間・区分・まとめ方の値・検索）と閲覧範囲をWHEREにする */
  function filters(q, user, { withCat = true } = {}) {
    const scope = scopeConditions(user, 'r');
    const where = [...scope.where];
    const params = [...scope.params];
    if (ymd(q.from)) { where.push('r.sale_date >= ?'); params.push(ymd(q.from)); }
    if (ymd(q.to)) { where.push('r.sale_date <= ?'); params.push(ymd(q.to)); }
    if (q.batch && /^\d+$/.test(String(q.batch))) { where.push('r.batch_id = ?'); params.push(Number(q.batch)); }
    const group = GROUPS[q.group] ? q.group : null;
    if (group && q.name != null && q.name !== '') {
      where.push(`COALESCE(${GROUPS[group]}, '') = ?`);
      params.push(q.name === '(空白)' ? '' : String(q.name));
    }
    if (withCat && q.cat) {
      const cats = String(q.cat).split(',').filter((c) => CAT_KEYS.has(c) || c === 'unset' || c === EXCLUDED);
      if (cats.length) {
        where.push(`${FINAL_CAT} IN (${cats.map(() => '?').join(',')})`);
        params.push(...cats);
      }
    }
    if (['manual', 'file', 'auto'].includes(q.source)) { where.push(`${SOURCE} = ?`); params.push(q.source); }
    if (q.rule && RULE_LABELS[q.rule]) { where.push('r.auto_rule = ?'); params.push(String(q.rule)); }
    const text = String(q.q ?? '').trim();
    if (text) {
      const like = `%${text}%`;
      where.push(`(r.corp_name LIKE ? OR r.customer_name LIKE ? OR r.delivery_name LIKE ?
                   OR r.model_name LIKE ? OR r.slip_no LIKE ? OR r.quote_no LIKE ?
                   OR r.customer_code LIKE ? OR r.model_code LIKE ?)`);
      params.push(like, like, like, like, like, like, like, like);
    }
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  // ---- 判定条件 ----
  api.get('/ship-color/rules', wrap(async (req, res) => {
    if (!requireLogin(req, res)) return;
    const rules = await loadRules();
    const bp = await db.get('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM ship_base_prices');
    res.json({
      rules,
      defaults: DEFAULT_RULES,
      categories: CATEGORIES.map((c) => (c.key === 'ordered' ? { ...c, label: orderedLabel(rules) } : c)),
      ruleLabels: RULE_LABELS,
      basePrices: { count: Number(bp?.n ?? 0), updatedAt: bp?.at ?? null },
    });
  }));

  api.put('/ship-color/rules', wrap(async (req, res) => {
    if (!requireHq(req, res)) return;
    const rules = sanitizeRules(req.body?.rules, await loadRules());
    await saveRules(rules);
    res.json({ rules });
  }));

  /**
   * 色塗り資料（基準価格・先方契約済物件・期間指定）の取込。
   * 画面でファイルを読み、送られてきた分だけ置き換える（送られない表はそのまま）。
   */
  api.post('/ship-color/reference', wrap(async (req, res) => {
    if (!requireHq(req, res)) return;
    const body = req.body ?? {};
    const result = {};
    if (Array.isArray(body.basePrices)) {
      const seen = new Map();
      for (const x of body.basePrices) {
        const c = code(x?.code);
        const p = toNum(x?.price);
        // 同じ器種コードが複数あれば先に出てきた行を使う（VLOOKUPと同じ）
        if (!c || p == null || seen.has(c)) continue;
        seen.set(c, { code: c, name: code(x?.name).slice(0, 200) || null, price: p });
      }
      if (!seen.size) return res.status(400).json({ error: '基準価格が1件も読み取れませんでした' });
      const at = new Date().toISOString();
      await db.batch([
        { sql: 'DELETE FROM ship_base_prices', params: [] },
        ...[...seen.values()].map((x) => ({
          sql: 'INSERT INTO ship_base_prices (code, model_name, base_price, updated_at) VALUES (?, ?, ?, ?)',
          params: [x.code, x.name, x.price, at],
        })),
      ]);
      result.basePrices = seen.size;
    }
    if (Array.isArray(body.contracts) || Array.isArray(body.periodCustomers)) {
      const cur = await loadRules();
      const next = sanitizeRules({
        ...cur,
        ...(Array.isArray(body.contracts) ? { contractQuotes: body.contracts } : {}),
        ...(Array.isArray(body.periodCustomers) ? { periodCustomers: body.periodCustomers } : {}),
      }, cur);
      await saveRules(next);
      if (Array.isArray(body.contracts)) result.contracts = next.contractQuotes.length;
      if (Array.isArray(body.periodCustomers)) result.periodCustomers = next.periodCustomers.length;
    }
    res.json(result);
  }));

  api.get('/ship-color/base-prices', wrap(async (req, res) => {
    if (!requireLogin(req, res)) return;
    const q = String(req.query.q ?? '').trim();
    const rows = await db.all(
      `SELECT code, model_name, base_price FROM ship_base_prices
        ${q ? 'WHERE code LIKE ? OR model_name LIKE ?' : ''}
        ORDER BY code LIMIT 200`, q ? [`%${q}%`, `%${q}%`] : []);
    res.json({ rows });
  }));

  // ---- 出荷データの取込（1シート＝1日ぶん） ----
  api.post('/ship-color/import/start', wrap(async (req, res) => {
    if (!requireHq(req, res)) return;
    const dataDate = ymd(req.body?.dataDate);
    if (!dataDate) return res.status(400).json({ error: 'データの日付が読み取れません（売上日の列をご確認ください）' });
    const r = await db.run(
      `INSERT INTO ship_batches (data_date, filename, sheet, row_count, colored_count, status, taken_at, taken_by_name)
       VALUES (?, ?, ?, 0, 0, 'loading', ?, ?)`,
      [dataDate, String(req.body?.filename ?? '').slice(0, 200), String(req.body?.sheet ?? '').slice(0, 100),
        new Date().toISOString(), userName(req)]);
    res.json({ batchId: r.lastInsertRowid });
  }));

  api.post('/ship-color/import/:batchId/rows', wrap(async (req, res) => {
    if (!requireHq(req, res)) return;
    const batchId = Number(req.params.batchId);
    const batch = await db.get("SELECT id FROM ship_batches WHERE id = ? AND status = 'loading'", [batchId]);
    if (!batch) return res.status(404).json({ error: '取込が見つかりません。最初からやり直してください' });
    // 対象のカテゴリー（湯沸・PH・PR・FH）以外は取り込まない（画面でも絞っているが、念のためここでも）
    const targets = new Set((await loadRules()).targetCategories.map(nk));
    const rows = (Array.isArray(req.body?.rows) ? req.body.rows : []).map(cleanRow)
      .filter((r) => r.slip_no && (!targets.size || !r.cat_large || targets.has(nk(r.cat_large))));
    if (!rows.length) return res.json({ inserted: 0 });
    // 同じ売上伝票NOが前に取り込まれていれば置き換える（同じ日を取り込み直したとき・
    // 日をまたいで同じ明細が載ったとき）。画面で選んだ区分は伝票NOで持っているので残る
    const slips = rows.map((r) => r.slip_no);
    const stmts = [];
    for (let i = 0; i < slips.length; i += 500) {
      const part = slips.slice(i, i + 500);
      stmts.push({ sql: `DELETE FROM ship_rows WHERE slip_no IN (${part.map(() => '?').join(',')})`, params: part });
    }
    await db.batch([...stmts, ...rows.map((r) => insertStmt(batchId, r))]);
    res.json({ inserted: rows.length });
  }));

  api.post('/ship-color/import/:batchId/finish', wrap(async (req, res) => {
    if (!requireHq(req, res)) return;
    const batchId = Number(req.params.batchId);
    const batch = await db.get('SELECT * FROM ship_batches WHERE id = ?', [batchId]);
    if (!batch) return res.status(404).json({ error: '取込が見つかりません' });
    // 同じ日付の前の取込は、この取込に置き換わる
    const old = await db.all('SELECT id FROM ship_batches WHERE data_date = ? AND id <> ?', [batch.data_date, batchId]);
    for (const o of old) {
      await db.run('DELETE FROM ship_rows WHERE batch_id = ?', [o.id]);
      await db.run('DELETE FROM ship_batches WHERE id = ?', [o.id]);
    }
    await db.run("UPDATE ship_batches SET status = 'done' WHERE id = ?", [batchId]);
    const r = await classifyBatch(batchId);
    // ほかの日の取込に明細が移って空になった回は片付ける
    await db.run(`DELETE FROM ship_batches WHERE status = 'done'
                    AND NOT EXISTS (SELECT 1 FROM ship_rows WHERE batch_id = ship_batches.id)`);
    res.json({ ...r, replaced: old.length, dataDate: batch.data_date });
  }));

  api.get('/ship-color/batches', wrap(async (req, res) => {
    if (!requireLogin(req, res)) return;
    const rows = await db.all(
      `SELECT b.id, b.data_date, b.filename, b.sheet, b.row_count, b.colored_count, b.status,
              b.taken_at, b.taken_by_name, b.classified_at,
              MIN(r.sale_date) AS min_sale, MAX(r.sale_date) AS max_sale
         FROM ship_batches b LEFT JOIN ship_rows r ON r.batch_id = b.id
        GROUP BY b.id, b.data_date, b.filename, b.sheet, b.row_count, b.colored_count, b.status,
                 b.taken_at, b.taken_by_name, b.classified_at
        ORDER BY b.data_date DESC, b.id DESC`);
    res.json({ rows });
  }));

  // 判定し直す（判定条件を直したあと・区分を手で直したあと）。
  // 後の日は前の日の結果を「過去の色塗り」として使うため、画面から日付の古い順に1回ずつ呼ぶ
  api.post('/ship-color/batches/:batchId/classify', wrap(async (req, res) => {
    if (!requireHq(req, res)) return;
    const r = await classifyBatch(Number(req.params.batchId));
    if (!r) return res.status(404).json({ error: '取込が見つかりません' });
    res.json(r);
  }));

  api.delete('/ship-color/batches/:batchId', wrap(async (req, res) => {
    if (!requireHq(req, res)) return;
    const id = Number(req.params.batchId);
    const { changes } = await db.run('DELETE FROM ship_rows WHERE batch_id = ?', [id]);
    await db.run('DELETE FROM ship_batches WHERE id = ?', [id]);
    res.json({ deleted: changes });
  }));

  // ---- 集計・明細 ----
  api.get('/ship-color/summary', wrap(async (req, res) => {
    if (!requireLogin(req, res)) return;
    const q = req.query;
    const group = GROUPS[q.group] ? q.group : 'cat_large';
    const f = filters(q, req.user, { withCat: false });
    const totals = await db.all(
      `SELECT ${FINAL_CAT} AS cat, COUNT(*) AS n, SUM(r.qty) AS qty, SUM(r.amount) AS amount
         FROM ${ROW_FROM} ${f.where} GROUP BY ${FINAL_CAT}`, f.params);
    const cross = await db.all(
      `SELECT COALESCE(${GROUPS[group]}, '') AS name, ${FINAL_CAT} AS cat,
              COUNT(*) AS n, SUM(r.qty) AS qty, SUM(r.amount) AS amount
         FROM ${ROW_FROM} ${f.where}
        GROUP BY COALESCE(${GROUPS[group]}, ''), ${FINAL_CAT}`, f.params);
    const sources = await db.all(
      `SELECT ${SOURCE} AS source, COUNT(*) AS n FROM ${ROW_FROM} ${f.where} GROUP BY ${SOURCE}`, f.params);
    const range = await db.get(
      `SELECT MIN(r.sale_date) AS min_sale, MAX(r.sale_date) AS max_sale, MAX(b.data_date) AS last_data
         FROM ${ROW_FROM}`);
    res.json({ group, totals, cross, sources, range });
  }));

  api.get('/ship-color/rows', wrap(async (req, res) => {
    if (!requireLogin(req, res)) return;
    const q = req.query;
    // 応答が約4.5MB（Vercelの上限）を超えないよう、1回は2000行まで（約1.5MB）
    const size = Math.min(2000, Math.max(1, Number(q.size) || 100));
    const page = Math.max(1, Number(q.page) || 1);
    const f = filters(q, req.user);
    const total = await db.get(`SELECT COUNT(*) AS n FROM ${ROW_FROM} ${f.where}`, f.params);
    const rows = await db.all(
      `SELECT r.id, r.slip_no, r.sale_date, r.order_date, r.corp_code, r.corp_name,
              r.customer_code, r.customer_name, r.delivery_code, r.delivery_name,
              r.equip_name, r.cat_large, r.model_code, r.gas_code, r.model_name, r.gas_type,
              r.qty, r.price, r.amount, r.quote_no, r.branch, r.office, r.person,
              r.file_cat, r.auto_cat, r.auto_rule, o.category AS manual_cat,
              o.updated_by_name AS manual_by, o.updated_at AS manual_at,
              ${FINAL_CAT} AS cat, ${SOURCE} AS source, bp.base_price, b.data_date
         FROM ${ROW_FROM}
         LEFT JOIN ship_base_prices bp ON bp.code = r.model_code
         ${f.where}
        ORDER BY r.sale_date DESC, r.corp_name, r.customer_code, r.model_name, r.slip_no
        LIMIT ? OFFSET ?`, [...f.params, size, (page - 1) * size]);
    res.json({ total: Number(total?.n ?? 0), page, size, rows });
  }));

  /**
   * 区分を手で決める（目視確認の結果）。売上伝票NOごとに持つので、
   * 同じ日を取り込み直しても残る。category が空なら手動の指定を外す。
   */
  api.put('/ship-color/overrides', wrap(async (req, res) => {
    if (!requireHq(req, res)) return;
    const slips = [...new Set((Array.isArray(req.body?.slips) ? req.body.slips : []).map(code).filter(Boolean))]
      .slice(0, 5000);
    if (!slips.length) return res.status(400).json({ error: '対象の明細がありません' });
    const cat = req.body?.category ? String(req.body.category) : null;
    if (cat && !CAT_KEYS.has(cat)) return res.status(400).json({ error: '区分が正しくありません' });
    const at = new Date().toISOString();
    const stmts = [];
    for (let i = 0; i < slips.length; i += 500) {
      const part = slips.slice(i, i + 500);
      stmts.push({ sql: `DELETE FROM ship_overrides WHERE slip_no IN (${part.map(() => '?').join(',')})`, params: part });
    }
    if (cat) {
      for (const s of slips) {
        stmts.push({
          sql: 'INSERT INTO ship_overrides (slip_no, category, updated_by_name, updated_at) VALUES (?, ?, ?, ?)',
          params: [s, cat, userName(req), at],
        });
      }
    }
    await db.batch(stmts);
    res.json({ updated: slips.length, category: cat });
  }));
}

/** 集計のまとめ方。キーは画面から来る値、値はSQLの式（決まった値だけを通す） */
const GROUPS = {
  cat_large: 'r.cat_large',
  equip: 'r.equip_name',
  branch: 'r.branch',
  corp: 'r.corp_name',
  day: 'r.sale_date',
};

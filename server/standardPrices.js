/**
 * 全国基準価格表（マスター）。
 *
 * 器種 × 区分（大手法人・中規模法人・小規模法人）ごとに
 * 基準の「値上後単価」を持つ。案件で営業担当者が区分を選ぶと、
 * この表の値上後単価がその案件の目標値上げ単価になる。
 *
 * Excelの構成:
 *   ・「全国基準価格」シート … 全器種。6行目に区分の見出し、7行目に小見出し
 *   ・「北海道」などの地域シート … 地域だけ単価が違う器種。全国より優先する
 * 見出し行の位置やシート名は変わりうるため、行の中身から探す。
 */
import XLSX from 'xlsx';
import { db } from './db.js';
import { prefRank } from './prefOrder.js';

/** 区分。表の見出しに含まれる語で見分ける */
export const KUBUNS = ['大手', '中規模', '小規模'];

/** 器種名の突き合わせ用の正規化（全角→半角、括弧・空白・記号を除去） */
export function modelKey(raw) {
  let s = String(raw ?? '');
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[\s　()（）\[\]【】・.,、。_\-ー―－〜~]/g, '');
  return s.toUpperCase();
}

/** シートから基準価格の行を取り出す */
function parseSheet(ws, region) {
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // 区分の見出し行（「大手」を含むセルがある行）と、その下の小見出し行を探す
  let groupRow = -1;
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    if ((grid[i] || []).some((c) => String(c ?? '').includes('大手'))) { groupRow = i; break; }
  }
  if (groupRow < 0) return [];
  const groups = [];
  (grid[groupRow] || []).forEach((c, i) => {
    const text = String(c ?? '');
    for (const k of KUBUNS) {
      if (text.includes(k)) groups.push({ kubun: k, start: i, note: text.trim() });
    }
  });
  if (!groups.length) return [];
  const sub = grid[groupRow + 1] || [];
  // 区分ごとに「現単価」「値上後」の列位置を小見出しから求める
  for (let g = 0; g < groups.length; g++) {
    const from = groups[g].start;
    const to = g + 1 < groups.length ? groups[g + 1].start : sub.length;
    for (let i = from; i < to; i++) {
      const t = String(sub[i] ?? '').replace(/\s/g, '');
      if (t.includes('現単価') && groups[g].current == null) groups[g].current = i;
      if ((t.includes('値上後') || t.includes('値上げ後')) && groups[g].target == null) groups[g].target = i;
    }
  }

  // 名前・コードの列（区分より左側の見出しから探す）
  const heads = (grid[groupRow] || []).map((c) => String(c ?? ''));
  const subHeads = sub.map((c) => String(c ?? ''));
  const findCol = (words) => {
    for (let i = 0; i < (groups[0]?.start ?? heads.length); i++) {
      const t = (heads[i] + subHeads[i]).replace(/\s/g, '');
      if (words.some((w) => t.includes(w))) return i;
    }
    return -1;
  };
  const nameCol = findCol(['品名', '器種名']);
  const codeCol = findCol(['器種ガスコード', 'ガスコード']);
  const catCol = 0;   // 先頭列に【給湯器】などのカテゴリが入る（無ければ null になるだけ）
  if (nameCol < 0) return [];

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const rows = [];
  let category = null;
  for (let i = groupRow + 2; i < grid.length; i++) {
    const r = grid[i] || [];
    const name = String(r[nameCol] ?? '').trim();
    if (r[catCol]) category = String(r[catCol]).trim();
    if (!name) continue;
    for (const g of groups) {
      const target = num(r[g.target]);
      if (target == null) continue;   // 値上後が無い区分は登録しない
      rows.push({
        region,
        category,
        model_gas_code: r[codeCol] != null ? String(r[codeCol]).trim() : null,
        model_name: name,
        model_key: modelKey(name),
        kubun: g.kubun,
        kubun_note: g.note,
        current_price: num(r[g.current]),
        target_price: target,
      });
    }
  }
  return rows;
}

/** ブック全体を読む。1枚目を全国、他のシートをシート名の地域として扱う */
export function parseStandardWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  wb.SheetNames.forEach((name, idx) => {
    const region = idx === 0 ? '全国' : name.trim();
    rows.push(...parseSheet(wb.Sheets[name], region));
  });
  if (!rows.length) {
    throw new Error('基準価格の行が見つかりません。「品名」と「大手法人」「値上後」の見出しがあるシートが必要です');
  }
  return rows;
}

/** マスターを丸ごと入れ替える（価格改定のたびに表ごと差し替える運用のため） */
export async function replaceStandardPrices(rows, filename, userId) {
  const stamp = new Date().toISOString();
  const statements = [
    { sql: 'DELETE FROM standard_prices', params: [] },
    ...rows.map((r) => ({
      sql: `INSERT INTO standard_prices
              (region, category, model_gas_code, model_name, model_key, kubun, kubun_note,
               current_price, target_price, source_file, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      params: [r.region, r.category, r.model_gas_code, r.model_name, r.model_key, r.kubun,
        r.kubun_note ?? null, r.current_price, r.target_price, filename ?? null, stamp],
    })),
  ];
  await db.batch(statements);
  await db.run(
    `INSERT INTO settings (key, value) VALUES ('standard_prices_meta', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify({ filename, count: rows.length, updatedAt: stamp, updatedBy: userId ?? null })]
  );
  return rows.length;
}

/**
 * マスター全体を器種単位でまとめた索引。
 * 一覧の各行と突き合わせるため、1回のSELECTで読み込んでメモリ上で照合する
 * （マスターは器種×区分で高々数百行）。
 */
export async function loadStandardIndex() {
  const rows = await db.all('SELECT * FROM standard_prices');
  // region → [ { model_key, model_name, codes:Set, targets:{区分→値上後} } ]
  const byRegion = new Map();
  for (const r of rows) {
    if (!byRegion.has(r.region)) byRegion.set(r.region, new Map());
    const models = byRegion.get(r.region);
    if (!models.has(r.model_key)) {
      models.set(r.model_key, {
        model_key: r.model_key, model_name: r.model_name, category: r.category,
        region: r.region, codes: new Set(), targets: {},
      });
    }
    const m = models.get(r.model_key);
    if (r.model_gas_code) m.codes.add(String(r.model_gas_code).trim());
    m.targets[r.kubun] = Number(r.target_price);
  }
  return { empty: rows.length === 0, byRegion };
}

/** 案件の器種ガスコードの候補（器種コード＋ガスコード。ガスコードは3桁詰めも試す） */
function dealCodes(deal) {
  if (deal.model_code == null || deal.gas_code == null) return [];
  const m = String(deal.model_code).trim();
  const g = String(deal.gas_code).trim();
  if (!m || !g) return [];
  return [m + g, m + g.padStart(3, '0')];
}

/**
 * 類似器種の判別。
 *
 * 完全一致（コード → 正規化した品名）を最優先にし、無ければ
 * 「片方がもう片方の先頭に一致する」（例: PH-2015AW と PH-2015AW（K））か、
 * 「共通の先頭部分が十分に長い」（例: FH-2013SAW-1 と FH-2013SAW-2）ものを
 * 類似として当てる。中身の離れた器種まで結び付けないよう、先頭一致に限る。
 *
 * 北海道の支店は北海道シートを優先する。ただし完全一致は地域をまたいでも
 * 類似より優先する（類似の思い込みで別地域の正しい単価を隠さないため）。
 *
 * 戻り値: { model_name, region, kind: 'code'|'name'|'similar', targets } または null
 */
export function matchStandardModel(index, deal) {
  if (!index || index.empty) return null;
  const regions = prefRank(deal.branch) === 1 ? ['北海道', '全国'] : ['全国'];
  const codes = dealCodes(deal);
  const nameKey = modelKey(deal.model_name);

  const hit = (m, kind) =>
    ({ model_name: m.model_name, region: m.region, kind, targets: m.targets });

  // 1) 完全一致（コード → 品名）
  for (const region of regions) {
    const models = index.byRegion.get(region);
    if (!models) continue;
    for (const m of models.values()) {
      if (codes.some((c) => m.codes.has(c))) return hit(m, 'code');
    }
    if (nameKey && models.has(nameKey)) return hit(models.get(nameKey), 'name');
  }

  // 2) 類似（先頭一致）。品名が短すぎると何にでも当たるため5文字以上に限る
  if (!nameKey || nameKey.length < 5) return null;
  for (const region of regions) {
    const models = index.byRegion.get(region);
    if (!models) continue;
    let best = null;
    let bestScore = 0;
    for (const m of models.values()) {
      const k = m.model_key;
      if (!k || k.length < 5) continue;
      let score = 0;
      if (nameKey.startsWith(k) || k.startsWith(nameKey)) {
        // 片方が片方の先頭そのもの。重なりが長いものを採る
        score = 1000 + Math.min(k.length, nameKey.length);
      } else {
        let p = 0;
        while (p < k.length && p < nameKey.length && k[p] === nameKey[p]) p++;
        // 末尾の枝番違い程度まで（共通部分が両方の85%以上）
        if (p >= 6 && p >= Math.max(k.length, nameKey.length) * 0.85) score = 500 + p;
      }
      if (score > bestScore) { bestScore = score; best = m; }
    }
    if (best) return hit(best, 'similar');
  }
  return null;
}

/**
 * 案件に対応する基準価格を探す（区分の選択時に使う）。
 *
 * 器種の判別は matchStandardModel と同じ（一覧の表示と結果がずれないように）。
 * 器種は当たったが選んだ区分の単価が無い場合は target_price: null で返し、
 * 呼び出し側が器種名入りの案内を出せるようにする。
 */
export async function findStandardPrice(deal, kubun) {
  const index = await loadStandardIndex();
  const m = matchStandardModel(index, deal);
  if (!m) return null;
  return {
    model_name: m.model_name,
    region: m.region,
    kind: m.kind,
    target_price: m.targets[kubun] ?? null,
  };
}

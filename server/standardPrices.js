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
 * 案件に対応する基準価格の行を探す。
 *
 * 突き合わせは 器種ガスコード（器種コード＋ガスコードの連結）を最優先にし、
 * 無ければ器種名（正規化）で当てる。
 * 北海道の支店は北海道シートの単価を優先し、無ければ全国を使う。
 */
export async function findStandardPrice(deal, kubun) {
  const keys = [];
  if (deal.model_code != null && deal.gas_code != null) {
    const m = String(deal.model_code).trim();
    const g = String(deal.gas_code).trim();
    keys.push(m + g, m + g.padStart(3, '0'));
  }
  const nameKey = modelKey(deal.model_name);
  const regions = prefRank(deal.branch) === 1 ? ['北海道', '全国'] : ['全国'];

  for (const region of regions) {
    if (keys.length) {
      const byCode = await db.get(
        `SELECT * FROM standard_prices
          WHERE region = ? AND kubun = ? AND model_gas_code IN (${keys.map(() => '?').join(',')})
          LIMIT 1`, [region, kubun, ...keys]);
      if (byCode) return byCode;
    }
    if (nameKey) {
      const byName = await db.get(
        'SELECT * FROM standard_prices WHERE region = ? AND kubun = ? AND model_key = ? LIMIT 1',
        [region, kubun, nameKey]);
      if (byName) return byName;
    }
  }
  return null;
}

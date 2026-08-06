import * as XLSX from 'xlsx';
import { api } from './api';

/**
 * マスタ登録（値上げ結果の集約表）の取込。
 *
 * 得意先×納入先×商品の単位で、出荷単価・数量・A基準（向こう3か月の申請単価）を
 * 案件として取り込む。Vercelは本文が約4.5MBまでのため、ブラウザで読み取り、
 * 小分けにして送る（一括取込と同じ考え方）。
 */

export interface AggRow {
  agg_key: string;
  customer_code: string;
  customer_name: string;
  delivery_name: string;
  model_code: string;
  model_name: string;
  gas_type: string;
  equip_name: string;
  category_name: string;
  list_price: unknown;
  sales_person: string;
  office: string;
  branch: string;
  base_price: unknown;
  qty: unknown;
  cost_price: unknown;
  a_price_m1: unknown;
  a_price_m2: unknown;
  a_price_m3: unknown;
}

export interface AggParsed {
  rows: AggRow[];
  skippedRows: number;
  meta: { m1: string; m2: string; m3: string; basePeriod: string };
}

/** Excelの日付シリアルを「YYYY-MM」へ。日付でなければそのまま文字列にする */
function serialToYm(v: unknown): string {
  const n = Number(v);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    const dt = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return String(v ?? '').trim();
}

/** 集約表を読み取り、送る行に変換する */
export async function parseAggFile(file: File): Promise<AggParsed> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (!grid.length) throw new Error('シートが空です');

  const headers = (grid[0] ?? []).map((h) => String(h ?? '').trim());
  const find = (name: string) => headers.findIndex((h) => h === name);
  const findLike = (word: string) => headers.findIndex((h) => h.includes(word));

  const col = {
    customer_code: find('得意先コード'),
    customer_name: find('得意先名'),
    delivery_code: find('納入先コード'),
    delivery_name: find('納入先名'),
    model_code: find('商品コード'),
    model_name: find('器種名'),
    gas_type: find('ガス種'),
    equip_name: find('器具区分名'),
    category_name: findLike('カテゴリー名'),
    list_price: find('標準単価'),
    sales_person: find('得意先担当者名'),
    office: find('得意先実績計上地区名'),
    branch: find('得意先実績計上支店名'),
    base_price: findLike('出荷単価'),
    qty: findLike('売上数'),
    cost_price: find('実績原価'),
    m1: findLike('翌月'),
    m2: findLike('翌々月'),
    m3: headers.findIndex((h) => h.replace(/[３3]/, '3').includes('3か月後') || h.includes('３か月後')),
  };
  const missing = Object.entries(col)
    .filter(([k, i]) => i < 0 && k !== 'cost_price')
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`集約表の見出しが見つかりません: ${missing.join(', ')}。`
      + '「得意先コード」「商品コード」「翌月」などの見出しがあるシートが必要です');
  }
  // 「翌々月」は「翌月」を含むため、翌月の列は翌々月と別であることを確かめる
  if (col.m1 === col.m2) {
    col.m1 = headers.findIndex((h, i) => h === '翌月' && i !== col.m2);
    if (col.m1 < 0) throw new Error('「翌月」の列が見つかりません');
  }

  const txt = (r: unknown[], i: number) => String(r[i] ?? '').trim();
  const rows: AggRow[] = [];
  let skippedRows = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const cust = txt(r, col.customer_code);
    const model = txt(r, col.model_code);
    if (!cust || !model) { if (r.some((v) => v != null)) skippedRows++; continue; }
    const deli = txt(r, col.delivery_code);
    rows.push({
      agg_key: `${cust}|${deli}|${model}`,
      customer_code: cust,
      customer_name: txt(r, col.customer_name),
      delivery_name: txt(r, col.delivery_name),
      model_code: model,
      model_name: txt(r, col.model_name),
      gas_type: txt(r, col.gas_type),
      equip_name: txt(r, col.equip_name),
      category_name: txt(r, col.category_name),
      list_price: r[col.list_price],
      sales_person: txt(r, col.sales_person),
      office: txt(r, col.office),
      branch: txt(r, col.branch),
      base_price: r[col.base_price],
      qty: r[col.qty],
      cost_price: col.cost_price >= 0 ? r[col.cost_price] : null,
      a_price_m1: r[col.m1 + 1],   // 「翌月」の右隣がその月のマスタ単価
      a_price_m2: r[col.m2 + 1],
      a_price_m3: r[col.m3 + 1],
    });
  }
  if (!rows.length) throw new Error('取り込める行がありません');

  const first = grid[1] ?? [];
  const meta = {
    m1: serialToYm(first[col.m1]),
    m2: serialToYm(first[col.m2]),
    m3: serialToYm(first[col.m3]),
    basePeriod: headers[col.base_price].replace(/出荷単価/, '').trim() || headers[col.base_price],
  };
  return { rows, skippedRows, meta };
}

const CHUNK = 500;

export interface AggResult {
  inserted: number;
  updated: number;
  removed: number;
  total: number;
}

/** 小分けにして送り、最後に置き換え（旧形式の行の削除）まで行う */
export async function sendAggImport(
  parsed: AggParsed,
  filename: string,
  opts: { removeOld: boolean; onProgress?: (done: number, total: number) => void }
): Promise<AggResult> {
  const { batchId, removed } = await api<{ batchId: number; removed: number }>('/agg-import/start', {
    method: 'POST',
    body: JSON.stringify({ filename, meta: parsed.meta, removeOld: opts.removeOld }),
  });
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    const r = await api<{ inserted: number; updated: number }>('/agg-import/chunk', {
      method: 'POST',
      body: JSON.stringify({ batchId, rows: parsed.rows.slice(i, i + CHUNK) }),
    });
    inserted += r.inserted;
    updated += r.updated;
    opts.onProgress?.(Math.min(i + CHUNK, parsed.rows.length), parsed.rows.length);
  }
  const fin = await api<{ removed: number; total: number }>('/agg-import/finish', {
    method: 'POST',
    body: JSON.stringify({ batchId }),
  });
  return { inserted, updated, removed: removed + fin.removed, total: fin.total };
}

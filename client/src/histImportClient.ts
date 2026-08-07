import * as XLSX from 'xlsx';
import { api } from './api';

/**
 * 出荷実績（月別履歴）の取込。案件一覧の土台になる。
 *
 * 法人グループ×品目の単位で、期間全体の平均出荷単価と数量合計を取り込み、
 * その単位で案件の行を作る。マスタ登録（A基準）はあとから重ねる。
 */

export interface HistRow {
  ent_cd: string;
  corp_name: string;
  model_code: string;
  model_name: string;
  equip_name: string;
  avg_price: unknown;
  qty: unknown;
}

export interface HistParsed {
  corps: [string, string][];   // [法人グループコード, 法人名]
  rows: HistRow[];
  period: string;              // 例: 2025/07〜2026/06
}

export async function parseHistFile(file: File): Promise<HistParsed> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (grid.length < 3) throw new Error('シートにデータがありません');

  const months = (grid[0] ?? []).map((v) => String(v ?? '')).filter((v) => /^\d{4}\/\d{2}$/.test(v));
  const row0 = (grid[0] ?? []).map((v) => String(v ?? ''));
  const heads = (grid[1] ?? []).map((v) => String(v ?? ''));
  const cd = heads.findIndex((h) => h === 'i_ent_gr_cd');
  const nameCol = heads.findIndex((h) => h.includes('店コードマスタ'));
  const equipCol = heads.findIndex((h) => h.includes('器具区分'));
  const prod = heads.findIndex((h) => h === 'i_product_cd');
  const prodName = heads.findIndex((h) => h === 'i_product_name');
  const totalAvg = row0.findIndex((h) => h.includes('全体') && h.includes('平均単価'));
  const totalQty = row0.findIndex((h) => h.includes('全体') && h.includes('売上数'));
  if (cd < 0 || nameCol < 0 || prod < 0 || totalAvg < 0 || totalQty < 0) {
    throw new Error('見出しが見つかりません。i_ent_gr_cd・i_product_cd・「全体の 平均単価」「全体の 売上数」のあるファイルが必要です');
  }

  const corps = new Map<string, string>();
  const rows: HistRow[] = [];
  const seen = new Set<string>();
  for (let i = 2; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const code = String(r[cd] ?? '').trim();
    const product = String(r[prod] ?? '').trim();
    if (!code || !product) continue;
    const corpName = String(r[nameCol] ?? '').trim();
    if (!corps.has(code)) corps.set(code, corpName);
    const key = `${code}|${product}`;
    if (seen.has(key)) continue;   // 同じ法人×品目が重複していたら最初の行を使う
    seen.add(key);
    rows.push({
      ent_cd: code,
      corp_name: corpName,
      model_code: product,
      model_name: String(r[prodName] ?? '').trim(),
      equip_name: equipCol >= 0 ? String(r[equipCol] ?? '').trim() : '',
      avg_price: r[totalAvg],
      qty: r[totalQty],
    });
  }
  if (!rows.length) throw new Error('取り込める行がありません');
  const period = months.length ? `${months[0]}〜${months[months.length - 1]}` : '';
  return { corps: [...corps.entries()], rows, period };
}

const CHUNK = 500;

export interface HistResult {
  inserted: number;
  updated: number;
  removed: number;
  total: number;
}

export async function sendHistImport(
  parsed: HistParsed,
  filename: string,
  onProgress?: (done: number, total: number) => void
): Promise<HistResult> {
  const { batch } = await api<{ batch: string }>('/hist-import/start', {
    method: 'POST',
    body: JSON.stringify({ filename, period: parsed.period, corps: parsed.corps }),
  });
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    const r = await api<{ inserted: number; updated: number }>('/hist-import/chunk', {
      method: 'POST',
      body: JSON.stringify({ batch, rows: parsed.rows.slice(i, i + CHUNK) }),
    });
    inserted += r.inserted;
    updated += r.updated;
    onProgress?.(Math.min(i + CHUNK, parsed.rows.length), parsed.rows.length);
  }
  const fin = await api<{ removed: number; total: number }>('/hist-import/finish', {
    method: 'POST', body: JSON.stringify({ batch }),
  });
  return { inserted, updated, removed: fin.removed, total: fin.total };
}

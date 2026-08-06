import * as XLSX from 'xlsx';
import { api } from './api';

/**
 * 出荷実績（月別履歴）の取込。
 *
 * 法人グループ×商品の単位で、期間全体の「平均単価」「数量合計」を
 * 案件の参照列として付ける。法人はサーバー側で名前の照合により
 * マスタ登録の法人（得意先）へ対応づける。品目は商品コードで一致させる。
 */

export interface HistParsed {
  corps: [string, string][];                       // [法人グループコード, 法人名]
  rows: [string, string, unknown, unknown][];      // [コード, 商品コード, 平均単価, 数量合計]
  period: string;                                  // 例: 2025/07〜2026/06
}

export async function parseHistFile(file: File): Promise<HistParsed> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (grid.length < 3) throw new Error('シートにデータがありません');

  const months = (grid[0] ?? []).map((v) => String(v ?? '')).filter((v) => /^\d{4}\/\d{2}$/.test(v));
  const heads = (grid[1] ?? []).map((v) => String(v ?? ''));
  const cd = heads.findIndex((h) => h === 'i_ent_gr_cd');
  const nameCol = heads.findIndex((h) => h.includes('店コードマスタ'));
  const prod = heads.findIndex((h) => h === 'i_product_cd');
  // 右端の「全体の 平均単価」「全体の 売上数」（1行目の見出しに「全体」と入る）
  const row0 = (grid[0] ?? []).map((v) => String(v ?? ''));
  const totalAvg = row0.findIndex((h) => h.includes('全体') && h.includes('平均単価'));
  const totalQty = row0.findIndex((h) => h.includes('全体') && h.includes('売上数'));
  if (cd < 0 || nameCol < 0 || prod < 0 || totalAvg < 0 || totalQty < 0) {
    throw new Error('見出しが見つかりません。i_ent_gr_cd・i_product_cd・「全体の 平均単価」「全体の 売上数」のあるファイルが必要です');
  }

  const corps = new Map<string, string>();
  const rows: HistParsed['rows'] = [];
  for (let i = 2; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const code = String(r[cd] ?? '').trim();
    const product = String(r[prod] ?? '').trim();
    if (!code || !product) continue;
    if (!corps.has(code)) corps.set(code, String(r[nameCol] ?? '').trim());
    rows.push([code, product, r[totalAvg], r[totalQty]]);
  }
  if (!rows.length) throw new Error('取り込める行がありません');
  const period = months.length ? `${months[0]}〜${months[months.length - 1]}` : '';
  return { corps: [...corps.entries()], rows, period };
}

const CHUNK = 1000;

export interface HistResult {
  corpsInFile: number;
  matched: number;
  dealCorps: number;
  covered: number;
  total: number;
}

export async function sendHistImport(
  parsed: HistParsed,
  filename: string,
  onProgress?: (done: number, total: number) => void
): Promise<HistResult> {
  const start = await api<{ corpsInFile: number; dealCorps: number; matched: number }>(
    '/hist-import/start',
    { method: 'POST', body: JSON.stringify({ filename, period: parsed.period, corps: parsed.corps }) });
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    await api('/hist-import/chunk', {
      method: 'POST', body: JSON.stringify({ rows: parsed.rows.slice(i, i + CHUNK) }),
    });
    onProgress?.(Math.min(i + CHUNK, parsed.rows.length), parsed.rows.length);
  }
  const fin = await api<{ covered: number; total: number }>('/hist-import/finish', {
    method: 'POST', body: JSON.stringify({}),
  });
  return { ...start, ...fin };
}

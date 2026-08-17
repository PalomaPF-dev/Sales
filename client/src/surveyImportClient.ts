import * as XLSX from 'xlsx';
import { api } from './api';

/**
 * 価格調査（実単価）の取込。
 *
 * マスタ登録と同じ 得意先×納入先×商品 の単位のファイルで、
 * 「売上単価4月」「売上単価5月」…のように月ごとの実際の単価が入っている。
 * A基準（値上げの計画）に対して、実際いくらで出たのかを並べて見るために取り込む。
 *
 * 案件は 法人×品目 の単位なので、マスタ登録と同じように法人へ集約する
 * （単価は数量で加重平均。数量はマスタ単価の売上数を重みに使う）。
 */

export interface SurveyRow {
  customer_name: string;    // 法人の照合に使う（得意先名 → 法人グループ）
  model_code: string;
  qty: unknown;             // 重み（1~3月の売上数。無ければ全行を同じ重みにする）
  /** 月ごとの実単価。meta.months と同じ並び。値の無い月は null */
  prices: (number | null)[];
}

export interface SurveyParsed {
  rows: SurveyRow[];
  skippedRows: number;
  /** 月の並び（YYYY-MM）。列の「売上単価4月」から作る */
  months: string[];
  /** 見出しのままの月名（4月・5月…）。画面の確認用 */
  monthLabels: string[];
  hasQty: boolean;
}

/** 見出しの表記ゆれを吸収する（全角数字・全角かっこ） */
function normHead(h: unknown): string {
  return String(h ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, '(').replace(/）/g, ')')
    .trim();
}

/**
 * 「4月」が何年かを決める。
 *
 * 見出しには年が無いため、マスタ登録の当月（例 2026-08）を手がかりにする。
 * 当月より後ろの月は前の年とみなす（2026-08 のとき 11月 → 2025-11）。
 * 手がかりが無ければ今年として扱う。
 */
function resolveYear(month: number, anchor: string | undefined): number {
  const m = /^(\d{4})-(\d{2})$/.exec(String(anchor ?? ''));
  if (!m) return new Date().getFullYear();
  const [ay, am] = [Number(m[1]), Number(m[2])];
  return month <= am ? ay : ay - 1;
}

/** 価格調査のファイルを読み取り、送る行に変換する */
export async function parseSurveyFile(file: File, anchorYm?: string): Promise<SurveyParsed> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (!grid.length) throw new Error('シートが空です');

  const headers = (grid[0] ?? []).map((h) => normHead(h));
  const find = (name: string) => headers.findIndex((h) => h === name);
  const findLike = (word: string) => headers.findIndex((h) => h.includes(word));

  const col = {
    customer_code: find('得意先コード'),
    customer_name: find('得意先名'),
    model_code: find('商品コード'),
  };
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) {
    throw new Error(`価格調査の見出しが見つかりません: ${missing.join(', ')}。`
      + '「得意先コード」「得意先名」「商品コード」のあるシートが必要です');
  }

  // 「売上単価4月」のような月ごとの実単価の列を集める
  const monthCols: { at: number; month: number; label: string }[] = [];
  headers.forEach((h, i) => {
    const m = /^売上単価\s*(\d{1,2})\s*月$/.exec(h);
    if (m) monthCols.push({ at: i, month: Number(m[1]), label: `${Number(m[1])}月` });
  });
  if (!monthCols.length) {
    throw new Error('「売上単価4月」のような月ごとの実単価の列がありません。'
      + '価格調査（実績追加）のファイルをお使いください');
  }
  const months = monthCols.map((mc) => {
    const y = resolveYear(mc.month, anchorYm);
    return `${y}-${String(mc.month).padStart(2, '0')}`;
  });
  // 月の順に並べ直す（列の並びが前後していても時系列にする）
  const order = months.map((ym, i) => ({ ym, i })).sort((a, b) => a.ym.localeCompare(b.ym));
  const sortedCols = order.map((o) => monthCols[o.i]);
  const sortedMonths = order.map((o) => o.ym);

  // 重み（加重平均の分母）。マスタ登録と同じ「売上数」の列を使う
  const qtyAt = findLike('売上数');

  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(String(v).replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const rows: SurveyRow[] = [];
  let skippedRows = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const cust = String(r[col.customer_code] ?? '').trim();
    const model = String(r[col.model_code] ?? '').trim();
    if (!cust || !model) { if (r.some((v) => v != null)) skippedRows++; continue; }
    const prices = sortedCols.map((mc) => num(r[mc.at]));
    // 実単価が1つも無い行は送らない（送る量を減らす。集計にも影響しない）
    if (prices.every((p) => p == null)) continue;
    rows.push({
      customer_name: String(r[col.customer_name] ?? '').trim(),
      model_code: model,
      qty: qtyAt >= 0 ? r[qtyAt] : null,
      prices,
    });
  }
  if (!rows.length) throw new Error('実単価の入った行がありません');

  return {
    rows,
    skippedRows,
    months: sortedMonths,
    monthLabels: sortedCols.map((mc) => mc.label),
    hasQty: qtyAt >= 0,
  };
}

const CHUNK = 500;

export interface SurveyResult {
  matched: number;    // 法人を照合できた行
  unmatched: number;  // 実績側に無い法人の行（重ねられない）
  covered: number;    // 実単価が入った案件の数
  total: number;      // 案件の総数
}

/**
 * 小分けにして送る。サーバー側で法人×品目へ集約し、
 * 最後に案件へ実単価（数量で加重平均）を重ねる。
 */
export async function sendSurveyImport(
  parsed: SurveyParsed,
  filename: string,
  opts: { onProgress?: (done: number, total: number) => void }
): Promise<SurveyResult> {
  await api('/survey-import/start', {
    method: 'POST',
    body: JSON.stringify({ filename, months: parsed.months }),
  });
  let matched = 0;
  let unmatched = 0;
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    const r = await api<{ matched: number; unmatched: number }>('/survey-import/chunk', {
      method: 'POST',
      body: JSON.stringify({ rows: parsed.rows.slice(i, i + CHUNK) }),
    });
    matched += r.matched;
    unmatched += r.unmatched;
    opts.onProgress?.(Math.min(i + CHUNK, parsed.rows.length), parsed.rows.length);
  }
  const fin = await api<{ covered: number; total: number }>('/survey-import/finish', {
    method: 'POST', body: JSON.stringify({}),
  });
  return { matched, unmatched, covered: fin.covered, total: fin.total };
}

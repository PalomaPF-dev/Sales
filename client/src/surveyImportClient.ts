import * as XLSX from 'xlsx';
import { api } from './api';

/**
 * 価格調査（当月実績）の取込。案件一覧の土台になる。
 *
 * 「７月数量」「７月単価」と「過去最新単価」が入ったファイルで、
 * 値上げ前（過去最新単価）から当月（7月）までに実際いくら上がったかが分かる。
 * A基準（マスタ登録）はこの当月単価に重ねて、今後の計画として比べる。
 *
 * 得意先×商品の単位で取り込み、案件は 得意先×商品 にまとめる。
 */

export interface SurveyRow {
  customer_code: string;   // 得意先コード（案件のまとまりの単位）
  customer_name: string;
  delivery_name: string;
  model_code: string;
  model_name: string;
  equip_name: string;
  category_name: string;
  list_price: unknown;     // 標準単価
  qty: unknown;            // 当月の数量
  price: unknown;          // 当月の単価
  past_price: unknown;     // 過去最新単価（値上げ前）
  past_date: string | null;// 過去最新受注日
}

export interface SurveyParsed {
  rows: SurveyRow[];
  skippedRows: number;
  /** 当月（YYYY-MM）。「７月数量」の見出しと、基準の年から決める */
  ym: string;
  monthLabel: string;      // 「7月」
  hasPast: boolean;        // 過去最新単価の列があるか
}

/** 見出しの表記ゆれを吸収する（全角数字・全角かっこ・空白） */
function normHead(h: unknown): string {
  return String(h ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[\s　_]/g, '')
    .trim();
}

/** Excelの日付を「YYYY-MM-DD」へ。日付シリアルと文字列のどちらでも来る */
function toYmd(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const n = Number(v);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  const m = String(v).trim().match(/^(\d{4})[/年-](\d{1,2})[/月-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

/**
 * 「7月」が何年かを決める。
 * 見出しには年が無いため、マスタ登録の当月（例 2026-08）を手がかりにする。
 * 手がかりより後ろの月は前の年とみなす。無ければ今年として扱う。
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

  // 「7月数量」「7月単価」から当月を決める（月は見出しから読む）
  const qtyAt = headers.findIndex((h) => /^\d{1,2}月数量$/.test(h));
  const priceAt = headers.findIndex((h) => /^\d{1,2}月単価$/.test(h));
  if (qtyAt < 0 || priceAt < 0) {
    throw new Error('「7月数量」「7月単価」のような当月の列がありません。'
      + '価格調査（当月実績）のファイルをお使いください');
  }
  const month = Number(/^(\d{1,2})月/.exec(headers[qtyAt])![1]);

  const col = {
    得意先コード: find('得意先コード'),
    商品コード: find('商品コード'),
  };
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) {
    throw new Error(`価格調査の見出しが見つかりません: ${missing.join('・')}`);
  }

  // 過去の単価（値上げ前）。無いファイルでも取り込めるようにしておく
  const pastPriceAt = findLike('過去最新単価') >= 0
    ? headers.findIndex((h) => h.includes('過去最新単価') && !h.includes('換算'))
    : -1;
  const pastDateAt = findLike('過去最新受注日');

  const at = {
    customer_name: find('得意先名'),
    delivery_name: find('納入先名'),
    model_name: findLike('品目階層名') >= 0 ? findLike('品目階層名') : find('器種名'),
    equip_name: find('器具区分名'),
    category_name: findLike('カテゴリー名'),
    list_price: find('標準単価'),
  };
  const txt = (r: unknown[], i: number) => (i >= 0 ? String(r[i] ?? '').trim() : '');

  const rows: SurveyRow[] = [];
  let skippedRows = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const cust = String(r[col.得意先コード] ?? '').trim();
    const model = String(r[col.商品コード] ?? '').trim();
    if (!cust || !model) { if (r.some((v) => v != null)) skippedRows++; continue; }
    rows.push({
      customer_code: cust,
      customer_name: txt(r, at.customer_name),
      delivery_name: txt(r, at.delivery_name),
      model_code: model,
      model_name: txt(r, at.model_name),
      equip_name: txt(r, at.equip_name),
      category_name: txt(r, at.category_name),
      list_price: at.list_price >= 0 ? r[at.list_price] : null,
      qty: r[qtyAt],
      price: r[priceAt],
      past_price: pastPriceAt >= 0 ? r[pastPriceAt] : null,
      past_date: pastDateAt >= 0 ? toYmd(r[pastDateAt]) : null,
    });
  }
  if (!rows.length) throw new Error('取り込める行がありません');

  const year = resolveYear(month, anchorYm);
  return {
    rows,
    skippedRows,
    ym: `${year}-${String(month).padStart(2, '0')}`,
    monthLabel: `${month}月`,
    hasPast: pastPriceAt >= 0,
  };
}

const CHUNK = 500;

export interface SurveyResult {
  matched: number;    // 取り込んだ行
  unmatched: number;  // 得意先が空などで取り込めなかった行
  covered: number;    // 当月単価の入った案件の数
  total: number;      // 案件の総数
  removed?: number;   // 今回のファイルに無くなって消えた案件
}

export async function sendSurveyImport(
  parsed: SurveyParsed,
  filename: string,
  opts: { onProgress?: (done: number, total: number) => void }
): Promise<SurveyResult> {
  const started = await api<{ batch?: string }>('/survey-import/start', {
    method: 'POST',
    body: JSON.stringify({ filename, ym: parsed.ym }),
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
  const fin = await api<{ covered: number; total: number; removed?: number }>(
    '/survey-import/finish', { method: 'POST', body: JSON.stringify({ batch: started.batch }) });
  return { matched, unmatched, covered: fin.covered, total: fin.total, removed: fin.removed };
}

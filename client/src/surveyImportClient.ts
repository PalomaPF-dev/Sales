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
  corp_code: string;        // 法人コード（案件のまとまりの単位）
  corp_name: string;        // 法人名
  customer_name: string;    // 得意先名
  model_code: string;
  model_name: string;
  equip_name: string;
  gas_type: string;
  branch: string;
  office: string;
  sales_person: string;
  cost_price: unknown;      // 実績原価（管理者だけが見る列）
  qty: unknown;             // 1~3月の売上数（3か月分の合計）。加重平均の重みにも使う
  base_price: unknown;      // 1-3月出荷単価（現状単価）。無ければ null
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
  /** 「1-3月出荷単価」の列があるか（現状単価もこのファイルから取り込める） */
  hasBase: boolean;
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

  // 法人はこのファイルの法人コード・法人名で決める（法人グループは使わない）。
  // 「法人グループコード」のような書き方でも拾えるようにしておく
  const corpCodeAt = headers.findIndex((h) => h.includes('法人') && h.includes('コード'));
  const corpNameAt = headers.findIndex((h) => h.includes('法人') && h.includes('名'));
  const col = {
    法人コード: corpCodeAt,
    法人名: corpNameAt,
    得意先名: find('得意先名'),
    商品コード: find('商品コード'),
  };
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) {
    throw new Error(`価格調査の見出しが見つかりません: ${missing.join('・')}。`
      + '「法人コード」「法人名」「得意先名」「商品コード」のあるシートが必要です');
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

  // 現状単価（1-3月出荷単価）。「最新出荷単価」は今の単価ではないので外す。
  // この列があれば、現状の単価・数量もこのファイルから取り込む
  const baseAt = headers.findIndex((h) => h.includes('出荷単価') && !h.includes('最新'));

  // 案件の行（法人×品目）をこのファイルから作るための項目。
  // 無い列は空のまま取り込む（一覧の表示が空欄になるだけで、集計には影響しない）
  const at = {
    model_name: find('器種名'),
    equip_name: find('器具区分名'),
    gas_type: find('ガス種'),
    branch: find('得意先実績計上支店名'),
    office: find('得意先実績計上地区名'),
    sales_person: find('得意先担当者名'),
    cost_price: find('実績原価'),
  };
  const txt = (r: unknown[], i: number) => (i >= 0 ? String(r[i] ?? '').trim() : '');

  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(String(v).replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const rows: SurveyRow[] = [];
  let skippedRows = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const corp = String(r[col.法人コード] ?? '').trim();
    const model = String(r[col.商品コード] ?? '').trim();
    if (!corp || !model) { if (r.some((v) => v != null)) skippedRows++; continue; }
    const prices = sortedCols.map((mc) => num(r[mc.at]));
    rows.push({
      corp_code: corp,
      corp_name: String(r[col.法人名] ?? '').trim(),
      customer_name: String(r[col.得意先名] ?? '').trim(),
      model_code: model,
      model_name: txt(r, at.model_name),
      equip_name: txt(r, at.equip_name),
      gas_type: txt(r, at.gas_type),
      branch: txt(r, at.branch),
      office: txt(r, at.office),
      sales_person: txt(r, at.sales_person),
      cost_price: at.cost_price >= 0 ? r[at.cost_price] : null,
      qty: qtyAt >= 0 ? r[qtyAt] : null,
      base_price: baseAt >= 0 ? r[baseAt] : null,
      prices,
    });
  }
  if (!rows.length) throw new Error('取り込める行がありません');

  return {
    rows,
    skippedRows,
    months: sortedMonths,
    monthLabels: sortedCols.map((mc) => mc.label),
    hasQty: qtyAt >= 0,
    hasBase: baseAt >= 0,
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
  const started = await api<{ batch?: string }>('/survey-import/start', {
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
  const fin = await api<{ covered: number; total: number; removed?: number }>('/survey-import/finish', {
    method: 'POST', body: JSON.stringify({ batch: started.batch }),
  });
  return { matched, unmatched, covered: fin.covered, total: fin.total };
}

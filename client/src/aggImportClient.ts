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
  customer_code: string;   // 案件の突き合わせに使う（得意先×商品）
  customer_name: string;
  model_code: string;
  // 支店・営業所・担当者。法人×品目にまとめるときは数量の一番多い行を代表にする
  branch: string;
  office: string;
  sales_person: string;
  qty: unknown;
  base_price: unknown;
  cost_price: unknown;
  a_price_m0: unknown;
  a_price_m1: unknown;
  a_price_m2: unknown;
  a_price_m3: unknown;
  // A基準それぞれの承認日（マスタ登録の「登録日」）。YYYY-MM-DD
  a_date_m0: string | null;
  a_date_m1: string | null;
  a_date_m2: string | null;
  a_date_m3: string | null;
  // A基準それぞれの稟議No（「稟議」を含む列があれば入る。無いファイルでは空）
  a_ringi_m0: string | null;
  a_ringi_m1: string | null;
  a_ringi_m2: string | null;
  a_ringi_m3: string | null;
}

export interface AggParsed {
  rows: AggRow[];
  skippedRows: number;
  hasM0: boolean;      // 「当月」の列があるファイルか
  hasDates: boolean;   // 「登録日（〜）」の列があるファイルか
  hasRingi: boolean;   // 「稟議」の列があるファイルか
  meta: { m0: string; m1: string; m2: string; m3: string; basePeriod: string };
}

/**
 * Excelの日付を「YYYY-MM-DD」へ。
 * 日付シリアル（46266）と文字列（2026/06/05）のどちらでも来る。
 */
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

/** 月の見出しの値を「YYYY-MM」へ。日付として読めなければそのまま文字列にする */
function serialToYm(v: unknown): string {
  const ymd = toYmd(v);
  return ymd ? ymd.slice(0, 7) : String(v ?? '').trim();
}

/** 見出しの表記ゆれを吸収する（全角数字・全角かっこ） */
function normHead(h: unknown): string {
  return String(h ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, '(').replace(/）/g, ')')
    .trim();
}

/**
 * 中身のあるシートと見出しの行を選ぶ。
 * 先頭シートが空（表紙だけ）のブックや、見出しの上に表題が載っている形式でも
 * 「シートが空です」で止まらず、目印の見出しがある行から読み始める。
 */
function sheetRows(ws: XLSX.WorkSheet | undefined): unknown[][] {
  if (!ws) return [];
  const g: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (g.length) return g;
  // データ範囲（!ref）が壊れて「空」に見えるファイルがある。
  // 実際のセルから範囲を数え直して、もう一度読む
  const dense = (ws as { '!data'?: { length: number }[][] })['!data'];
  if (dense?.length) {
    // dense（行の配列）のときは行数と一番長い行から範囲を作る
    let maxC = 0;
    for (const row of dense) maxC = Math.max(maxC, row?.length ?? 0);
    if (!maxC) return [];
    ws['!ref'] = XLSX.utils.encode_range(
      { s: { r: 0, c: 0 }, e: { r: dense.length - 1, c: maxC - 1 } });
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  }
  let maxR = -1;
  let maxC = -1;
  for (const k of Object.keys(ws)) {
    if (k.startsWith('!')) continue;
    const a = XLSX.utils.decode_cell(k);
    if (a.r > maxR) maxR = a.r;
    if (a.c > maxC) maxC = a.c;
  }
  if (maxR < 0) return [];
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
}

function pickGrid(wb: XLSX.WorkBook, needles: string[]): unknown[][] {
  let fallback: unknown[][] | null = null;
  for (const name of wb.SheetNames) {
    const g = sheetRows(wb.Sheets[name]);
    if (!g.length || !g.some((r) => (r ?? []).some((v) => v != null && v !== ''))) continue;
    // 見出しの行を先頭50行から探す（表題や説明が上に載っている形式も読めるように）
    for (let i = 0; i < Math.min(50, g.length); i++) {
      const heads = (g[i] ?? []).map((h) => normHead(h));
      if (needles.every((n) => heads.some((h) => h.includes(n)))) return g.slice(i);
    }
    fallback ??= g;
  }
  if (!fallback) {
    // どのシートからも読めなかった。原因を追えるよう、シートの中身を添える
    const info = wb.SheetNames.map((n) => {
      const ws = wb.Sheets[n];
      const cells = ws ? Object.keys(ws).filter((k) => !k.startsWith('!')).length : 0;
      const denseRows = (ws as unknown as { '!data'?: unknown[] } | undefined)?.['!data']?.length ?? 0;
      return `${n}(セル${(cells + denseRows).toLocaleString()}・範囲${ws?.['!ref'] ?? 'なし'})`;
    }).join(' / ');
    throw new Error(`どのシートからも行を読み取れませんでした。シートの中身: ${info}。`
      + 'この文言を開発側に伝えてください');
  }
  return fallback;
}

/** 集約表を読み取り、送る行に変換する */
export async function parseAggFile(file: File): Promise<AggParsed> {
  const buf = await file.arrayBuffer();
  // 大きいファイル向けの読み方。行の配列として持ち（dense）、
  // 数式・書式文字列など取込に使わないものは読まない。数十MBでも数十秒で読める
  const wb = XLSX.read(buf, {
    type: 'array', dense: true, cellHTML: false, cellFormula: false, cellText: false,
  });
  // 先頭シートが空でも、得意先コード・商品コードの見出しがあるシートを探して読む
  const grid = pickGrid(wb, ['得意先コード', '商品コード']);

  const headers = (grid[0] ?? []).map((h) => normHead(h));
  const find = (name: string) => headers.findIndex((h) => h === name);
  const findLike = (word: string) => headers.findIndex((h) => h.includes(word));
  /** 複数の呼び方のどれかで探す（ファイルの版で見出しが揺れるため） */
  const findAny = (...names: string[]) => {
    for (const n of names) { const i = find(n); if (i >= 0) return i; }
    return -1;
  };
  /** 2つの言葉を両方含む見出しを探す（「得意先実績計上支店名」の揺れ対策） */
  const findBoth = (a: string, b: string) =>
    headers.findIndex((h) => h.includes(a) && h.includes(b));

  /**
   * 月のまとまりを読む。見出しは「当月・マスタ単価・登録日(当月)・ＷＦ申請番号１…」の
   * 並びで、月の見出しから次の月の見出しまでを1つのまとまりとして、
   * その中からマスタ単価・登録日（承認日）・稟議Noの列を探す。
   * 稟議Noの列名は「ＷＦ申請番号」（値上げ申請ワークフローの番号）。
   * 「稟議」と書かれた形式でも読めるようにしている。登録日や稟議Noの無い古い形式も可。
   */
  const RINGI_RE = /稟議|申請番号/;
  const MONTH_LABELS = ['当月', '翌月', '翌々月', '3か月後'];
  const monthCols = (label: string) => {
    const at = find(label);
    if (at < 0) return null;
    let end = headers.length;
    for (let i = at + 1; i < headers.length; i++) {
      if (MONTH_LABELS.includes(headers[i])) { end = i; break; }
    }
    const within = (pred: (h: string) => boolean) => {
      for (let i = at + 1; i < end; i++) if (pred(headers[i])) return i;
      return -1;
    };
    const price = within((h) => h.includes('マスタ単価'));
    return {
      at,
      price: price >= 0 ? price : at + 1,
      date: within((h) => h.includes('登録日')),
      ringi: within((h) => RINGI_RE.test(h)),
    };
  };

  const col = {
    customer_code: find('得意先コード'),
    customer_name: find('得意先名'),
    delivery_code: find('納入先コード'),
    delivery_name: find('納入先名'),
    model_code: find('商品コード'),
    // 器種名／機種名は版によって呼び方が違う
    model_name: findAny('器種名', '機種名'),
    gas_type: find('ガス種'),
    equip_name: findAny('器具区分名', '器具区分'),
    category_name: findLike('カテゴリー名'),
    list_price: find('標準単価'),
    // 担当・支店・地区は無い版もある。無ければ空のまま（案件の値が残る）
    sales_person: findAny('得意先担当者名', '得意先担当'),
    office: findBoth('得意先', '地区') >= 0 ? findBoth('得意先', '地区') : findLike('地区名'),
    branch: findBoth('得意先', '支店') >= 0 ? findBoth('得意先', '支店') : findLike('支店名'),
    base_price: findLike('出荷単価'),
    qty: findLike('売上数'),
    cost_price: find('実績原価'),
  };
  // 担当・支店・地区・原価は任意（無いファイルでも取り込める）
  const OPTIONAL = new Set(['cost_price', 'sales_person', 'office', 'branch',
    'delivery_code', 'delivery_name', 'gas_type', 'category_name', 'list_price']);
  const missing = Object.entries(col)
    .filter(([k, i]) => i < 0 && !OPTIONAL.has(k))
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`集約表の見出しが見つかりません: ${missing.join(', ')}。`
      + '「得意先コード」「商品コード」「翌月」などの見出しがあるシートが必要です');
  }

  // 当月は無いファイルもある（8月6日版まで）。翌月・翌々月・3か月後は必須
  const m0 = monthCols('当月');
  const m1 = monthCols('翌月');
  const m2 = monthCols('翌々月');
  const m3 = monthCols('3か月後');
  const noMonth = [['翌月', m1], ['翌々月', m2], ['3か月後', m3]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (noMonth.length) {
    throw new Error(`集約表に「${noMonth.join('」「')}」の見出しがありません。`
      + '価格申請（向こう3か月の単価）のあるシートが必要です');
  }

  // 月のまとまりの外に稟議No列が1つだけある形式なら、全部の月に同じ番号を使う
  const firstMonthAt = Math.min(...[m0, m1, m2, m3].filter(Boolean).map((m) => m!.at));
  const globalRingi = headers.findIndex((h, i) => RINGI_RE.test(h) && i < firstMonthAt);
  const ringiOf = (m: { ringi: number } | null) =>
    (m && m.ringi >= 0 ? m.ringi : globalRingi);

  const txt = (r: unknown[], i: number) => String(r[i] ?? '').trim();
  const at = (r: unknown[], i: number) => (i >= 0 ? r[i] : null);
  const rows: AggRow[] = [];
  let skippedRows = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const cust = txt(r, col.customer_code);
    const model = txt(r, col.model_code);
    if (!cust || !model) { if (r.some((v) => v != null)) skippedRows++; continue; }
    rows.push({
      customer_code: cust,
      customer_name: txt(r, col.customer_name),
      model_code: model,
      branch: txt(r, col.branch),
      office: txt(r, col.office),
      sales_person: txt(r, col.sales_person),
      qty: r[col.qty],
      base_price: r[col.base_price],
      cost_price: col.cost_price >= 0 ? r[col.cost_price] : null,
      a_price_m0: at(r, m0 ? m0.price : -1),
      a_price_m1: r[m1!.price],
      a_price_m2: r[m2!.price],
      a_price_m3: r[m3!.price],
      a_date_m0: toYmd(at(r, m0 ? m0.date : -1)),
      a_date_m1: toYmd(at(r, m1!.date)),
      a_date_m2: toYmd(at(r, m2!.date)),
      a_date_m3: toYmd(at(r, m3!.date)),
      a_ringi_m0: txt(r, ringiOf(m0)) || null,
      a_ringi_m1: txt(r, ringiOf(m1)) || null,
      a_ringi_m2: txt(r, ringiOf(m2)) || null,
      a_ringi_m3: txt(r, ringiOf(m3)) || null,
    });
  }
  if (!rows.length) throw new Error('取り込める行がありません');

  const first = grid[1] ?? [];
  const meta = {
    m0: m0 ? serialToYm(first[m0.at]) : '',
    m1: serialToYm(first[m1!.at]),
    m2: serialToYm(first[m2!.at]),
    m3: serialToYm(first[m3!.at]),
    basePeriod: headers[col.base_price].replace(/出荷単価/, '').trim() || headers[col.base_price],
  };
  return {
    rows, skippedRows, meta,
    hasM0: Boolean(m0),
    hasDates: m3!.date >= 0,
    hasRingi: ringiOf(m3) >= 0,
  };
}

const CHUNK = 500;

export interface AggResult {
  matched: number;      // 法人を照合できた行
  unmatched: number;    // 実績側に無い法人の行（重ねられない）
  covered: number;      // A基準が入った案件の数
  total: number;        // 案件の総数（実績の法人×品目）
}

/**
 * 小分けにして送る。サーバー側で法人×品目へ集約し、
 * 最後に実績ベースの案件へA基準（数量加重平均）を重ねる。
 */
export async function sendAggImport(
  parsed: AggParsed,
  filename: string,
  opts: { onProgress?: (done: number, total: number) => void }
): Promise<AggResult> {
  await api('/agg-import/start', {
    method: 'POST',
    body: JSON.stringify({ filename, meta: parsed.meta }),
  });
  let matched = 0;
  let unmatched = 0;
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    const r = await api<{ matched: number; unmatched: number }>('/agg-import/chunk', {
      method: 'POST',
      body: JSON.stringify({ rows: parsed.rows.slice(i, i + CHUNK) }),
    });
    matched += r.matched;
    unmatched += r.unmatched;
    opts.onProgress?.(Math.min(i + CHUNK, parsed.rows.length), parsed.rows.length);
  }
  const fin = await api<{ covered: number; total: number }>('/agg-import/finish', {
    method: 'POST', body: JSON.stringify({}),
  });
  return { matched, unmatched, covered: fin.covered, total: fin.total };
}

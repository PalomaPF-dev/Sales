import * as XLSX from 'xlsx';
import { api } from './api';
import { splitRows } from './aggImportClient';

/**
 * 価格調査（当月実績）の取込。案件一覧の土台になる。
 *
 * ファイルには当月（7月）の数量・単価・金額が「マスタ／見積／合計」で入っている。
 * ・マスタ単価 … 値決めの単価。A基準（今後の計画）はこれと比べる
 * ・実単価     … 金額（合計）÷ 数量（合計）。実際に出た単価で、見積ぶんが
 *                混ざるとマスタ単価より下がる。こちらが実績の正
 * ・金額（合計）… 実績そのもの。合計が売上と一致するようにそのまま持つ
 * ・金額（マスタ）… 値決めどおりに出た分。A基準はこの金額・数量に対して当てる
 * 「過去最新単価」からマスタ単価までが、これまでに上がった分になる。
 *
 * 「７月数量」「７月単価」だけの古い形式でも取り込める（その場合は
 * マスタ単価＝当月単価として扱う）。
 *
 * 得意先×商品の単位で取り込み、案件は 得意先×商品 にまとめる。
 */

export interface SurveyRow {
  customer_code: string;   // 得意先コード（案件のまとまりの単位）
  customer_name: string;
  corp_group: string;      // 企業グループ名（法人。無いファイルでは空）
  industry: string;        // 業種名
  delivery_name: string;
  model_code: string;
  model_name: string;     // 品目階層名（分類の名前）
  product_name: string;   // 器種名（型式。ファイルの「商品名」がこれにあたる）
  spec: string;           // 規格（LP・P など。ガス種として持つ）
  equip_name: string;
  category_name: string;
  list_price: unknown;     // 標準単価
  qty: unknown;            // 当月の数量（マスタ＋見積の合計）
  price: unknown;          // 当月の実単価（金額÷数量。数量0のときはマスタ単価）
  amount: unknown;         // 当月の金額（合計を実績と合わせるためそのまま送る）
  master_price: unknown;   // 当月のマスタ単価（値決めの単価。A基準はこれと比べる）
  plan_qty: unknown;       // マスタ分の数量（A基準はこれに対して当てる）
  plan_amount: unknown;    // マスタ分の金額（A基準の比較のもと）
  past_price: unknown;     // 過去最新単価（値上げ前）
  past_date: string | null;// 過去最新受注日（過去最新売上日）
}

export interface SurveyParsed {
  rows: SurveyRow[];
  skippedRows: number;
  /** 当月（YYYY-MM）。「７月数量」の見出しと、基準の年から決める */
  ym: string;
  monthLabel: string;      // 「7月」
  hasPast: boolean;        // 過去最新単価の列があるか
  hasMasterPrice: boolean; // マスタ単価の列があるか（新しい形式のファイル）
  hasCorpGroup: boolean;   // 企業グループ名の列があるか（法人として使う）
}

/** 見出しの表記ゆれを吸収する（全角数字・全角かっこ・空白） */
function normHead(h: unknown): string {
  return String(h ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[\s　_]/g, '')
    .trim();
}

/**
 * 中身のあるシートと見出しの行を選ぶ。
 * 先頭シートが空（表紙だけ）のブックや、見出しの上に表題が載っている形式でも読める。
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

/** 売上高のファイルを読み取り、送る行に変換する */
export async function parseSurveyFile(file: File, anchorYm?: string): Promise<SurveyParsed> {
  const { readFileBuffer } = await import('./aggImportClient');
  const buf = await readFileBuffer(file);
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

  // 「7月数量」「7月単価」から当月を決める（月は見出しから読む）。
  // 新しい形式は「7月数量(マスタ)」「7月数量(合計)」のように種別が付く。
  // 数量・金額は合計、単価はマスタを使う（無ければ種別なしの列）。
  const findMonth = (kind: string, suffix: string) =>
    headers.findIndex((h) => new RegExp(`^\\d{1,2}月${kind}${suffix}$`).test(h));
  const pick = (kind: string, ...suffixes: string[]) => {
    for (const sfx of suffixes) {
      const i = findMonth(kind, sfx);
      if (i >= 0) return i;
    }
    return -1;
  };
  // 数量・金額は合計（マスタ＋見積）。実績の合計を合わせるための土台になる
  const qtyAt = pick('数量', '\\(合計\\)', '', '\\(マスタ\\)');
  const amountAt = pick('金額', '\\(合計\\)', '', '\\(マスタ\\)');
  // マスタ単価は値決めの単価。古い形式では種別なしの「7月単価」がこれにあたる
  const mPriceAt = pick('単価', '\\(マスタ\\)', '');
  // マスタ分（値決めどおりに出た分）の数量・金額。A基準はここに対して当てる。
  // 種別の無い古い形式では合計＝マスタ分として扱う
  const planQtyAt = pick('数量', '\\(マスタ\\)', '');
  const planAmountAt = pick('金額', '\\(マスタ\\)', '');
  if (qtyAt < 0 || mPriceAt < 0) {
    throw new Error('「7月数量」「7月単価」のような当月の列がありません。'
      + '価格調査（当月実績）のファイルをお使いください');
  }
  const month = Number(/^(\d{1,2})月/.exec(headers[qtyAt])![1]);
  // マスタ単価の列に種別が付いていれば新しい形式
  const hasMasterPrice = findMonth('単価', '\\(マスタ\\)') >= 0;

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
  // 受注日／売上日はファイルによって呼び方が違う
  const pastDateAt = findLike('過去最新受注日') >= 0 ? findLike('過去最新受注日') : findLike('過去最新売上日');

  const at = {
    customer_name: find('得意先名'),
    // 企業グループ名があれば法人として使う（無いファイルでは得意先が法人になる）
    corp_group: findLike('企業グループ名') >= 0 ? findLike('企業グループ名') : find('法人名'),
    industry: find('業種名'),
    delivery_name: find('納入先名'),
    // 品目階層名（「ふろ給湯器　壁掛　エコ（Wエコ）」のような分類の名前）。
    // マスタ登録の取込では「商品名」の列がこれにあたる（見出しの呼び方が違うだけ）
    model_name: findLike('品目階層名') >= 0 ? findLike('品目階層名') : find('器種名'),
    // 器種名（型式。FH-E2422SAWL のような品番）。
    // 価格調査のファイルでは「商品名」の列がこれにあたる
    product_name: find('商品名'),
    spec: find('規格'),
    equip_name: find('器具区分名'),
    category_name: findLike('カテゴリー名'),
    list_price: find('標準単価'),
  };
  const txt = (r: unknown[], i: number) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  /** 数として読む。空欄・記号入りでも0に落とす */
  const num = (r: unknown[], i: number) => {
    if (i < 0) return 0;
    const n = Number(String(r[i] ?? '').replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

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
      corp_group: txt(r, at.corp_group),
      industry: txt(r, at.industry),
      delivery_name: txt(r, at.delivery_name),
      model_code: model,
      model_name: txt(r, at.model_name),
      product_name: txt(r, at.product_name),
      spec: txt(r, at.spec),
      equip_name: txt(r, at.equip_name),
      category_name: txt(r, at.category_name),
      list_price: at.list_price >= 0 ? r[at.list_price] : null,
      qty: r[qtyAt],
      // 実単価は 金額÷数量（見積ぶんも混ざった、実際に出た単価）。
      // 数量が0の月は割り算ができないので、マスタ単価を代わりに置く
      price: (() => {
        const q = num(r, qtyAt);
        const amt = num(r, amountAt);
        return q > 0 && amt > 0 ? amt / q : (mPriceAt >= 0 ? r[mPriceAt] : null);
      })(),
      amount: amountAt >= 0 ? r[amountAt] : null,
      master_price: mPriceAt >= 0 ? r[mPriceAt] : null,
      plan_qty: planQtyAt >= 0 ? r[planQtyAt] : null,
      plan_amount: planAmountAt >= 0 ? r[planAmountAt] : null,
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
    hasMasterPrice,
    hasCorpGroup: at.corp_group >= 0,
  };
}


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
  let sent = 0;
  // 行数と本文の大きさの両方を見ながら、できるだけ大きくまとめて送る
  for (const chunk of splitRows(parsed.rows)) {
    const r = await api<{ matched: number; unmatched: number }>('/survey-import/chunk', {
      method: 'POST',
      body: JSON.stringify({ rows: chunk }),
    });
    matched += r.matched;
    unmatched += r.unmatched;
    sent += chunk.length;
    opts.onProgress?.(sent, parsed.rows.length);
  }
  const fin = await api<{ covered: number; total: number; removed?: number }>(
    '/survey-import/finish', { method: 'POST', body: JSON.stringify({ batch: started.batch }) });
  return { matched, unmatched, covered: fin.covered, total: fin.total, removed: fin.removed };
}

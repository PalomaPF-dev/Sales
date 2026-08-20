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
  delivery_name: string;   // 納入先名（まとまりの中の主な納入先を代表にする）
  model_code: string;
  // 実績（価格調査）に無い品目を案件として追加するときに使う項目
  corp_group: string;      // 企業グループ名（法人）
  industry: string;        // 業種名
  model_name: string;      // 器種名／機種名
  product_name: string;    // 商品名
  gas_type: string;        // ガス種（規格）
  equip_name: string;      // 器具区分
  category_name: string;   // カテゴリー名
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
  // 第2弾新値上げ単価（目標値）と、商談結果・最終確定日・最終確定単価。
  // 列の無いファイルでは null（画面で入れた値がそのまま残る）
  target_price: unknown;
  nego_result: string | null;
  final_date: string | null;
  final_price: unknown;
  /** マスタ単価の実績（月別）。「マスター単価（4月実績）」…の列。キーは YYYY-MM */
  hist_prices: Record<string, unknown>;
}

export interface AggParsed {
  rows: AggRow[];
  skippedRows: number;
  /** 読めない行の内訳。得意先コードが空 / 商品コードが空（両方空なら両方に数える） */
  skippedNoCust: number;
  skippedNoModel: number;
  hasM0: boolean;      // 「当月」の列があるファイルか
  hasDates: boolean;   // 「登録日（〜）」の列があるファイルか
  hasRingi: boolean;   // 「稟議」の列があるファイルか
  /** マスタ単価の実績（月別）の月（YYYY-MM）。「マスター単価（4月実績）」…の列から */
  histMonths: string[];
  /** 交渉まわりの列を見つけられたか。見つからない列は取込で変更されない */
  negoCols: { target: boolean; nego: boolean; finalDate: boolean; finalPrice: boolean };
  /** 納入先名の列を見つけられたか（無いと案件一覧の納入先名が空のまま） */
  hasDelivery: boolean;
  meta: { m0: string; m1: string; m2: string; m3: string; basePeriod: string; histMonths: string[] };
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

/** 見出しの表記ゆれを吸収する（全角数字・全角かっこ・「3カ月後/3ヶ月後」の揺れ） */
function normHead(h: unknown): string {
  return String(h ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/(\d)[カヶケ]月後/g, '$1か月後')
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

/**
 * ファイルを読み取る。Excelで開いたままのファイルはWindowsがロックしていて
 * ブラウザから読めない（NotReadableError）。原因が分かる文言に置き換える。
 */
export async function readFileBuffer(file: File): Promise<ArrayBuffer> {
  try {
    return await file.arrayBuffer();
  } catch (e) {
    const name = (e as DOMException)?.name ?? '';
    if (name === 'NotReadableError' || /could not be read|permission/i.test(String((e as Error)?.message ?? ''))) {
      throw new Error('ファイルを読み取れませんでした。Excelでこのファイルを開いたままだと読めません。'
        + 'Excelを閉じてから、もう一度ファイルを選び直してください。'
        + '（ネットワークドライブ上のファイルは、一度デスクトップなどへコピーすると確実です）');
    }
    throw e;
  }
}

/** 集約表を読み取り、送る行に変換する */
export async function parseAggFile(file: File): Promise<AggParsed> {
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
  // 月のまとまりの見出し。当月は「毎月」「本日時点」と書かれた版もある
  const M0_LABELS = ['当月', '毎月', '本日時点'];
  const MONTH_LABELS = [...M0_LABELS, '翌月', '翌々月', '3か月後'];
  const monthCols = (labels: string[]) => {
    let at = -1;
    for (const l of labels) { at = find(l); if (at >= 0) break; }
    // 完全一致で見つからないときは、その言葉を含む見出しも許す
    // （「本日時点マスタ単価」のように1マスへまとめた版のため。
    //   「登録日(当月)」「N月実績」など別物の列は除く）
    if (at < 0) {
      at = headers.findIndex((h) => labels.some((l) => l && h.includes(l))
        && !/登録日|稟議|申請番号|実績|数量|金額|出荷/.test(h));
    }
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
      // 「本日時点マスタ単価」のように見出しが1マスの版は、その列自体が単価
      price: price >= 0 ? price : (headers[at].includes('マスタ単価') ? at : at + 1),
      date: within((h) => h.includes('登録日')),
      ringi: within((h) => RINGI_RE.test(h)),
    };
  };

  const col = {
    customer_code: find('得意先コード'),
    customer_name: find('得意先名'),
    corp_group: findLike('企業グループ名') >= 0 ? findLike('企業グループ名')
      : findLike('企業G名') >= 0 ? findLike('企業G名') : find('法人名'),
    industry: find('業種名'),
    // 商品名の無い版は品目階層名で代用する
    product_name: find('商品名') >= 0 ? find('商品名') : findLike('品目階層名'),
    delivery_code: find('納入先コード'),
    // 「納入先名称」「得意先納入先名」のような揺れも拾う（納入先コードとは混ざらない）
    delivery_name: find('納入先名') >= 0 ? find('納入先名') : findLike('納入先名'),
    model_code: find('商品コード'),
    // 器種名／機種名は版によって呼び方が違う
    model_name: findAny('器種名', '機種名'),
    gas_type: find('ガス種'),
    equip_name: findAny('器具区分名', '器具区分'),
    category_name: findLike('カテゴリー名'),
    list_price: find('標準単価'),
    // 担当・支店・営業所は無い版もある。無ければ空のまま（案件の値が残る）。
    // 「得意先実績担当者名」「得意先実績計上営業所名」のような長い見出しの版も拾う
    sales_person: findAny('得意先担当者名', '得意先担当') >= 0
      ? findAny('得意先担当者名', '得意先担当') : findLike('担当者名'),
    office: findBoth('得意先', '営業所') >= 0 ? findBoth('得意先', '営業所')
      : findBoth('得意先', '地区') >= 0 ? findBoth('得意先', '地区')
      : findLike('営業所名') >= 0 ? findLike('営業所名') : findLike('地区名'),
    branch: findBoth('得意先', '支店') >= 0 ? findBoth('得意先', '支店') : findLike('支店名'),
    // 出荷単価・売上数の列が無い版もある（毎日更新版）。無ければ空のまま取り込む
    base_price: findLike('出荷単価'),
    qty: findLike('売上数'),
    cost_price: find('実績原価'),
    // 第2弾新値上げ単価（目標値）と、商談の結果。列の無い版では -1 のまま
    target_price: findLike('第2弾') >= 0 ? findLike('第2弾') : findLike('目標値'),
    nego_result: findLike('商談結果'),
    final_date: findLike('最終確定日'),
    final_price: findLike('最終確定単価'),
  };
  // 担当・支店・営業所・原価・出荷単価・売上数は任意（無いファイルでも取り込める）
  const OPTIONAL = new Set(['cost_price', 'sales_person', 'office', 'branch',
    'delivery_code', 'delivery_name', 'gas_type', 'category_name', 'list_price',
    'target_price', 'nego_result', 'final_date', 'final_price',
    'corp_group', 'industry', 'product_name', 'base_price', 'qty']);
  const LABELS: Record<string, string> = {
    customer_code: '得意先コード', customer_name: '得意先名',
    model_code: '商品コード', model_name: '器種名（機種名）', equip_name: '器具区分',
  };
  const missing = Object.entries(col)
    .filter(([k, i]) => i < 0 && !OPTIONAL.has(k))
    .map(([k]) => LABELS[k] ?? k);
  if (missing.length) {
    throw new Error(`見出しが見つかりません: ${missing.join('・')}。`
      + '「得意先コード」「商品コード」「翌月」などの見出しがあるシートが必要です');
  }

  // 当月は無いファイルもある（8月6日版まで）。翌月・翌々月・3か月後は必須
  const m0 = monthCols(M0_LABELS);
  const m1 = monthCols(['翌月']);
  const m2 = monthCols(['翌々月']);
  const m3 = monthCols(['3か月後']);
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

  // 月の見出し（当月など）の実際の月。行を読む前に決めておく。
  // 当月は、見出しが単価と1マスの版だと下の行に日付が無いため、
  // 必須の翌月から1か月戻して決める（日付のある版でも同じ月になる）
  const first = grid[1] ?? [];
  const prevYm = (ym: string) => {
    const m = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!m) return '';
    let y = Number(m[1]);
    let mo = Number(m[2]) - 1;
    if (mo <= 0) { mo = 12; y -= 1; }
    return `${y}-${String(mo).padStart(2, '0')}`;
  };
  const m1Ym = serialToYm(first[m1!.at]);
  const metaBase = {
    m0: m0 ? (prevYm(m1Ym) || serialToYm(first[m0.at])) : '',
    m1: m1Ym,
    m2: serialToYm(first[m2!.at]),
    m3: serialToYm(first[m3!.at]),
    basePeriod: col.base_price >= 0
      ? (headers[col.base_price].replace(/出荷単価/, '').trim() || headers[col.base_price])
      : '',
  };

  // マスタ単価の実績（月別）。「マスター単価（4月実績）」…の列を読む。
  // 見出しに年が無いため、当月（m0）を手がかりに何年かを決める
  // （当月より後の月番号は前の年とみなす。売上高の取込と同じ規則）
  const histCols: { month: number; at: number }[] = [];
  headers.forEach((h, i) => {
    // 「マスター単価(4月実績)」のほか、「4月実績」だけの見出しでも読む
    const m = /^(?:マスタ[ー]?単価)?\(?(\d{1,2})月実績\)?$/.exec(h.replace(/[\s　]/g, ''));
    if (m) histCols.push({ month: Number(m[1]), at: i });
  });
  const m0m = /^(\d{4})-(\d{2})$/.exec(metaBase.m0);
  const m1m = /^(\d{4})-(\d{2})$/.exec(metaBase.m1);
  // 当月の年月。当月列が無いファイルでは翌月から1か月戻して決める
  let anchorY: number | null = null;
  let anchorM = 0;
  if (m0m) { anchorY = Number(m0m[1]); anchorM = Number(m0m[2]); }
  else if (m1m) {
    anchorY = Number(m1m[1]);
    anchorM = Number(m1m[2]) - 1;
    if (anchorM <= 0) { anchorM = 12; anchorY -= 1; }
  }
  const histYm = (month: number) => {
    if (anchorY == null) return `${new Date().getFullYear()}-${String(month).padStart(2, '0')}`;
    const y = month <= anchorM ? anchorY : anchorY - 1;
    return `${y}-${String(month).padStart(2, '0')}`;
  };
  const histMonths = histCols.map((c) => histYm(c.month));

  const txt = (r: unknown[], i: number) => String(r[i] ?? '').trim();
  const at = (r: unknown[], i: number) => (i >= 0 ? r[i] : null);
  const rows: AggRow[] = [];
  let skippedRows = 0;
  let noCust = 0;
  let noModel = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const cust = txt(r, col.customer_code);
    const model = txt(r, col.model_code);
    if (!cust || !model) {
      if (r.some((v) => v != null && v !== '')) {
        skippedRows++;
        if (!cust) noCust++;
        if (!model) noModel++;
      }
      continue;
    }
    rows.push({
      customer_code: cust,
      customer_name: txt(r, col.customer_name),
      delivery_name: txt(r, col.delivery_name),
      model_code: model,
      corp_group: txt(r, col.corp_group),
      industry: txt(r, col.industry),
      model_name: txt(r, col.model_name),
      product_name: txt(r, col.product_name),
      gas_type: txt(r, col.gas_type),
      equip_name: txt(r, col.equip_name),
      category_name: txt(r, col.category_name),
      branch: txt(r, col.branch),
      office: txt(r, col.office),
      sales_person: txt(r, col.sales_person),
      qty: at(r, col.qty),
      base_price: at(r, col.base_price),
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
      target_price: at(r, col.target_price),
      nego_result: txt(r, col.nego_result) || null,
      final_date: col.final_date >= 0 ? toYmd(r[col.final_date]) : null,
      final_price: at(r, col.final_price),
      hist_prices: Object.fromEntries(histCols.map((c, ci) => [histMonths[ci], r[c.at]])),
    });
  }
  if (!rows.length) throw new Error('取り込める行がありません');

  return {
    rows, skippedRows, skippedNoCust: noCust, skippedNoModel: noModel,
    histMonths,
    meta: { ...metaBase, histMonths },
    hasM0: Boolean(m0),
    hasDates: m3!.date >= 0,
    hasRingi: ringiOf(m3) >= 0,
    negoCols: {
      target: col.target_price >= 0,
      nego: col.nego_result >= 0,
      finalDate: col.final_date >= 0,
      finalPrice: col.final_price >= 0,
    },
    hasDelivery: col.delivery_name >= 0,
  };
}

const CHUNK = 500;

export interface AggResult {
  matched: number;      // 読み取れた行
  unmatched: number;    // 得意先コード等が空で取り込めなかった行
  covered: number;      // A基準が入った案件の数
  total: number;        // 案件の総数
  /** 実績（価格調査）に無く、マスタ登録から新しく追加した案件の数 */
  added: number;
}

/**
 * 小分けにして送る。サーバー側で法人×品目へ集約し、
 * 最後に実績ベースの案件へA基準（リストの単価そのまま）を重ねる。
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
  const fin = await api<{ covered: number; total: number; added?: number }>('/agg-import/finish', {
    method: 'POST', body: JSON.stringify({}),
  });
  return { matched, unmatched, covered: fin.covered, total: fin.total, added: fin.added ?? 0 };
}

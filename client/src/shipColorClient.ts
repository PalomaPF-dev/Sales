import * as XLSX from 'xlsx';

/**
 * 出荷実績の色分け（色塗り判定）の取込で使うファイルの読み取り。
 *
 * ・出荷データ（MBの出荷明細）… 1シート＝1日ぶん。「1-4日」「7日」のように
 *   日ごとにシートを分けたファイルも、シートごとに読み分ける。
 *   出荷単価のセルに色が塗られていれば（手作業で色塗りした後のファイル・過去色塗り表）、
 *   その色を区分として読み取る。以後の判定で「過去の色塗り」として使う。
 * ・色塗り資料 … 「基準価格」「先方契約済物件」「期間指定」のシートを読む。
 *
 * 判定そのものはサーバーで行う（判定条件を1か所で持つため）。
 * ここでは送る形にそろえるだけ。
 */

export interface ShipRow {
  slip_no: string;
  sale_date: string;
  order_date: string;
  corp_code: string;
  corp_name: string;
  customer_code: string;
  customer_name: string;
  delivery_code: string;
  delivery_name: string;
  industry: string;
  equip_name: string;
  cat_large: string;
  cat_name: string;
  model_code: string;
  gas_code: string;
  model_name: string;
  gas_type: string;
  qty: number | null;
  price: number | null;
  amount: number | null;
  list_price: number | null;
  quote_no: string;
  branch: string;
  office: string;
  person: string;
  /** ファイルで出荷単価に塗られていた色の区分。塗られていなければ空 */
  file_cat: string;
}

export interface ShipSheet {
  sheet: string;
  rows: ShipRow[];
  /** データの日付（売上日の最終日）。同じ日付の取込は置き換わる */
  dataDate: string;
  minDate: string;
  /** 出荷単価に色が塗られていた行の数 */
  colored: number;
  colorCounts: Record<string, number>;
  skipped: number;
}

export interface ShipParsed {
  sheets: ShipSheet[];
  /** 見出しが見つからず読まなかったシート */
  ignored: string[];
}

/** 見出しの表記ゆれ（全角・半角、空白、改行）をならす */
const normHead = (h: unknown) => String(h ?? '').normalize('NFKC').replace(/[\s　]/g, '').trim();

/** 取り込む列と、ファイルの見出し。上から順に探し、最初に見つかったものを使う */
const HEADS: Record<Exclude<keyof ShipRow, 'file_cat'>, string[]> = {
  slip_no: ['売上伝票NO', '売上伝票No', '売上伝票番号'],
  sale_date: ['売上日'],
  order_date: ['受注日'],
  corp_code: ['法人コード'],
  corp_name: ['法人名'],
  customer_code: ['得意先コード'],
  customer_name: ['得意先名'],
  delivery_code: ['納入先コード'],
  delivery_name: ['納入先名'],
  industry: ['業種名'],
  equip_name: ['器具区分名'],
  cat_large: ['カテゴリー名大'],
  cat_name: ['カテゴリー名'],
  model_code: ['器種コード'],
  gas_code: ['ガスコード'],
  model_name: ['器種名'],
  gas_type: ['ガス種'],
  qty: ['出荷数'],
  price: ['出荷単価'],
  amount: ['出荷金額'],
  list_price: ['定価'],
  quote_no: ['見積伝票番号'],
  branch: ['売上担当者支店名'],
  office: ['売上担当者営業所名'],
  person: ['売上担当者名'],
};
const REQUIRED: (keyof typeof HEADS)[] = ['customer_code', 'model_code', 'price'];
const NUMERIC = new Set(['qty', 'price', 'amount', 'list_price']);
const DATES = new Set(['sale_date', 'order_date']);

const text = (v: unknown) => {
  if (v == null) return '';
  const s = String(v).trim();
  return s === '< NULL >' ? '' : s;
};

const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[,，¥￥\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 日付を YYYY-MM-DD に（「2026/09/24 00:00:00」・日付型・シリアル値のどれでも） */
export function ymd(v: unknown): string {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    // SheetJSは日付を世界標準時の0時で返す。時間帯によって前日にずれないよう、UTCのまま読む
    if (Number.isNaN(v.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const m = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(String(v));
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

/**
 * 塗られた色を区分に読み替える。色塗り資料の凡例の色に一番近いものを選ぶ。
 * テーマの色（淡い水色・淡い緑）もSheetJSが実際の色に直して渡してくれる。
 */
const PALETTE: [string, string][] = [
  ['raised', 'CAEEFB'], ['raised', 'CAEDFB'], ['raised', 'DDEBF7'], ['raised', 'BDD7EE'],
  ['raised', '9BC2E6'], ['raised', '00B0F0'], ['raised', 'B7DEE8'], ['raised', 'DAEEF3'],
  ['ordered', 'D9F2D0'], ['ordered', 'DAF2D0'], ['ordered', 'E2EFDA'], ['ordered', 'C6EFCE'],
  ['ordered', 'A9D08E'], ['ordered', '92D050'], ['ordered', '00B050'], ['ordered', 'EBF1DE'],
  ['contract', 'FFFF00'], ['contract', 'FFFF99'], ['contract', 'FFFFCC'],
  ['unsigned', 'FFCCFF'], ['unsigned', 'FF99CC'], ['unsigned', 'FF66FF'], ['unsigned', 'FCE4EC'],
  ['nonpos', 'FFC000'], ['nonpos', 'F4B084'], ['nonpos', 'FFD966'], ['nonpos', 'F8CBAD'],
];
const rgbOf = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

export function colorToCat(hex: string | undefined | null): string {
  const h = String(hex ?? '').replace(/^#/, '').slice(-6).toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(h)) return '';
  const [r, g, b] = rgbOf(h);
  if (r > 245 && g > 245 && b > 245) return '';           // 白＝塗っていない
  if (Math.max(r, g, b) - Math.min(r, g, b) < 20) return 'other'; // 灰色＝その他
  let best = '';
  let dist = Infinity;
  for (const [cat, ref] of PALETTE) {
    const [rr, gg, bb] = rgbOf(ref);
    const d = (r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2;
    if (d < dist) { dist = d; best = cat; }
  }
  return best;
}

type Cell = { v?: unknown; s?: { patternType?: string; fgColor?: { rgb?: string } } } | undefined;

/** セルの塗りつぶしの色（無ければ空） */
function fillOf(cell: Cell): string {
  const s = cell?.s;
  if (!s || (s.patternType && s.patternType === 'none')) return '';
  return s.fgColor?.rgb ?? '';
}

/** 1シートを読み取る。見出しが無ければ null */
function parseSheet(ws: XLSX.WorkSheet, name: string): ShipSheet | null {
  const dense = (ws as { '!data'?: Cell[][] })['!data'];
  const rowAt = (r: number): Cell[] => dense?.[r] ?? [];
  const nRows = dense?.length ?? 0;
  // 見出し行を探す（先頭20行まで）
  let headerRow = -1;
  let col: Partial<Record<keyof typeof HEADS, number>> = {};
  for (let r = 0; r < Math.min(20, nRows); r++) {
    const heads = rowAt(r).map((c) => normHead(c?.v));
    const found: Partial<Record<keyof typeof HEADS, number>> = {};
    for (const [key, names] of Object.entries(HEADS) as [keyof typeof HEADS, string[]][]) {
      for (const n of names) {
        const i = heads.indexOf(normHead(n));
        if (i >= 0) { found[key] = i; break; }
      }
    }
    if (REQUIRED.every((k) => found[k] != null)) { headerRow = r; col = found; break; }
  }
  if (headerRow < 0) return null;

  const rows: ShipRow[] = [];
  const seen = new Map<string, number>();
  const colorCounts: Record<string, number> = {};
  let skipped = 0;
  for (let r = headerRow + 1; r < nRows; r++) {
    const cells = rowAt(r);
    const get = (k: keyof typeof HEADS) => (col[k] == null ? undefined : cells[col[k]!]);
    const out = {} as ShipRow;
    for (const k of Object.keys(HEADS) as (keyof typeof HEADS)[]) {
      const v = get(k)?.v;
      if (NUMERIC.has(k)) (out as unknown as Record<string, unknown>)[k] = toNum(v);
      else if (DATES.has(k)) (out as unknown as Record<string, unknown>)[k] = ymd(v);
      else (out as unknown as Record<string, unknown>)[k] = text(v);
    }
    if (!out.model_code || out.price == null) {
      if (cells.some((c) => c?.v != null && c.v !== '')) skipped++;
      continue;
    }
    // 売上伝票NOが無いファイル（過去色塗り表など）は、中身から見分けるキーを作る
    if (!out.slip_no) {
      const base = ['K', out.sale_date, out.customer_code, out.delivery_code,
        out.model_code, out.gas_code, out.price].join('|');
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      out.slip_no = `${base}|${n}`;
    }
    out.file_cat = colorToCat(fillOf(get('price')));
    if (out.file_cat) colorCounts[out.file_cat] = (colorCounts[out.file_cat] ?? 0) + 1;
    rows.push(out);
  }
  if (!rows.length) return null;
  const dates = rows.map((x) => x.sale_date).filter(Boolean).sort();
  return {
    sheet: name,
    rows,
    dataDate: dates[dates.length - 1] ?? '',
    minDate: dates[0] ?? '',
    colored: rows.filter((x) => x.file_cat).length,
    colorCounts,
    skipped,
  };
}

/** 出荷データのファイルを読み取る。見出しのあるシートをすべて、日付の古い順に並べて返す */
export function parseShipWorkbook(buf: ArrayBuffer): ShipParsed {
  const wb = XLSX.read(buf, {
    type: 'array', dense: true, cellStyles: true, cellDates: true,
    cellHTML: false, cellFormula: false, cellText: false,
  });
  const sheets: ShipSheet[] = [];
  const ignored: string[] = [];
  for (const name of wb.SheetNames) {
    const s = parseSheet(wb.Sheets[name], name);
    if (s) sheets.push(s); else ignored.push(name);
  }
  if (!sheets.length) {
    throw new Error('出荷データの見出し（得意先コード・器種コード・出荷単価）のあるシートが見つかりません');
  }
  // 後の日は前の日の結果を「過去の色塗り」として使うため、古い日から取り込む
  sheets.sort((a, b) => a.dataDate.localeCompare(b.dataDate));
  return { sheets, ignored };
}

// ───────── 色塗り資料 ─────────

export interface ReferenceParsed {
  basePrices: { code: string; name: string; price: number }[] | null;
  contracts: string[] | null;
  periodCustomers: { code: string; name: string; until: string }[] | null;
}

/** 「9月末まで」「27年3月末まで」を期限の日付にする。年が無ければ今年 */
export function untilFromLabel(label: string, baseYear = new Date().getFullYear()): string {
  const m = /(?:(\d{2,4})\s*年)?\s*(\d{1,2})\s*月末/.exec(label.normalize('NFKC'));
  if (!m) return '';
  let y = m[1] ? Number(m[1]) : baseYear;
  if (y < 100) y += 2000;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return '';
  const last = new Date(y, mo, 0).getDate();
  return `${y}-${String(mo).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

const grid = (ws: XLSX.WorkSheet | undefined): unknown[][] =>
  ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true }) : [];

export function parseReferenceWorkbook(buf: ArrayBuffer): ReferenceParsed {
  const wb = XLSX.read(buf, { type: 'array', cellFormula: false, cellHTML: false });
  const out: ReferenceParsed = { basePrices: null, contracts: null, periodCustomers: null };

  for (const name of wb.SheetNames) {
    const g = grid(wb.Sheets[name]);
    const heads = (r: number) => (g[r] ?? []).map((h) => normHead(h));

    // 基準価格：「基準価格」と「商品コード（カタログ記載の中5桁）」の見出しがあるシート
    if (!out.basePrices) {
      for (let r = 0; r < Math.min(30, g.length); r++) {
        const h = heads(r);
        const price = h.indexOf('基準価格');
        if (price < 0) continue;
        let codeCol = h.findIndex((x) => x.includes('中5桁'));
        if (codeCol < 0) codeCol = h.indexOf('器種コード');
        if (codeCol < 0) codeCol = h.indexOf('商品コード');
        if (codeCol < 0) continue;
        const nameCol = h.indexOf('器種名');
        const rows: { code: string; name: string; price: number }[] = [];
        for (let i = r + 1; i < g.length; i++) {
          const row = g[i] ?? [];
          const c = text(row[codeCol]);
          const p = toNum(row[price]);
          if (!c || p == null) continue;
          rows.push({ code: c, name: nameCol >= 0 ? text(row[nameCol]) : '', price: p });
        }
        if (rows.length) out.basePrices = rows;
        break;
      }
    }

    // 先方契約済物件：シート名に「契約済」。1列目の見積伝票番号を読む
    if (!out.contracts && /契約済/.test(name)) {
      const list = g.map((row) => text(row?.[0])).filter((v) => /^[0-9A-Za-z-]{4,}$/.test(v));
      out.contracts = [...new Set(list)];
    }

    // 期間指定：「得意先コード」「顧客名」の見出し。期限の書き込み（〇月末まで）は下の行へ引き継ぐ
    if (!out.periodCustomers && (/期間指定/.test(name) || heads(0).includes('顧客名'))) {
      let hr = -1;
      for (let r = 0; r < Math.min(10, g.length); r++) if (heads(r).includes('得意先コード')) { hr = r; break; }
      if (hr < 0) continue;
      const h = heads(hr);
      const cCol = h.indexOf('得意先コード');
      const dCol = h.indexOf('納入先コード');
      const nCol = h.indexOf('顧客名');
      let until = '';
      const list: { code: string; name: string; until: string }[] = [];
      for (let i = hr + 1; i < g.length; i++) {
        const row = g[i] ?? [];
        const label = row.map((v) => text(v)).find((v) => /月末/.test(v));
        if (label) until = untilFromLabel(label);
        let c = text(row[cCol]);
        if (!c && dCol >= 0 && text(row[dCol])) c = `T${text(row[dCol])}`;
        if (!c || /^=/.test(c)) continue;
        list.push({ code: c, name: nCol >= 0 ? text(row[nCol]) : '', until });
      }
      out.periodCustomers = list;
    }
  }
  return out;
}

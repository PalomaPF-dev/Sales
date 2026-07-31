import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { db, initDb } from './db.js';

/** 同じ内容のファイルを二度取り込もうとしたときに投げる */
export class DuplicateImportError extends Error {
  constructor(batch) {
    super(
      `このファイルは既に取り込まれています（#${batch.id} ${batch.filename} / `
      + `${Number(batch.row_count).toLocaleString()}行 / ${String(batch.imported_at).slice(0, 16).replace('T', ' ')}）。`
      + 'そのまま取り込むと明細が二重になり、値上げ金額が二倍になります。'
    );
    this.name = 'DuplicateImportError';
    this.isDuplicate = true;
    this.batch = batch;
  }
}

// 現行管理表のヘッダー名 → deals列 の対応
const HEADER_MAP = {
  '売上年月': 'sales_ym',
  '法人コード': 'corp_code',
  '法人名': 'corp_name',
  '得意先コード': 'customer_code',
  '得意先名': 'customer_name',
  '納入先コード': 'delivery_code',
  '納入先名': 'delivery_name',
  '扱い先コード': 'handler_code',
  '扱い先名': 'handler_name',
  '業種名': 'industry',
  '器具区分': 'equip_code',
  '器具区分名': 'equip_name',
  'カテゴリーコード': 'category_code',
  'カテゴリー名': 'category_name',
  '器種コード': 'model_code',
  'ガスコード': 'gas_code',
  '器種名': 'model_name',
  'ガス種': 'gas_type',
  '出荷数': 'qty',
  '定価': 'list_price',
  '掛け率': 'rate',
  '出荷単価': 'base_price',           // ❶
  '新値上げ後掛け率': 'r1_target_rate',
  '新出荷単価': 'r1_target_price',    // ❷ AD列 第1弾目標
  '出荷金額': 'ship_amount',
  '最終単価': 'final_price',
  '売上伝票ＮＯ': 'voucher_no',
  '見積伝票番号': 'quote_no',
  '受注日': 'order_date',
  '売上日': 'sales_date',
  '売上担当者支店名': 'branch',
  '売上担当者営業所名': 'office',
  '売上担当者名': 'sales_person',
  '得意先担当者名': 'customer_person',
  '確定商談日': 'negotiated_date',
  '商談結果': 'negotiation_note',
  '値上後単価': 'r1_agreed_price',    // ❸ BL列
  '値上日時': 'r1_raise_date',
  '稟議NO': 'r1_ringi_no',
  '新定価': 'new_list_price',
  '第１弾値上げ後掛率': 'r1_after_rate',
  '第２弾新値上げ単価': 'r2_target_price', // ❻ BS列 第2弾目標
  '１回目提示日': 'offer1_date',
  '1回目提示率': 'offer1_rate',
  '1回目提示単価': 'offer1_price',
  '商談結果（記号入力）': 'r2_result_symbol', // CB列
  '最終確定日': 'final_confirm_date',
  '最終確定値上日': 'final_raise_date',
  '第2弾稟議NO': 'r2_ringi_no',
  '最終確定掛率': 'final_rate',
  '最終確定単価': 'r2_agreed_price',  // ❼ CG列
};

const TEXT_COLS = new Set([
  'sales_ym','corp_code','corp_name','customer_code','customer_name',
  'delivery_code','delivery_name','handler_code','handler_name','industry',
  'equip_code','equip_name','category_code','category_name','model_code',
  'gas_code','model_name','gas_type','voucher_no','quote_no','order_date',
  'sales_date','branch','office','sales_person','customer_person',
  'negotiated_date','negotiation_note','r1_raise_date','r1_ringi_no',
  'offer1_date','r2_result_symbol','final_confirm_date','final_raise_date',
  'r2_ringi_no',
]);

const DATEISH_COLS = new Set([
  'order_date','sales_date','negotiated_date','r1_raise_date','offer1_date',
  'final_confirm_date','final_raise_date',
]);

const CONFIRM_SYMBOLS = ['〇', '○', '◯'];

// 1回のトランザクションで送る行数。
// PostgreSQL側で1文のINSERTにまとめられる上限（バインド変数65535個）に収まる範囲で
// 大きめに取り、DBとの往復回数を減らす。
const CHUNK_SIZE = 1000;

function excelSerialToISO(n) {
  // Excelシリアル値(1900年基準)を日付文字列へ
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

// 数値列（HEADER_MAPの対象のうちTEXT_COLSでないもの）
const NUMERIC_COLS = new Set(
  Object.values(HEADER_MAP).filter((c) => !TEXT_COLS.has(c))
);

/**
 * 数値列の値を数値へ寄せる。
 * 現行Excelには数値列にメモ書きや「48,9％」のような表記が混ざっており、
 * そのままでは数値として扱えない。桁区切りなど機械的に判断できるものだけ
 * 変換し、判断できないものは null にして呼び出し側へ件数を報告する
 * （誤った数値を入れて金額計算が狂う方が問題になるため）。
 */
function toNumber(s) {
  let t = String(s).trim()
    .replace(/[０-９．，％]/g, (c) => '0123456789.,%'['０１２３４５６７８９．，％'.indexOf(c)]) // 全角→半角
    .replace(/[\s　]/g, '');
  if (t === '') return { value: null, ambiguous: false };
  // 末尾の % は割合表記。掛率列は小数（0.16=16%）で保持しているため 100 で割る
  let isPercent = false;
  if (t.endsWith('%')) { isPercent = true; t = t.slice(0, -1); }
  // 桁区切りのカンマ（カンマの後ろがちょうど3桁）だけ除去する。
  // 「48,9」のような小数点代わりのカンマは判断できないので変換しない
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  if (t.includes(',')) return { value: null, ambiguous: true };
  const n = Number(t);
  if (!Number.isFinite(n)) return { value: null, ambiguous: true };
  return { value: isPercent ? n / 100 : n, ambiguous: false };
}

function normalize(col, v, warnings) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === '< NULL >' || s === '-' || s === '－') return null;
    if (NUMERIC_COLS.has(col)) {
      const { value, ambiguous } = toNumber(s);
      if (ambiguous && warnings) {
        const w = warnings.get(col) || { count: 0, samples: new Set() };
        w.count++;
        if (w.samples.size < 3) w.samples.add(s.slice(0, 40));
        warnings.set(col, w);
      }
      return value;
    }
    return s;
  }
  if (typeof v === 'number') {
    if (DATEISH_COLS.has(col) && v > 40000 && v < 60000 && Number.isInteger(v)) {
      return excelSerialToISO(v);
    }
    return TEXT_COLS.has(col) ? String(v) : v;
  }
  return TEXT_COLS.has(col) ? String(v) : null;
}

// 商談状況から管理ステータスを導出
export function deriveStatus(d) {
  const sym = (d.r2_result_symbol || '').trim();
  const confirmed = CONFIRM_SYMBOLS.some((s) => sym.startsWith(s));
  if (confirmed && d.r2_agreed_price > 0) return 'r2_agreed';
  if (sym || d.offer1_date) return 'r2_negotiating';
  if (d.r1_agreed_price != null && d.base_price != null && d.r1_agreed_price > d.base_price) return 'r1_agreed';
  if (d.negotiation_note || d.negotiated_date) return 'negotiating';
  return 'not_started';
}

// マスター単価種別の初期推定（画面から変更可能）
//  見積伝票番号あり → ⑥見積伝票（物件対応）
//  納入先が特定されている → ⑤納入先別単価（販売店対応）
//  それ以外 → ④取引先商品（既定。②③は掛率・グループ設定に応じて担当者が変更）
export function inferPriceType(d) {
  if (d.quote_no) return 6;
  if (d.delivery_code && d.delivery_code !== 'N00999999') return 5;
  return 4;
}

// ヘッダー行（「売上年月」を含む行）を探す
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i] && rows[i].some((c) => String(c ?? '').trim() === '売上年月')) return i;
  }
  throw new Error('ヘッダー行（「売上年月」列）が見つかりません。現行管理表の形式か確認してください。');
}

/**
 * 管理表を取り込む。
 * 同じ内容のファイルが既に取り込まれている場合は DuplicateImportError を投げる
 * （明細がそのまま二重になり、値上げ金額の集計が二倍になってしまうため）。
 * 意図的に再取込したいときは force を立てる。
 */
export async function importWorkbook(buffer, filename, userId, onProgress, { force = false } = {}) {
  await initDb();

  const contentHash = createHash('sha256').update(buffer).digest('hex');
  if (!force) {
    const dup = await db.get(
      'SELECT id, filename, row_count, imported_at FROM import_batches WHERE content_hash = ? ORDER BY id LIMIT 1',
      [contentHash]
    );
    if (dup) throw new DuplicateImportError(dup);
  }

  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const headerRow = findHeaderRow(rows);

  // ヘッダー名 → 列index
  const headers = rows[headerRow].map((h) => String(h ?? '').replace(/[\s　]+$/g, '').trim());
  const colIndex = {};
  headers.forEach((h, i) => {
    if (HEADER_MAP[h] !== undefined) {
      // カテゴリーコード/カテゴリー名は大中小の後に総合列(S,T)が来るため最後の出現を採用
      if (h === 'カテゴリーコード' || h === 'カテゴリー名') colIndex[HEADER_MAP[h]] = i;
      else if (colIndex[HEADER_MAP[h]] === undefined) colIndex[HEADER_MAP[h]] = i;
    }
  });
  if (colIndex.base_price === undefined || colIndex.r1_target_price === undefined) {
    throw new Error('必須列（出荷単価・新出荷単価）が見つかりません。');
  }

  const cols = Object.keys(colIndex);
  const dealCols = [...cols, 'batch_id', 'price_type_code', 'status', 'updated_at'];
  const insertSql = `INSERT INTO deals (${dealCols.join(',')}) VALUES (${dealCols.map(() => '?').join(',')})`;

  const { lastInsertRowid: batchId } = await db.run(
    'INSERT INTO import_batches (filename, row_count, imported_by, content_hash) VALUES (?,?,?,?)',
    [filename, 0, userId ?? null, contentHash]
  );

  const stamp = new Date().toISOString();
  const warnings = new Map(); // 数値として解釈できなかった値の記録
  let pending = [];
  let count = 0;

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row[colIndex.sales_ym] == null) continue; // 空行スキップ
    // 書き出したファイルを取り込み直したとき、末尾の合計行をデータとして拾わないようにする
    if (String(row[colIndex.sales_ym]).trim() === '合計') continue;
    const d = {};
    for (const c of cols) d[c] = normalize(c, row[colIndex[c]], warnings);
    const values = cols.map((c) => d[c]);
    values.push(batchId, inferPriceType(d), deriveStatus(d), stamp);
    pending.push({ sql: insertSql, params: values });
    count++;

    if (pending.length >= CHUNK_SIZE) {
      await db.batch(pending);
      pending = [];
      // 途中で中断（サーバーレスの実行時間切れなど）しても、
      // どこまで入ったかが取込履歴に残るようにここで件数を更新する
      await db.run('UPDATE import_batches SET row_count = ? WHERE id = ?', [count, batchId]);
      onProgress?.(count);
    }
  }
  if (pending.length) await db.batch(pending);

  await db.run('UPDATE import_batches SET row_count = ? WHERE id = ?', [count, batchId]);
  onProgress?.(count);

  // 数値として読めなかった値は取り込まずnullにしている。件数を返して気づけるようにする
  const skipped = [...warnings.entries()].map(([column, w]) => ({
    column,
    count: w.count,
    samples: [...w.samples],
  }));
  return { batchId, count, skipped };
}

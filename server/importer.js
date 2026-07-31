import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { db, initDb } from './db.js';
import {
  DATE_KEYS, FIELDS, NUMBER_KEYS, REQUIRED_KEYS, TEXT_KEYS,
  autoMapHeaders, findHeaderRow,
} from './fields.js';

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

export function normalize(col, v, warnings) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === '< NULL >' || s === '-' || s === '－') return null;
    if (NUMBER_KEYS.has(col)) {
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
    if (DATE_KEYS.has(col) && v > 40000 && v < 60000 && Number.isInteger(v)) {
      return excelSerialToISO(v);
    }
    return TEXT_KEYS.has(col) ? String(v) : v;
  }
  return TEXT_KEYS.has(col) ? String(v) : null;
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

/**
 * 見出し行を読み、列の対応（項目key → 列index）を組み立てる。
 * 画面で列を手動で合わせる場合は、この結果を出発点にする。
 */
export function inspectWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error('シートが見つかりません');
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const headerRow = findHeaderRow(grid);
  if (headerRow < 0) {
    throw new Error('見出し行が見つかりません。「売上年月」「出荷単価」などの列を含む行が必要です');
  }
  const headers = (grid[headerRow] || []).map((h) => String(h ?? '').trim());
  return { wb, ws, grid, headerRow, headers, sheetName, ...autoMapHeaders(headers) };
}

/**
 * 1行分のセル配列を deals の値へ変換する。
 * mapping は { 項目key: 列index }。取込経路（ファイル / 分割送信）で共通に使う。
 */
export function buildRow(cells, mapping, warnings) {
  const d = {};
  for (const [key, idx] of Object.entries(mapping)) {
    if (idx == null || idx < 0) continue;
    d[key] = normalize(key, cells[idx], warnings);
  }
  return d;
}

/** mapping に必須項目が揃っているか確認する */
export function validateMapping(mapping) {
  const missing = REQUIRED_KEYS.filter((k) => mapping?.[k] == null || mapping[k] < 0);
  if (missing.length) {
    const labels = missing.map((k) => FIELDS.find((f) => f.key === k)?.label ?? k);
    throw new Error(`必須の項目が対応づけられていません: ${labels.join(' / ')}`);
  }
}

export function contentHashOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 同じ内容が取り込み済みなら DuplicateImportError を投げる */
export async function assertNotDuplicate(contentHash) {
  const dup = await db.get(
    'SELECT id, filename, row_count, imported_at FROM import_batches WHERE content_hash = ? ORDER BY id LIMIT 1',
    [contentHash]
  );
  if (dup) throw new DuplicateImportError(dup);
}

export async function createBatch(filename, userId, contentHash) {
  const { lastInsertRowid } = await db.run(
    'INSERT INTO import_batches (filename, row_count, imported_by, content_hash) VALUES (?,?,?,?)',
    [filename, 0, userId ?? null, contentHash ?? null]
  );
  return Number(lastInsertRowid);
}

/**
 * 変換済みの行をまとめて登録する。
 * 呼び出し側は buildRow で作った行の配列を渡す。
 */
export async function insertRows(batchId, rows) {
  if (!rows.length) return 0;
  const stamp = new Date().toISOString();
  // 列の並びは行ごとに変わらないよう、全行の和集合で固定する
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const dealCols = [...cols, 'batch_id', 'price_type_code', 'status', 'updated_at'];
  const sql = `INSERT INTO deals (${dealCols.join(',')}) VALUES (${dealCols.map(() => '?').join(',')})`;
  const statements = rows.map((d) => ({
    sql,
    params: [...cols.map((c) => d[c] ?? null), batchId, inferPriceType(d), deriveStatus(d), stamp],
  }));
  for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + CHUNK_SIZE));
  }
  return rows.length;
}

/** 取込履歴の件数を現在値へ更新する */
export async function updateBatchCount(batchId, count) {
  await db.run('UPDATE import_batches SET row_count = ? WHERE id = ?', [count, batchId]);
}

/**
 * 取込履歴の件数を加算する。
 * 分割送信では読み出してから書き戻すと、送信が前後したときに件数がずれる。
 */
export async function addBatchCount(batchId, added) {
  await db.run('UPDATE import_batches SET row_count = row_count + ? WHERE id = ?', [added, batchId]);
  const row = await db.get('SELECT row_count FROM import_batches WHERE id = ?', [batchId]);
  return Number(row?.row_count ?? 0);
}

/** 数値として読めなかった値の集計を、画面に出せる形へ */
export function summarizeWarnings(warnings) {
  return [...warnings.entries()].map(([key, w]) => ({
    column: key,
    label: FIELDS.find((f) => f.key === key)?.label ?? key,
    count: w.count,
    samples: [...w.samples],
  }));
}

/** 合計行など、データではない行を除く */
export function isSkippableRow(cells, mapping) {
  const ymIdx = mapping.sales_ym;
  if (ymIdx == null || ymIdx < 0) return false;
  const v = cells[ymIdx];
  if (v == null || String(v).trim() === '') return true;
  return String(v).trim() === '合計';
}

/**
 * 管理表を取り込む（サーバー側でファイル全体を読む経路）。
 * 同じ内容のファイルが既に取り込まれている場合は DuplicateImportError を投げる
 * （明細がそのまま二重になり、値上げ金額の集計が二倍になってしまうため）。
 * 意図的に再取込したいときは force を立てる。
 * mapping を渡すと、自動判定ではなくその対応で取り込む。
 */
export async function importWorkbook(buffer, filename, userId, onProgress, { force = false, mapping } = {}) {
  await initDb();

  const contentHash = contentHashOf(buffer);
  if (!force) await assertNotDuplicate(contentHash);

  const info = inspectWorkbook(buffer);
  const useMapping = mapping ?? info.mapping;
  validateMapping(useMapping);

  const batchId = await createBatch(filename, userId, contentHash);

  const warnings = new Map();
  let pending = [];
  let count = 0;

  for (let i = info.headerRow + 1; i < info.grid.length; i++) {
    const cells = info.grid[i];
    if (!cells || isSkippableRow(cells, useMapping)) continue;
    pending.push(buildRow(cells, useMapping, warnings));
    count++;

    if (pending.length >= CHUNK_SIZE) {
      await insertRows(batchId, pending);
      pending = [];
      // 途中で中断（サーバーレスの実行時間切れなど）しても、
      // どこまで入ったかが取込履歴に残るようにここで件数を更新する
      await updateBatchCount(batchId, count);
      onProgress?.(count);
    }
  }
  if (pending.length) await insertRows(batchId, pending);

  await updateBatchCount(batchId, count);
  onProgress?.(count);

  return { batchId, count, skipped: summarizeWarnings(warnings), mapping: useMapping };
}

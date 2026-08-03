import * as XLSX from 'xlsx';
import { api } from './api';

/**
 * 案件一覧から書き出したExcelに合意単価などを記入して、まとめて戻すための取込。
 *
 * Vercelはリクエスト本文を約4.5MBまでしか受け取れないため、ファイルのままは送れない。
 * ブラウザで読み取り、必要な列だけを小分けにして送る（Excel取込と同じ考え方）。
 *
 * 案件IDで行を突き合わせる。IDが無いファイルは受け付けない
 * （同じ得意先・同じ器種の行が複数あると、どの行か決められないため）。
 */

/** 書き出しの見出し → 送る項目。表記ゆれを吸収して突き合わせる */
const COLUMN_MAP: Record<string, string> = {
  '案件ID': 'id',
  '値上後単価': 'r1_agreed_price',
  '第1弾適用年月': 'r1_applied_ym',
  '第1弾完了': 'r1_done',
  '最終確定単価': 'r2_agreed_price',
  '第2弾適用年月': 'r2_applied_ym',
  '第2弾完了': 'r2_done',
  // 目標は管理者だけが変えられる。管理者以外が入れて送るとサーバー側で断られる
  '新出荷単価': 'r1_target_price',
  '第2弾新値上げ単価': 'r2_target_price',
};

/** 全角英数を半角へ寄せ、空白・記号を落として見出しを突き合わせる */
function normalizeHeader(raw: unknown): string {
  let s = String(raw ?? '');
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[\s　()（）[\]【】・.,、。_\-ー―－〜~:：]/g, '');
  return s.toUpperCase();
}

const NORMALIZED_MAP = new Map(
  Object.entries(COLUMN_MAP).map(([label, key]) => [normalizeHeader(label), key])
);

/** 「〇」「○」「o」「1」を完了とみなす。空欄は未完了 */
function toDone(v: unknown): number {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 0;
  return ['〇', '○', 'o', '1', 'true', '済', '完了'].includes(s) ? 1 : 0;
}

/** 金額。空欄は「変更しない」ではなく「未入力にする」意味なので null を返す */
function toPrice(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[,¥\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 適用年月。Excelが日付にしてしまった場合も YYYY-MM に戻す */
function toYm(v: unknown): string | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
  }
  return String(v).trim();
}

export interface BulkRow {
  id: number;
  [key: string]: unknown;
}

export interface ParsedBulkFile {
  filename: string;
  headerRow: number;
  /** 見つかった項目（案件ID以外） */
  fields: string[];
  rows: BulkRow[];
  /** 案件IDが読み取れなかった行数 */
  skippedRows: number;
}

/** Excelを読み、送る行を組み立てる */
export async function parseBulkFile(file: File): Promise<ParsedBulkFile> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('シートが見つかりません');
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, raw: false, defval: '' });

  // 案件IDの見出しがある行を探す（先頭に説明行があっても拾えるように）
  let headerRow = -1;
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    if ((grid[i] || []).some((c) => normalizeHeader(c) === normalizeHeader('案件ID'))) {
      headerRow = i;
      break;
    }
  }
  if (headerRow < 0) {
    throw new Error('「案件ID」の列が見つかりません。案件一覧のExcel出力で作ったファイルをお使いください');
  }

  const headers = (grid[headerRow] || []).map((c) => String(c ?? ''));
  const colOf: Record<string, number> = {};
  headers.forEach((h, i) => {
    const key = NORMALIZED_MAP.get(normalizeHeader(h));
    // 同じ項目が複数あるときは左の列を使う
    if (key && colOf[key] === undefined) colOf[key] = i;
  });

  const idCol = colOf.id;
  const fields = Object.keys(colOf).filter((k) => k !== 'id');
  if (!fields.length) {
    throw new Error('取り込める項目がありません（合意単価・適用年月・完了の列が必要です）');
  }

  const rows: BulkRow[] = [];
  let skippedRows = 0;
  for (let i = headerRow + 1; i < grid.length; i++) {
    const line = grid[i] || [];
    const id = Number(String(line[idCol] ?? '').trim());
    if (!Number.isFinite(id) || id <= 0) {
      // 空行は数えない。値があるのにIDが読めない行だけを「読み飛ばし」とする
      if (line.some((c) => String(c ?? '').trim() !== '')) skippedRows += 1;
      continue;
    }
    const row: BulkRow = { id };
    for (const key of fields) {
      const v = line[colOf[key]];
      if (key.endsWith('_done')) row[key] = toDone(v);
      else if (key.endsWith('_applied_ym')) row[key] = toYm(v);
      else row[key] = toPrice(v);
    }
    rows.push(row);
  }
  if (!rows.length) throw new Error('取り込める行がありません');

  return { filename: file.name, headerRow, fields, rows, skippedRows };
}

export interface BulkResult {
  updated: number;
  unchanged: number;
  notFound: number;
  errors: { id: number | null; message: string }[];
}

const CHUNK = 500;

/**
 * 送信する。dryRun のときは書き込まずに件数だけ数える。
 * onProgress には送り終えた行数を渡す。
 */
export async function sendBulkUpdate(
  rows: BulkRow[],
  opts: { dryRun: boolean; onProgress?: (done: number, total: number) => void }
): Promise<BulkResult> {
  const total = rows.length;
  const sum: BulkResult = { updated: 0, unchanged: 0, notFound: 0, errors: [] };

  for (let i = 0; i < total; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const r = await api<BulkResult>('/deals/bulk-update', {
      method: 'POST',
      body: JSON.stringify({ rows: chunk, dryRun: opts.dryRun }),
    });
    sum.updated += r.updated;
    sum.unchanged += r.unchanged;
    sum.notFound += r.notFound;
    // エラーは多すぎると画面が埋まるので、先頭だけ残して件数で示す
    for (const e of r.errors) if (sum.errors.length < 50) sum.errors.push(e);
    opts.onProgress?.(Math.min(i + CHUNK, total), total);
  }
  return sum;
}

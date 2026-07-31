import * as XLSX from 'xlsx';
import { api } from './api';

/**
 * ブラウザ側でExcelを読み、行データだけを小分けにして送る取込。
 *
 * Vercelはリクエスト本文を約4.5MBまでしか受け取れないため、
 * 数MBの管理表をファイルのまま送ることはできない。
 * ここでファイルを解析し、必要な列だけを1回500行ずつ送ることで、
 * ファイルの大きさに関係なく取り込めるようにしている。
 */

export interface FieldDef {
  key: string;
  label: string;
  group: string;
  type: 'text' | 'number' | 'date';
  required: boolean;
  /** 見出しの候補。サーバーの項目定義と同じものを受け取る */
  aliases?: string[];
}

export interface ParsedFile {
  filename: string;
  contentHash: string;
  /** 見出しより下のデータから作る指紋。再保存しただけの違いを無視して二重取込を止める */
  dataHash: string;
  headerRow: number;
  headers: string[];
  /** 見出し行より下の全行（セルの配列） */
  rows: unknown[][];
  /** 項目key → 列index */
  mapping: Record<string, number>;
  matched: { index: number; header: string; field: string }[];
  unmatched: { index: number; header: string }[];
  missingRequired: string[];
  /** 見出しの下に続く数行。対応づけの確認に使う */
  preview: unknown[][];
}

/** 見出しの表記ゆれを吸収する（server/fields.js と同じ規則） */
function normalizeHeader(raw: unknown): string {
  let s = String(raw ?? '');
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/／/g, '/').replace(/％/g, '%').replace(/　/g, '');
  s = s.replace(/[\s()（）[\]【】・.,、。_\-ー―－〜~:：]/g, '');
  return s.toUpperCase();
}

/** SHA-256（二重取込の判定に使う） */
async function sha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * データ部分の指紋。server/fields.js の fingerprintRows と同じ規則で作る。
 * Excelは開いて保存し直すだけでバイト列が変わるため、ファイルのハッシュだけでは
 * 中身が同じでも別ファイル扱いになり、二重取込を止められない。
 */
function fingerprintCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

async function dataHashOf(rows: unknown[][]): Promise<string> {
  const text = rows.map((r) => (r || []).map(fingerprintCell).join('\t')).join('\n');
  return sha256(new TextEncoder().encode(text));
}

/** 見出し行を探す（項目名として認識できるセルが最も多い行） */
function findHeaderRow(grid: unknown[][], aliasIndex: Map<string, string>, limit = 15): number {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(grid.length, limit); i++) {
    const cells = (grid[i] || []).map((c) => String(c ?? '').trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const score = cells.filter((c) => aliasIndex.has(normalizeHeader(c))).length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return bestScore >= 3 ? best : -1;
}

/**
 * 「正規化した見出し → 項目key」を作る。
 * 別名はサーバーの項目定義をそのまま使う。ここで独自に推測すると
 * サーバー側の判定とずれて、同じファイルでも結果が変わってしまう。
 */
function buildAliasIndex(fields: FieldDef[]): Map<string, string> {
  const idx = new Map<string, string>();
  const add = (text: string, key: string) => {
    const n = normalizeHeader(text);
    if (n && !idx.has(n)) idx.set(n, key);
  };
  for (const f of fields) {
    add(f.label, f.key);
    for (const a of f.aliases ?? []) add(a, f.key);
  }
  return idx;
}

export async function parseFile(file: File, fields: FieldDef[]): Promise<ParsedFile> {
  const buffer = await file.arrayBuffer();
  const contentHash = await sha256(buffer);
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('シートが見つかりません');
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true });

  const aliasIndex = buildAliasIndex(fields);
  const headerRow = findHeaderRow(grid, aliasIndex);
  if (headerRow < 0) {
    throw new Error('見出し行が見つかりません。「売上年月」「出荷単価」などの列を含む行が必要です');
  }
  const headers = (grid[headerRow] || []).map((h) => String(h ?? '').trim());

  const mapping: Record<string, number> = {};
  const matched: ParsedFile['matched'] = [];
  const unmatched: ParsedFile['unmatched'] = [];
  headers.forEach((h, i) => {
    if (!h) return;
    const key = aliasIndex.get(normalizeHeader(h));
    if (key) {
      mapping[key] = i;   // 同じ項目に複数当たった場合は後ろの列を採用
      matched.push({ index: i, header: h, field: key });
    } else {
      unmatched.push({ index: i, header: h });
    }
  });

  const rows = grid.slice(headerRow + 1);
  return {
    filename: file.name,
    contentHash,
    dataHash: await dataHashOf(rows),
    headerRow,
    headers,
    rows,
    mapping,
    matched,
    unmatched,
    missingRequired: fields.filter((f) => f.required && mapping[f.key] === undefined).map((f) => f.key),
    preview: rows.slice(0, 5),
  };
}

/** Excelの日付セルはDateで返るため、送る前に文字列へ直す */
function toSendable(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v ?? null;
}

export interface UploadProgress {
  sent: number;
  total: number;
}

export interface UploadResult {
  batchId: number;
  count: number;
  skipped: { column: string; label: string; count: number; samples: string[] }[];
}

/**
 * 解析済みのファイルを分割して送る。
 * 途中で失敗したら、それまでに入った行ごと取込を取り消す
 * （中途半端に入ったまま残ると、金額が合わない原因が分からなくなるため）。
 */
export async function uploadInChunks(
  parsed: ParsedFile,
  mapping: Record<string, number>,
  opts: { force?: boolean; chunkRows?: number; onProgress?: (p: UploadProgress) => void } = {}
): Promise<UploadResult> {
  const chunkRows = opts.chunkRows ?? 500;
  // 送るのは対応づけた列だけ。列番号は詰め直して送信量を減らす
  const usedCols = [...new Set(Object.values(mapping).filter((i) => i != null && i >= 0))].sort((a, b) => a - b);
  const compactMapping: Record<string, number> = {};
  for (const [key, idx] of Object.entries(mapping)) {
    if (idx == null || idx < 0) continue;
    compactMapping[key] = usedCols.indexOf(idx);
  }

  const { batchId } = await api<{ batchId: number }>('/import/session', {
    method: 'POST',
    body: JSON.stringify({
      filename: parsed.filename,
      contentHash: parsed.contentHash,
      dataHash: parsed.dataHash,
      mapping: compactMapping,
      force: opts.force ?? false,
    }),
  });

  const skipped = new Map<string, { column: string; label: string; count: number; samples: string[] }>();
  let sent = 0;
  try {
    for (let i = 0; i < parsed.rows.length; i += chunkRows) {
      const slice = parsed.rows.slice(i, i + chunkRows)
        .map((row) => usedCols.map((c) => toSendable(row?.[c])));
      const res = await api<{ added: number; total: number; skipped: UploadResult['skipped'] }>(
        `/import/session/${batchId}/rows`,
        { method: 'POST', body: JSON.stringify({ rows: slice, mapping: compactMapping }) }
      );
      for (const w of res.skipped ?? []) {
        const prev = skipped.get(w.column);
        if (prev) {
          prev.count += w.count;
          for (const s of w.samples) if (prev.samples.length < 3 && !prev.samples.includes(s)) prev.samples.push(s);
        } else {
          skipped.set(w.column, { ...w, samples: [...w.samples] });
        }
      }
      sent = Math.min(i + chunkRows, parsed.rows.length);
      opts.onProgress?.({ sent, total: parsed.rows.length });
    }
    const fin = await api<{ batchId: number; count: number }>(`/import/session/${batchId}/finish`, { method: 'POST' });
    return { batchId, count: fin.count, skipped: [...skipped.values()] };
  } catch (e) {
    // 中断した分は残さない
    await api(`/import/session/${batchId}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

/**
 * 件数が多いときのExcel出力（分割出力）。
 *
 * サーバー（Vercel）は1回の応答が約4.5MBまでのため、Excelファイルを
 * サーバーで作れるのは数千件まで。それを超えるときは、この仕組みで
 * 表の中身を数千行ずつJSONで受け取り、ブラウザでExcelに組み立てる。
 * 取込（数十万行のExcelをブラウザで読む）と同じ考え方で、
 * ブラウザ側には応答の大きさにも実行時間にも上限が無い。
 */
import * as XLSX from 'xlsx';

interface Chunk {
  rows: (string | number)[][];
  header?: string[];
  widths?: number[];
  total?: number;
  nextId: number | null;
}

export async function exportLargeExcel(
  queryString: string,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const all: (string | number)[][] = [];
  let header: string[] = [];
  let widths: number[] = [];
  let total = 0;
  let sinceId = 0;
  // 数千行ずつ取り出す。応答の nextId が無くなったら終わり
  for (;;) {
    const qs = new URLSearchParams(queryString);
    if (sinceId) qs.set('sinceId', String(sinceId));
    const res = await fetch(`/api/deals/export-rows?${qs}`, { credentials: 'same-origin' });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `出力の取得に失敗しました（${res.status}）`);
    }
    const chunk: Chunk = await res.json();
    if (chunk.header) { header = chunk.header; widths = chunk.widths ?? []; total = chunk.total ?? 0; }
    all.push(...chunk.rows);
    onProgress(all.length, total);
    if (!chunk.nextId) break;
    sinceId = chunk.nextId;
  }

  // dense（行の配列のまま持つ形）にすると、10万行でも数秒で組み立てられる
  const ws = XLSX.utils.aoa_to_sheet([header, ...all], { dense: true });
  ws['!cols'] = widths.map((wch) => ({ wch }));
  ws['!freeze'] = { xSplit: 3, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '値上げ管理表');
  const buf: ArrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });

  // できたファイルをダウンロードとして渡す
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = URL.createObjectURL(new Blob([buf],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `値上げ管理表_${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 取り消しは少し待ってから。10万件だとファイルが100MBを超えることがあり、
  // 押した直後に取り消すとブラウザが読み終える前に元を失って落ちることがある
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

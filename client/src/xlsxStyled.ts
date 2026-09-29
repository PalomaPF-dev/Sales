/**
 * セルに色を付けてExcelを書き出すための部品。
 *
 * いつもの xlsx（SheetJS）は書き出しで色（スタイル）を付けられないため、
 * 色付きの書き出しだけ xlsx-js-style を使う。出荷実績（色分け）の書き出しは、
 * 別のVBAプログラムがセルの背景色（RGB）を読んでデータを整理するため、色が必要。
 * 部品が大きいので、書き出すときにだけ読み込む。
 */
import type { WorkSheet } from 'xlsx-js-style';

export type StyledXlsx = typeof import('xlsx-js-style');

export async function loadStyledXlsx(): Promise<StyledXlsx> {
  const m = await import('xlsx-js-style') as StyledXlsx & { default?: StyledXlsx };
  return m.default ?? m;
}

/** 塗りつぶしの色（#CAEEFB の形でも CAEEFB の形でもよい）。空なら塗らない */
export function fillOf(hex: string | undefined | null) {
  const rgb = String(hex ?? '').replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(rgb) || rgb === 'FFFFFF') return null;
  return { fill: { patternType: 'solid', fgColor: { rgb } } };
}

/** セルに書式を足す（セルが無ければ空のセルを作る） */
export function paint(X: StyledXlsx, ws: WorkSheet, r: number, c: number, style: object | null) {
  if (!style) return;
  const addr = X.utils.encode_cell({ r, c });
  const cell = (ws[addr] ?? { t: 's', v: '' }) as { s?: object };
  cell.s = { ...(cell.s ?? {}), ...style };
  ws[addr] = cell as WorkSheet[string];
}

/** 見出し行を太字にする */
export const BOLD = { font: { bold: true } };

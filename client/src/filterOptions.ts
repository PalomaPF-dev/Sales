/**
 * 絞り込みの項目。案件一覧・ダッシュボード・平均単価で同じものを使う
 * （同じ条件のまま画面を行き来できるようにするため）。サーバー側の判定も同じ。
 */
export const FILTER_KEYS = ['q', 'equip', 'category', 'model', 'person', 'customer', 'corp',
  'branch', 'office', 'aState', 'act', 'aDateYm', 'aDateOp', 'gain', 'base'] as const;

/**
 * 値上げ幅の「基準」（比較のもと）。
 * マスタ登録単価（A基準）とこの単価との差が値上げ幅で、
 * それに当月の実績数を掛けたものが値上げ額になる。
 */
export const BASE_OPTIONS = [
  { key: 'master', label: 'マスタ単価', note: '値決めの単価' },
  { key: 'actual', label: '実単価', note: '金額÷数量。見積ぶんが混ざる' },
  { key: 'past', label: '過去最新単価', note: '値上げ前の単価' },
] as const;

/**
 * 品目の絞り込みは 器具区分（大分類）→ カテゴリー名（大）→ 品目階層名 の順に選ぶ。
 *
 * サーバー（/meta）は「どの親に属するか」を添えた組み合わせで選択肢を返す。
 * 同じカテゴリー名が複数の器具区分にある場合があるため、名前だけでは決められない。
 * ここで選んだ親に属するものだけに絞り、同じ名前は件数を足して1つにまとめる。
 */
export function narrowByParent<T extends { name: string; count: number }>(
  items: T[] | undefined,
  parents: [keyof T, string][],
): { name: string; count: number }[] {
  const kept = (items ?? []).filter((x) =>
    parents.every(([key, value]) => !value || String(x[key] ?? '') === value));
  const merged = new Map<string, number>();
  for (const x of kept) merged.set(x.name, (merged.get(x.name) ?? 0) + x.count);
  return [...merged].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

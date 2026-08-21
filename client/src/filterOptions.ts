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

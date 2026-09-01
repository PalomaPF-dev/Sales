/**
 * 計画の月（当月・翌月・翌々月・3か月後）の決まり。
 *
 * 毎日の価格調査（取込ファイル）は「前日の結果」で、ファイルの見出しの日付は
 * ファイルを作った日をもとに振られている。ふだんはどちらも同じ月なので違いは
 * 出ないが、月初（1日）に取り込むと、中身は前の月の結果なのに見出しだけ
 * 新しい月になり、前の月が計画の4か月から外れてしまう
 * （9/1の取込で8月が抜けた）。
 * そのため月はファイルの見出しではなく、データの日付から決める。
 *
 * 取込のときはサーバーが決めた月を正とする（server/api.js の同名の関数）。
 * Excelの部品を読み込まずに取込前の確認へ出せるよう、ここだけ別ファイルにしている。
 */

/** 「2026-08-31」→ ['2026-08','2026-09','2026-10','2026-11'] */
export function planMonthsFrom(ymd: string): string[] {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(ymd ?? ''));
  if (!m) return [];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return [0, 1, 2, 3].map((n) => {
    const t = mo - 1 + n;
    return `${y + Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

/**
 * データの日付。毎日の価格調査は前日の結果なので、取込日（未入力なら今日）の1日前。
 * 日本時間で数える（サーバーはUTCで動くため、画面と同じ日になるようにそろえる）。
 */
export function dataDateOf(takenOn?: string): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  let base: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(takenOn ?? ''))) {
    base = new Date(`${takenOn}T00:00:00Z`);
  } else {
    // 今日（日本時間）
    base = new Date(Date.now() + 9 * 3600 * 1000);
    base = new Date(`${base.toISOString().slice(0, 10)}T00:00:00Z`);
  }
  base.setUTCDate(base.getUTCDate() - 1);
  return `${base.getUTCFullYear()}-${p2(base.getUTCMonth() + 1)}-${p2(base.getUTCDate())}`;
}

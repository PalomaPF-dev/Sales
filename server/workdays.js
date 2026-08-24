/**
 * 月ごとの稼働日（営業日）。
 *
 * 計画（マスタ登録単価）の金額は、売上高を取り込んだ月（＝実績の月）の
 * 数量をそのまま使って出している。ところが月によって稼働日が違うため、
 * そのままでは「稼働日の多い月ほど計画が大きい」ことになってしまう。
 *
 * そこで実績の月を稼働日で割って日量（1稼働日あたり）に直し、
 * 計画の月の稼働日を掛け直す。
 *
 *   計画額（N月） = 実績の月の金額 ÷ 実績の月の稼働日 × N月の稼働日
 *
 * 稼働日は営業部の決めた日数で、年が変わっても月の並びは同じ扱いにする
 * （年ごとに変える必要が出たら、ここに年月の表を足す）。
 */
export const WORKDAYS = {
  7: 22,
  8: 16,
  9: 20,
  10: 22,
  11: 21,
  12: 19,
};

/** 「YYYY-MM」から稼働日を返す。表に無い月は null（換算しない） */
export function workdaysOf(ym) {
  const m = /^\d{4}-(\d{2})$/.exec(String(ym ?? ''));
  if (!m) return null;
  return WORKDAYS[Number(m[1])] ?? null;
}

/**
 * 実績の月（baseYm）を1とした、その月（ym）の日量の倍率。
 * どちらかの稼働日が分からないときは 1（換算しない）を返す。
 */
export function workdayRate(baseYm, ym) {
  const base = workdaysOf(baseYm);
  const days = workdaysOf(ym);
  if (!(base > 0) || !(days > 0)) return 1;
  return days / base;
}

/**
 * ダッシュボードへ渡す稼働日の一覧。
 * 画面とExcelが同じ日数・同じ倍率で計算できるようにまとめて返す。
 */
export function workdayPlan(baseYm, planYms) {
  const baseDays = workdaysOf(baseYm);
  return {
    baseYm: baseYm || '',
    baseDays,
    months: (planYms ?? []).map((ym) => ({
      ym: ym || '',
      days: workdaysOf(ym),
      rate: workdayRate(baseYm, ym),
    })),
  };
}

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
 * 月の途中まで（データの日付 asOf まで）の稼働日の見込み。
 *
 * 売上高を日次（当月の累計）で取り込むと、実績は月の途中までしか無い。
 * それを月まるごとの稼働日で割ると日量が小さく出て、計画が実態より低くなる。
 * そこで「その日までに何稼働日あったか」で割る。
 *
 * 稼働日は営業部の決めた月の日数（WORKDAYS）で、暦から機械的には出せない。
 * ここでは月の平日（月〜金）のうち asOf までの割合で按分して見込む
 * （月末まで来れば必ず月の稼働日そのものになる）。
 * 取込のときに数を直せるので、盆休みなどで合わないときはそちらで調整する。
 * 稼働日の分からない月・日付が月の外なら null（換算しない）。
 */
export function elapsedWorkdays(ym, asOf) {
  const total = workdaysOf(ym);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(asOf ?? ''));
  if (!total || !m || String(asOf).slice(0, 7) !== String(ym)) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const d = Math.min(Number(m[3]), last);
  const weekdays = (upto) => {
    let c = 0;
    for (let i = 1; i <= upto; i++) {
      const w = new Date(Date.UTC(y, mo - 1, i)).getUTCDay();
      if (w !== 0 && w !== 6) c += 1;
    }
    return c;
  };
  const all = weekdays(last);
  const done = weekdays(d);
  if (done >= all || all === 0) return total;
  return Math.max(1, Math.round((total * done) / all));
}

/**
 * 実績の月の「日量換算のもと」になる稼働日。
 *
 * 売上高が月次（月まるごと）なら月の稼働日、日次（当月の累計）なら
 * データの日付までの稼働日（取込のときに決めた数）。
 * 画面で別の月（月別に残した過去の月）を選んでいるときは、その月は
 * まるごとの実績なので月の稼働日を使う。
 */
export function actualBaseDays(actualMeta, ym) {
  if (!actualMeta || actualMeta.mode !== 'daily') return null;
  if (String(actualMeta.ym ?? '') !== String(ym ?? '')) return null;
  const n = Number(actualMeta.elapsedDays);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * ダッシュボードへ渡す稼働日の一覧。
 * 画面とExcelが同じ日数・同じ倍率で計算できるようにまとめて返す。
 *
 * opts.baseDays … 実績の月の稼働日を差し替える（日次取込で月の途中までのとき）。
 * opts.asOf     … その実績が「いつまで」の累計か（画面の但し書きに出す）。
 */
export function workdayPlan(baseYm, planYms, opts = {}) {
  const override = Number(opts?.baseDays);
  const partial = Number.isFinite(override) && override > 0;
  const baseDays = partial ? override : workdaysOf(baseYm);
  const rate = (ym) => {
    const days = workdaysOf(ym);
    if (!(baseDays > 0) || !(days > 0)) return 1;
    return days / baseDays;
  };
  return {
    baseYm: baseYm || '',
    baseDays,
    // 月の途中までの累計（稼働日を差し替えた）ときだけ入る（月次・過去の月では null）
    asOf: partial && opts?.asOf && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf))
      ? String(opts.asOf) : null,
    months: (planYms ?? []).map((ym) => ({
      ym: ym || '',
      days: workdaysOf(ym),
      rate: rate(ym),
    })),
  };
}

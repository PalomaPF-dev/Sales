import XLSX from 'xlsx';

/**
 * 案件一覧の内容をそのままExcelにする。
 *
 * 列は画面と同じ並び（基本情報 → 実績（価格調査） → A基準・目標値 → 値上げ幅 → 交渉）。
 * 絞り込みは呼び出し側（/deals/export）で効かせているので、
 * ここには絞り込み済みの行だけが渡ってくる。
 *
 * 書き出したファイルに決定単価などを書き込んで戻せるよう、先頭に案件IDを置く
 * （同じ法人・同じ器種の行が複数あるとき、これが無いとどの行か決められない）。
 */

/** 「2026-09」→「9月」。取込前は仮の名前で出す */
const ymLabel = (ym, fallback) =>
  (ym && /^\d{4}-\d{2}$/.test(ym) ? ym : fallback);

const CORP_STATUS_LABELS = {
  not_started: '未着手',
  negotiating: '交渉中',
  agreed: '合意',
  declined: '値上げ不可',
};

const STATE_LABELS = { open: '未入力', agreed: '合意済', done: '完了' };

/**
 * 列の定義を組み立てる。
 * A基準の見出しは取り込んだ月（2026-09 など）にする。
 * 実績原価は本社・管理者・開発者のときだけ足す（社外秘に準ずる扱い）。
 */
function buildColumns({ months, withCost, aggMeta, actualMeta, base }) {
  const m = (k, fallback) => ymLabel(aggMeta?.[k], fallback);
  const m0 = m('m0', '当月');
  const m1 = m('m1', '翌月');
  const m2 = m('m2', '翌々月');
  const m3 = m('m3', '3か月後');

  // 現状は価格調査の当月実績（単価・数量）。過去最新単価と比べると実際の値上がりが分かる
  const effPrice = (r) => (r.master_avg_price ?? null);
  const monthlyQty = (r) => (r.master_qty == null ? null : Number(r.master_qty));
  /**
   * 値上げ幅の基準（比較のもと）。画面の「基準」で選んだものを使う。
   *   past … 過去最新単価 / master … マスタ単価 / actual … 実単価
   */
  const baseCol = { past: 'past_price', master: 'master_price', actual: 'master_avg_price' }[base]
    ?? 'master_price';
  const baseName = { past_price: '過去最新単価', master_price: 'マスタ単価', master_avg_price: '実単価' }[baseCol];
  /** 基準の単価。0以下・未設定は「基準が無い」＝変動なしとして扱う */
  const basePrice = (r) => (Number(r[baseCol]) > 0 ? Number(r[baseCol]) : null);
  const actYm = String(actualMeta?.ym ?? '');
  const actLabel = actYm ? `${Number(actYm.slice(5, 7))}月` : '当月';

  /**
   * 翌月（9月計画）は、承認日が「実績の月の1日」より前か未記入なら
   * 当月（8月計画）をそのままスライドして扱う（画面の一覧と同じ決まり）。
   */
  const slideFrom = (() => {
    const v = String(aggMeta?.m0 ?? '');
    if (!/^\d{4}-\d{2}$/.test(v)) return null;
    const y = Number(v.slice(0, 4));
    const mm = Number(v.slice(5, 7));
    const py = mm === 1 ? y - 1 : y;
    const pm = mm === 1 ? 12 : mm - 1;
    return `${py}-${String(pm).padStart(2, '0')}-01`;
  })();
  const slid = (r) => Boolean(slideFrom) && String(r.a_date_m1 ?? '').slice(0, 10) < slideFrom;
  /** その行のその月の申請単価。翌月はスライドの決まりを当てはめる */
  const aPrice = (r, key) => (key === 'a_price_m1' && slid(r) ? r.a_price_m0 : r[key]);

  /**
   * 値上げ幅 = その月のA基準 − 基準の単価。
   * 単価0は未申請なので空にする。基準の単価が無い・当月の実績数が無い品目は
   * 「変動なし」として空にする（数量が当月の実績数のため、比べる土台が無い）。
   */
  const diff = (key) => (r) => {
    const a = Number(aPrice(r, key));
    const b = basePrice(r);
    if (!(a > 0) || b == null || !(Number(monthlyQty(r)) > 0)) return '';
    return round(a - b);
  };

  const cols = [
    ['案件ID', (r) => r.id],
    ['法人コード', (r) => r.corp_code],
    ['法人名', (r) => r.corp_name],
    ['得意先名', (r) => r.customer_name],
    ['納入先名', (r) => r.delivery_name],
    ['商品コード', (r) => r.model_code],
    ['器種名（型式）', (r) => r.product_name],
    ['規格', (r) => r.gas_type],
    ['品目階層名', (r) => r.model_name],
    ['器具区分', (r) => r.equip_name],
    ['支店', (r) => r.branch],
    ['営業所', (r) => r.office],
    ['担当者', (r) => r.sales_person],

    // 実績（価格調査）。値上げ前 → 当月の実単価と、その上がり幅・数量
    ['過去最新単価', (r) => round(r.past_price)],
    ['過去最新受注日', (r) => r.past_date],
    [`実単価（${actLabel}）`, (r) => round(effPrice(r))],
    ['上がり幅（実単価−過去）', (r) => {
      if (effPrice(r) == null || r.past_price == null) return '';
      return round(Number(effPrice(r)) - Number(r.past_price));
    }],
    [`数量（${actLabel}）`, (r) => (monthlyQty(r) == null ? '' : round(Number(monthlyQty(r)), 2))],
    [`金額（${actLabel}）`, (r) => round(r.master_amount)],

    // A基準（マスタ登録の申請単価）と、その承認日・稟議No
    [`マスタ登録単価 ${m0}`, (r) => round(r.a_price_m0)],
    [`承認日 ${m0}`, (r) => r.a_date_m0],
    [`稟議No ${m0}`, (r) => r.a_ringi_m0],
    [`マスタ登録単価 ${m1}`, (r) => round(aPrice(r, 'a_price_m1'))],
    // スライドしたときは、単価と同じく当月の承認日を出す（画面の一覧と同じ）
    [`承認日 ${m1}`, (r) => (slid(r) ? r.a_date_m0 : r.a_date_m1)],
    [`稟議No ${m1}`, (r) => r.a_ringi_m1],
    [`マスタ登録単価 ${m2}`, (r) => round(r.a_price_m2)],
    [`承認日 ${m2}`, (r) => r.a_date_m2],
    [`稟議No ${m2}`, (r) => r.a_ringi_m2],
    [`マスタ登録単価 ${m3}`, (r) => round(r.a_price_m3)],
    [`承認日 ${m3}`, (r) => r.a_date_m3],
    [`稟議No ${m3}`, (r) => r.a_ringi_m3],
    ['目標単価（本社設定）', (r) => round(r.r2_target_price)],

    // 値上げ幅（A基準 − 選んだ基準の単価）と、月あたりの値上げ額
    [`値上げ幅 ${m0}（対 ${baseName}）`, diff('a_price_m0')],
    [`値上げ幅 ${m1}（対 ${baseName}）`, diff('a_price_m1')],
    [`値上げ幅 ${m2}（対 ${baseName}）`, diff('a_price_m2')],
    [`値上げ幅 ${m3}（対 ${baseName}）`, diff('a_price_m3')],
    [`値上げ額（月あたり）${m3}`, (r) => {
      const a = Number(r.a_price_m3);
      const b = basePrice(r);
      const qty = Number(monthlyQty(r));
      if (!(a > 0) || b == null || !(qty > 0)) return '';
      return round((a - b) * qty);
    }],

    // 交渉（営業担当者が入力する）。商談結果は記号のまま出す
    // （〇=合意 / □=広域待ち / △=否決 / ×=本社へ相談）
    ['商談結果', (r) => r.nego_result],
    ['商談メモ', (r) => r.nego_note],
    ['最終確定日', (r) => r.final_date],
    ['最終確定単価', (r) => round(r.final_price)],
    ['適用年月', (r) => r.r2_applied_ym],
    ['状態', (r) => STATE_LABELS[r.r2_state] ?? ''],
    ['交渉状況（法人）', (r) => CORP_STATUS_LABELS[r.corp_status] ?? ''],
  ];

  if (withCost) cols.push(['実績原価（社外秘）', (r) => round(r.cost_price)]);
  return cols;
}

/** 小数の端数で列がガタつかないように丸める。値が無ければ空欄 */
function round(v, digits = 0) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/**
 * ダッシュボードの表をExcelにする。画面と同じ数字・同じ並びで、
 * 「まとめ」「器具区分別」「支店別」「法人別」をシートに分ける。
 *
 * 金額はすべて1か月あたり（期間合計の列は出さない。営業部の管理表の
 * 形式に合わせた）。
 */
export function buildDashboardWorkbook(data, opts = {}) {
  const months = Number(data.months) > 0 ? Number(data.months) : 12;
  const n = (v) => Number(v ?? 0);
  const m = (k, fallback) => ymLabel(data.aggMeta?.[k], fallback);
  const m0 = m('m0', '当月');
  const m1 = m('m1', '翌月');
  const m2 = m('m2', '翌々月');
  const m3 = m('m3', '3か月後');
  const t = data.abTotals ?? {};
  // 計画の月の日量換算（稼働日）。実績の月を1として、その月の稼働日ぶんに直す。
  // 画面と同じ倍率をサーバーから受け取り、比較のもとにも同じ倍率を掛ける
  const wd = data.workdays ?? {};
  const wdMonths = Array.isArray(wd.months) ? wd.months : [];
  const rateOf = (i) => (Number(wdMonths[i]?.rate) > 0 ? Number(wdMonths[i].rate) : 1);
  // 見出しに添える稼働日（「16日」など）。分からない月は付けない
  const daysOf = (i) => (Number(wdMonths[i]?.days) > 0 ? `（${wdMonths[i].days}稼働日）` : '');
  // 当月の金額そのもの（土台）。条件シートとまとめシートの両方で使う
  const base = n(t.base_amt);
  // マスタ分（値決めどおりに出た分）の金額。A基準の比較のもと。合計との差が見積ぶん
  const mpAmt = n(t.mp_amt);

  const wb = XLSX.utils.book_new();
  const addSheet = (name, aoa, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = widths.map((wch) => ({ wch }));
    ws['!freeze'] = { xSplit: 1, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  // ── 条件（いつ・どの絞り込みで出したかを残す）
  // サーバーはUTCで動くため、日本時間に直した日付を出す
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const cond = [['価格調査データ', today], ['項目', '内容']];
  for (const [label, value] of opts.filters ?? []) cond.push([label, value]);
  if ((opts.filters ?? []).length === 0) cond.push(['絞り込み', 'なし（全件）']);
  cond.push([]);
  cond.push(['表示範囲', data.scope?.label ?? '']);
  cond.push(['品目件数（価格調査）', n(data.histTotals?.deals)]);
  cond.push(['当月実績の金額（土台）', round(base)]);
  cond.push(['当月の金額（マスタ）', round(mpAmt)]);
  cond.push(['見積ぶんなど（合計−マスタ）', round(base - mpAmt)]);
  {
    const a = data.actuals?.[0];
    if (a) {
      const g = n(a.gainPlus) + n(a.gainMinus);
      cond.push(['値上げ前当初（金額（合計）−売上改善額）', round(base - g)]);
      cond.push(['売上改善額 プラス', round(n(a.gainPlus))]);
      cond.push(['売上改善額 マイナス', round(n(a.gainMinus))]);
      cond.push(['売上改善額 合計', round(g)]);
      cond.push(['うち過去最新単価のある品目の金額（合計）', round(n(a.amount))]);
      cond.push(['同 金額（マスタ）', round(n(a.mstAmount))]);
    }
  }
  cond.push(['マスタ登録単価ありの件数', n(data.aMonths?.covered)]);
  // 計画の金額をどの稼働日で日量換算したか。数字の出どころが分かるように残す
  if (Number(wd.baseDays) > 0 && wdMonths.some((x) => Number(x?.days) > 0)) {
    cond.push([]);
    cond.push(['計画の日量換算', `${ymLabel(wd.baseYm, '実績の月')} ${wd.baseDays}稼働日をもとに、`
      + '計画の月の稼働日ぶんへ換算しています']);
    for (const [i, ym] of [[0, m0], [1, m1], [2, m2], [3, m3]]) {
      const days = Number(wdMonths[i]?.days);
      cond.push([`稼働日 ${ym}`, days > 0
        ? `${days}日（${wd.baseDays}日比 ${round(rateOf(i) * 100, 1)}%）`
        : '未設定（換算なし）']);
    }
  }
  addSheet('条件', cond, [28, 40]);

  // ── まとめ（実績と計画を月の流れで並べる）
  const summary = [[
    '月', '区分', '件数', '上がった件数', '単価同じ件数',
    '比較のもと（月あたり）', '金額（月あたり）', '値上げ額（月あたり）', '値上げ率',
  ]];
  const act = data.actuals?.[0];
  const actYm = String(act?.ym ?? '当月');
  // 売上改善額（プラス・マイナスの合計）。金額（合計）から引くと値上げ前当初になる
  const gain = act ? n(act.gainPlus) + n(act.gainMinus) : null;
  const summaryRows = [
    // 値上げ前当初。当月の金額（合計）から売上改善額を引いた額
    ...(gain != null ? [{
      ym: `${actYm} 値上げ前当初`, kind: '当初',
      deals: n(t.deals), b: '', amt: base - gain, up: '', same: '',
    }] : []),
    // 実績。取り込んだ当月の金額そのもの。当初との差が売上改善額
    { ym: actYm, kind: '実績', deals: n(t.deals),
      b: gain == null ? '' : base - gain, amt: base,
      up: gain == null ? '' : n(act.up), same: gain == null ? '' : n(act.same) },
    // 参考。値決めどおりに出た分（実績との差が見積ぶんなど）
    ...(mpAmt > 0 ? [{
      ym: `${actYm}（マスタ）`, kind: '参考',
      deals: n(t.deals), b: base, amt: mpAmt, up: '', same: n(t.mp_same),
    }] : []),
    // 計画。比較のもとは値上げ前当初（当初からA基準までの上がり幅が値上げ額）。
    // 金額は稼働日で日量換算してあるので、比較のもとも同じ倍率に揃える
    ...[[0, m0, n(t.a0_amt)], [1, m1, n(t.a1_amt)],
      [2, m2, n(t.a2_amt)], [3, m3, n(t.a3_amt)]].map(([i, ym, amt]) => ({
      ym: `${ym}${daysOf(i)}`, kind: '計画', deals: n(t.deals),
      b: (gain == null ? base : base - gain) * rateOf(i),
      amt, up: '', same: '',
    })),
  ];
  for (const r of summaryRows) {
    const hasBase = r.b !== '' && r.b != null;
    const gain = hasBase ? r.amt - r.b : '';
    summary.push([
      r.ym, r.kind, r.deals, r.up, r.same,
      hasBase ? round(r.b / months) : '', round(r.amt / months),
      hasBase ? round(gain / months) : '',
      hasBase && r.b > 0 ? round((gain / r.b) * 100, 1) / 100 : '',
    ]);
  }
  addSheet('まとめ', summary, [12, 8, 10, 12, 12, 18, 18, 18, 10]);

  // ── 平均単価の比較（過去最新単価 → 計画）。画面のカードと同じ数字。
  // 過去最新単価・その月の計画・当月の実績数が揃う品目だけで、
  // 出荷数（当月の実績数）で重みを付けた平均単価を過去と計画で比べる
  {
    const a = data.aMonths ?? {};
    const avg = [[
      '計画の月', '対象件数', '出荷数（当月実績数）',
      '過去最新単価（平均）', '計画単価（平均）', '上がり幅（1台あたり）', '上がり率',
    ]];
    for (const [i, ym] of [[0, m0], [1, m1], [2, m2], [3, m3]]) {
      const cnt = n(a[`avg_cnt_m${i}`]);
      const qty = n(a[`avg_qty_m${i}`]);
      if (!(qty > 0)) { avg.push([ym, cnt, '', '', '', '', '']); continue; }
      const past = n(a[`avg_past_m${i}`]) / qty;
      const plan = n(a[`avg_plan_m${i}`]) / qty;
      avg.push([ym, cnt, round(qty, 1), round(past, 1), round(plan, 1),
        round(plan - past, 1), past > 0 ? round(((plan - past) / past) * 100, 1) / 100 : '']);
    }
    addSheet('平均単価', avg, [12, 10, 18, 18, 18, 18, 10]);
  }

  // ── 器具区分別・支店別・法人別（画面と同じ数字）
  // 月ごとに「A基準額 / 値上げ額 / 値上げ率」を出す。
  // 想定B基準は法人ごとに決める値のため、法人別のシートにだけ添える。
  // 実績（価格調査の実単価）は月ごとに出す。その月に実単価のあった品目だけの
  // 集計なので、比べる現状額もその品目ぶん（実績の現状額）を並べて入れる
  const abActYms = Array.isArray(data.abActYms) ? data.abActYms : [];
  const head = (first) => [
    first, '件数', '数量（月平均）',
    '現状額 合計（月あたり）',
    'うちマスタ（月あたり）',
    ...abActYms.flatMap((ym) => [
      `${ym} 実績額（月あたり）`, `${ym} 値上げ前当初（月あたり）`,
      `${ym} 売上改善額（月あたり）`, `${ym} 改善率`,
      `${ym} 改善額 プラス（月あたり）`, `${ym} 上がった件数`,
      `${ym} 改善額 マイナス（月あたり）`, `${ym} 下がった件数`,
      `${ym} 単価同じ件数`,
    ]),
    ...[[0, m0], [1, m1], [2, m2], [3, m3]].flatMap(([i, ym]) => [
      `${ym}${daysOf(i)} A基準額（月あたり）`,
      `${ym}${daysOf(i)} 値上げ額（月あたり）`,
      `${ym}${daysOf(i)} 値上げ率`,
    ]),
  ];
  const line = (r) => {
    // 現状額は当月の金額（合計）。A基準（計画）は値上げ前当初と比べる
    const b = n(r.base_amt);
    const g = n(r.gain_plus_1) + n(r.gain_minus_1);
    const pre = b - g;
    // 値上げ率。計画の月は日量換算した比較のもと（p）で見る
    const rate = (amt, p = pre) => (p > 0 ? round(((amt - p) / p) * 100, 1) / 100 : '');
    return [
      r.name || '—', n(r.deals), round(n(r.qty) / months, 1),
      round(b / months),
      round(n(r.mp_amt) / months),
      ...abActYms.flatMap((_, i) => {
        // その月の実績が無ければ空欄（列数は揃える）
        if (r[`act_amt_${i + 1}`] == null) return ['', '', '', '', '', '', '', '', ''];
        // 実績は「値上げ前当初 → 当月の金額（合計）」。差が売上改善額。
        // その中身を、上がった品目ぶん（プラス）と下がった品目ぶん（マイナス）に分ける
        return [
          round(b / months), round(pre / months), round(g / months),
          pre > 0 ? round((g / pre) * 100, 1) / 100 : '',
          round(n(r[`gain_plus_${i + 1}`]) / months), n(r[`act_up_${i + 1}`]),
          round(n(r[`gain_minus_${i + 1}`]) / months), n(r[`act_down_${i + 1}`]),
          n(r[`act_same_${i + 1}`]),
        ];
      }),
      // 計画は稼働日で日量換算した金額。比較のもと（値上げ前当初）も同じ倍率に揃える
      ...[[0, n(r.a0_amt)], [1, n(r.a1_amt)],
        [2, n(r.a2_amt)], [3, n(r.a3_amt)]].flatMap(([i, amt]) => {
        const p = pre * rateOf(i);
        return [round(amt / months), round((amt - p) / months), rate(amt, p)];
      }),
    ];
  };
  const widths = [22, 8, 12, 18, 20,
    ...abActYms.flatMap(() => [18, 20, 18, 10, 20, 12, 20, 12, 12]),
    18, 18, 10, 18, 18, 10, 18, 18, 10, 18, 18, 10];
  for (const [sheet, label, rows] of [
    ['器具区分別', '器具区分', data.abByEquip ?? []],
    ['支店別', '支店', data.abByBranch ?? []],
    ['法人別', '法人', data.abByCorp ?? []],
  ]) {
    addSheet(sheet,
      [head(label), ...rows.map((r) => line(r)), line({ ...t, name: '合計' })],
      widths);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/**
 * 一覧のExcelに出す表を「見出し」と「行の配列」で返す。
 *
 * サーバーでファイルまで作る通常の出力（buildWorkbook）と、
 * 件数が多いときにブラウザ側でファイルを作る分割出力（/deals/export-rows）の
 * 両方がこれを使う。列の定義を1か所にしておくことで、どちらの出し方でも
 * 同じ列・同じ値になる。
 */
export function buildExportTable(rows, opts = {}) {
  const months = Number(opts.months) > 0 ? Number(opts.months) : 12;
  const columns = buildColumns({
    months,
    masterMonths: Number(opts.masterMonths) > 0 ? Number(opts.masterMonths) : 3,
    withCost: Boolean(opts.withCost),
    aggMeta: opts.aggMeta,
    actualMeta: opts.actualMeta,
    base: opts.base,
  });
  return {
    header: columns.map(([label]) => label),
    widths: columns.map(([label]) => Math.max(10, Math.min(24, label.length * 2))),
    rows: rows.map((r) => columns.map(([, get]) => {
      const v = get(r);
      return v === null || v === undefined ? '' : v;
    })),
  };
}

export function buildWorkbook(rows, priceTypes = [], opts = {}) {
  const { header, widths, rows: body } = buildExportTable(rows, opts);

  // dense（行の配列のまま持つ形）にすると、数万行でも組み立てが速く、使う記憶領域も少ない
  const ws = XLSX.utils.aoa_to_sheet([header, ...body], { dense: true });
  ws['!cols'] = widths.map((wch) => ({ wch }));
  // 見出しと、法人名までの左側を固定して横スクロールしても行が分かるようにする
  ws['!freeze'] = { xSplit: 3, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '値上げ管理表');
  // compression を有効にしないとxlsxが無圧縮で書き出され、
  // 2万行規模でファイルが数十MBに膨らむ（サーバーレスの応答上限を超える）
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

import XLSX from 'xlsx';

/**
 * 案件一覧の内容をそのままExcelにする。
 *
 * 列は画面と同じ並び（基本情報 → 実績（価格調査） → A基準 → B基準 → 値上げ幅 → 交渉）。
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
 * 実績原価は管理者・開発者のときだけ足す（社外秘に準ずる扱い）。
 */
function buildColumns({ months, withCost, aggMeta, actualMeta }) {
  const m = (k, fallback) => ymLabel(aggMeta?.[k], fallback);
  const m0 = m('m0', '当月');
  const m1 = m('m1', '翌月');
  const m2 = m('m2', '翌々月');
  const m3 = m('m3', '3か月後');

  // 現状は価格調査の当月実績（単価・数量）。過去最新単価と比べると実際の値上がりが分かる
  const effPrice = (r) => (r.master_avg_price ?? null);
  /** マスタ単価（値決めの単価）。A基準はこれと比べる。無い行は実単価で代用 */
  const mPrice = (r) => (r.master_price ?? r.master_avg_price ?? null);
  const monthlyQty = (r) => (r.master_qty == null ? null : Number(r.master_qty));
  /** マスタ分の数量（値決めどおりに出た分）。A基準の値上げ額はこれに対して出す */
  const planQty = (r) => {
    const v = r.plan_qty ?? r.master_qty;
    return v == null ? null : Number(v);
  };
  const actYm = String(actualMeta?.ym ?? '');
  const actLabel = actYm ? `${Number(actYm.slice(5, 7))}月` : '当月';

  /** 値上げ幅 = その月のA基準 − 当月のマスタ単価。単価0は未申請なので空にする */
  const diff = (key) => (r) => {
    const a = Number(r[key]);
    if (!(a > 0) || mPrice(r) == null) return '';
    return round(a - Number(mPrice(r)));
  };

  const cols = [
    ['案件ID', (r) => r.id],
    ['法人コード', (r) => r.corp_code],
    ['法人名', (r) => r.corp_name],
    ['得意先名', (r) => r.customer_name],
    ['納入先名', (r) => r.delivery_name],
    ['商品コード', (r) => r.model_code],
    ['商品名', (r) => r.product_name],
    ['規格', (r) => r.gas_type],
    ['器種名（品目階層名）', (r) => r.model_name],
    ['器具区分', (r) => r.equip_name],
    ['支店', (r) => r.branch],
    ['営業所', (r) => r.office],
    ['担当者', (r) => r.sales_person],

    // 実績（価格調査）。値上げ前 → 当月のマスタ単価 → 実際に出た単価
    ['過去最新単価', (r) => round(r.past_price)],
    ['過去最新受注日', (r) => r.past_date],
    [`マスタ単価（${actLabel}）`, (r) => round(r.master_price)],
    ['上がり幅（マスタ単価−過去）', (r) => {
      if (mPrice(r) == null || r.past_price == null) return '';
      return round(Number(mPrice(r)) - Number(r.past_price));
    }],
    [`実単価（${actLabel}）`, (r) => round(effPrice(r))],
    [`数量 合計（${actLabel}）`, (r) => (monthlyQty(r) == null ? '' : round(Number(monthlyQty(r)), 2))],
    [`金額 合計（${actLabel}）`, (r) => round(r.master_amount)],
    [`数量 マスタ（${actLabel}）`, (r) => (planQty(r) == null ? '' : round(Number(planQty(r)), 2))],
    [`金額 マスタ（${actLabel}）`, (r) => round(r.plan_amount)],
    ['実勢差（実単価−マスタ単価）', (r) => {
      if (effPrice(r) == null || r.master_price == null) return '';
      return round(Number(effPrice(r)) - Number(r.master_price));
    }],

    // A基準（マスタ登録の申請単価）と、その承認日・稟議No
    [`A基準 ${m0}`, (r) => round(r.a_price_m0)],
    [`承認日 ${m0}`, (r) => r.a_date_m0],
    [`稟議No ${m0}`, (r) => r.a_ringi_m0],
    [`A基準 ${m1}`, (r) => round(r.a_price_m1)],
    [`承認日 ${m1}`, (r) => r.a_date_m1],
    [`稟議No ${m1}`, (r) => r.a_ringi_m1],
    [`A基準 ${m2}`, (r) => round(r.a_price_m2)],
    [`承認日 ${m2}`, (r) => r.a_date_m2],
    [`稟議No ${m2}`, (r) => r.a_ringi_m2],
    [`A基準 ${m3}`, (r) => round(r.a_price_m3)],
    [`承認日 ${m3}`, (r) => r.a_date_m3],
    [`稟議No ${m3}`, (r) => r.a_ringi_m3],

    // B基準（実際の決定単価。アプリで入力する）
    ['決定単価（B基準）', (r) => round(r.b_price)],

    // 値上げ幅（A基準 − 実績）と、月あたりの値上げ額
    [`値上げ幅 ${m0}`, diff('a_price_m0')],
    [`値上げ幅 ${m1}`, diff('a_price_m1')],
    [`値上げ幅 ${m2}`, diff('a_price_m2')],
    [`値上げ幅 ${m3}`, diff('a_price_m3')],
    [`値上げ額（月あたり）${m3}`, (r) => {
      const a = Number(r.a_price_m3);
      if (!(a > 0) || mPrice(r) == null || planQty(r) == null) return '';
      return round((a - Number(mPrice(r))) * Number(planQty(r)));
    }],

    // 交渉
    ['適用年月', (r) => r.r2_applied_ym],
    ['状態', (r) => STATE_LABELS[r.r2_state] ?? ''],
    ['交渉状況（法人）', (r) => CORP_STATUS_LABELS[r.corp_status] ?? ''],
  ];

  if (withCost) cols.push(['実績原価（管理者のみ）', (r) => round(r.cost_price)]);
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
 * 形式に合わせた）。想定B基準は法人別のシートにだけ出す。
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
  cond.push(['マスタ登録（A基準あり）の件数', n(data.aMonths?.covered)]);
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
    // 計画。比較のもとは値上げ前当初（当初からA基準までの上がり幅が値上げ額）
    ...[[m0, n(t.a0_amt)], [m1, n(t.a1_amt)], [m2, n(t.a2_amt)], [m3, n(t.a3_amt)]].map(([ym, amt]) => ({
      ym, kind: '計画', deals: n(t.deals), b: gain == null ? base : base - gain,
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

  // ── 器具区分別・支店別・法人別（画面と同じ数字）
  // 月ごとに「A基準額 / 値上げ額 / 値上げ率」を出す。
  // 想定B基準は法人ごとに決める値のため、法人別のシートにだけ添える。
  // 実績（価格調査の実単価）は月ごとに出す。その月に実単価のあった品目だけの
  // 集計なので、比べる現状額もその品目ぶん（実績の現状額）を並べて入れる
  const abActYms = Array.isArray(data.abActYms) ? data.abActYms : [];
  const head = (first, withBsim) => [
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
    `${m0} A基準額（月あたり）`, `${m0} 値上げ額（月あたり）`, `${m0} 値上げ率`,
    `${m1} A基準額（月あたり）`, `${m1} 値上げ額（月あたり）`, `${m1} 値上げ率`,
    `${m2} A基準額（月あたり）`, `${m2} 値上げ額（月あたり）`, `${m2} 値上げ率`,
    `${m3} A基準額（月あたり）`, `${m3} 値上げ額（月あたり）`, `${m3} 値上げ率`,
    ...(withBsim ? ['想定B基準（月あたり）'] : []),
  ];
  const line = (r, withBsim) => {
    // 現状額は当月の金額（合計）。A基準（計画）は値上げ前当初と比べる
    const b = n(r.base_amt);
    const g = n(r.gain_plus_1) + n(r.gain_minus_1);
    const pre = b - g;
    const rate = (amt) => (pre > 0 ? round(((amt - pre) / pre) * 100, 1) / 100 : '');
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
      round(n(r.a0_amt) / months), round((n(r.a0_amt) - pre) / months), rate(n(r.a0_amt)),
      round(n(r.a1_amt) / months), round((n(r.a1_amt) - pre) / months), rate(n(r.a1_amt)),
      round(n(r.a2_amt) / months), round((n(r.a2_amt) - pre) / months), rate(n(r.a2_amt)),
      round(n(r.a3_amt) / months), round((n(r.a3_amt) - pre) / months), rate(n(r.a3_amt)),
      ...(withBsim ? [round(n(r.bsim_amt) / months)] : []),
    ];
  };
  const widths = [22, 8, 12, 18, 20,
    ...abActYms.flatMap(() => [18, 20, 18, 10, 20, 12, 20, 12, 12]),
    18, 18, 10, 18, 18, 10, 18, 18, 10, 18, 18, 10];
  for (const [sheet, label, rows, withBsim] of [
    ['器具区分別', '器具区分', data.abByEquip ?? [], false],
    ['支店別', '支店', data.abByBranch ?? [], false],
    ['法人別', '法人', data.abByCorp ?? [], true],
  ]) {
    addSheet(sheet,
      [head(label, withBsim),
        ...rows.map((r) => line(r, withBsim)),
        line({ ...t, name: '合計' }, withBsim)],
      withBsim ? [...widths, 18] : widths);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

export function buildWorkbook(rows, priceTypes = [], opts = {}) {
  const months = Number(opts.months) > 0 ? Number(opts.months) : 12;
  const columns = buildColumns({
    months,
    masterMonths: Number(opts.masterMonths) > 0 ? Number(opts.masterMonths) : 3,
    withCost: Boolean(opts.withCost),
    aggMeta: opts.aggMeta,
    actualMeta: opts.actualMeta,
  });

  const header = columns.map(([label]) => label);
  const body = rows.map((r) => columns.map(([, get]) => {
    const v = get(r);
    return v === null || v === undefined ? '' : v;
  }));

  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws['!cols'] = columns.map(([label]) => ({ wch: Math.max(10, Math.min(24, label.length * 2)) }));
  // 見出しと、法人名までの左側を固定して横スクロールしても行が分かるようにする
  ws['!freeze'] = { xSplit: 3, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '値上げ管理表');
  // compression を有効にしないとxlsxが無圧縮で書き出され、
  // 2万行規模でファイルが数十MBに膨らむ（サーバーレスの応答上限を超える）
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

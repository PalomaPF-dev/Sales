import XLSX from 'xlsx';

/**
 * 案件一覧の内容をそのままExcelにする。
 *
 * 列は画面と同じ並び（基本情報 → 出荷実績 → A基準 → B基準 → 値上げ幅 → 交渉）。
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
function buildColumns({ months, masterMonths = 3, withCost, aggMeta, actualMeta }) {
  const m = (k, fallback) => ymLabel(aggMeta?.[k], fallback);
  const m0 = m('m0', '当月');
  const m1 = m('m1', '翌月');
  const m2 = m('m2', '翌々月');
  const m3 = m('m3', '3か月後');

  // 実績はマスタ登録の単価を優先し、無い品目は出荷実績（1~3月）で補う（案件一覧と同じ基準）。
  // 数量は期間の合計のため、それぞれの月数で割って月平均にする
  const effPrice = (r) => (r.master_avg_price ?? r.hist_avg_price ?? null);
  const monthlyQty = (r) => {
    if (r.master_avg_price != null) {
      return r.master_qty == null ? null : Number(r.master_qty) / masterMonths;
    }
    return r.hist_qty == null ? null : Number(r.hist_qty) / months;
  };
  const basePeriod = String(aggMeta?.basePeriod ?? '').trim() || '1~3月';
  // 価格調査の実単価。取り込んだ月の分だけ列にする
  const actMonths = Array.isArray(actualMeta?.months) ? actualMeta.months : [];

  /** 値上げ幅 = その月のA基準 − 実績単価。単価0は未申請なので空にする */
  const diff = (key) => (r) => {
    const a = Number(r[key]);
    if (!(a > 0) || effPrice(r) == null) return '';
    return round(a - Number(effPrice(r)));
  };

  const cols = [
    ['案件ID', (r) => r.id],
    ['法人コード', (r) => r.corp_code],
    ['法人名', (r) => r.corp_name],
    ['得意先名', (r) => r.customer_name],
    ['納入先名', (r) => r.delivery_name],
    ['器種コード', (r) => r.model_code],
    ['器種名', (r) => r.model_name],
    ['器具区分', (r) => r.equip_name],
    ['ガス種', (r) => r.gas_type],
    ['支店', (r) => r.branch],
    ['営業所', (r) => r.office],
    ['担当者', (r) => r.sales_person],

    // 出荷実績（マスタ登録の1~3月実績を優先。無い品目は出荷実績取込の値）
    [`平均出荷単価（${basePeriod}）`, (r) => round(effPrice(r))],
    ['数量（月平均）', (r) => (monthlyQty(r) == null ? '' : round(Number(monthlyQty(r)), 2))],

    // 価格調査の実単価（月ごと）。計画（A基準）と実際の単価を並べて見るための列
    ...actMonths.map((ym, i) => [`実単価 ${ym}`, (r) => round(r[`act_price_${i + 1}`])]),

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
    [`値上げ幅 ${m1}`, diff('a_price_m1')],
    [`値上げ幅 ${m2}`, diff('a_price_m2')],
    [`値上げ幅 ${m3}`, diff('a_price_m3')],
    [`値上げ額（月あたり）${m3}`, (r) => {
      const a = Number(r.a_price_m3);
      if (!(a > 0) || effPrice(r) == null || monthlyQty(r) == null) return '';
      return round((a - Number(effPrice(r))) * Number(monthlyQty(r)));
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
 * 「まとめ」「器具区分別」「支店別」「法人別（上位30社）」をシートに分ける。
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
  cond.push(['出荷実績の品目件数', n(data.histTotals?.deals)]);
  cond.push(['マスタ登録（A基準あり）の件数', n(data.aMonths?.covered)]);
  addSheet('条件', cond, [28, 40]);

  // ── まとめ（実績と計画を月の流れで並べる）
  const base = n(t.base_amt);
  const summary = [[
    '月', '区分', '件数', '現状額（月あたり）', '金額（月あたり）', '値上げ額（月あたり）', '値上げ率',
  ]];
  const summaryRows = [
    // 価格調査の実単価（実績）。現状額もその月に実単価のある案件だけで出す
    ...(data.actuals ?? []).map((a) => ({
      ym: a.ym, kind: '実績', deals: n(a.deals), b: n(a.base), amt: n(a.amount),
    })),
    // A基準（計画）
    ...[[m0, n(t.a0_amt)], [m1, n(t.a1_amt)], [m2, n(t.a2_amt)], [m3, n(t.a3_amt)]].map(([ym, amt]) => ({
      ym, kind: '計画', deals: n(t.deals), b: base, amt,
    })),
  ].sort((a, b2) => (a.ym === b2.ym ? (a.kind === '実績' ? -1 : 1) : String(a.ym).localeCompare(String(b2.ym))));
  for (const r of summaryRows) {
    const gain = r.amt - r.b;
    summary.push([
      r.ym, r.kind, r.deals, round(r.b / months), round(r.amt / months), round(gain / months),
      r.b > 0 ? round((gain / r.b) * 100, 1) / 100 : '',
    ]);
  }
  addSheet('まとめ', summary, [12, 8, 10, 18, 18, 18, 10]);

  // ── 器具区分別・支店別・法人別（画面と同じ数字）
  // 月ごとに「A基準額 / 値上げ額 / 値上げ率」を出す。
  // 想定B基準は法人ごとに決める値のため、法人別のシートにだけ添える。
  const head = (first, withBsim) => [
    first, '件数', '数量（月平均）',
    '現状額（月あたり）',
    `${m0} A基準額（月あたり）`, `${m0} 値上げ額（月あたり）`, `${m0} 値上げ率`,
    `${m1} A基準額（月あたり）`, `${m1} 値上げ額（月あたり）`, `${m1} 値上げ率`,
    `${m2} A基準額（月あたり）`, `${m2} 値上げ額（月あたり）`, `${m2} 値上げ率`,
    `${m3} A基準額（月あたり）`, `${m3} 値上げ額（月あたり）`, `${m3} 値上げ率`,
    ...(withBsim ? ['想定B基準（月あたり）'] : []),
  ];
  const line = (r, withBsim) => {
    const b = n(r.base_amt);
    const rate = (amt) => (b > 0 ? round(((amt - b) / b) * 100, 1) / 100 : '');
    return [
      r.name || '—', n(r.deals), round(n(r.qty) / months, 1),
      round(b / months),
      round(n(r.a0_amt) / months), round((n(r.a0_amt) - b) / months), rate(n(r.a0_amt)),
      round(n(r.a1_amt) / months), round((n(r.a1_amt) - b) / months), rate(n(r.a1_amt)),
      round(n(r.a2_amt) / months), round((n(r.a2_amt) - b) / months), rate(n(r.a2_amt)),
      round(n(r.a3_amt) / months), round((n(r.a3_amt) - b) / months), rate(n(r.a3_amt)),
      ...(withBsim ? [round(n(r.bsim_amt) / months)] : []),
    ];
  };
  const widths = [22, 8, 12, 18, 18, 18, 10, 18, 18, 10, 18, 18, 10, 18, 18, 10];
  for (const [sheet, label, rows, withBsim] of [
    ['器具区分別', '器具区分', data.abByEquip ?? [], false],
    ['支店別', '支店', data.abByBranch ?? [], false],
    ['法人別（上位30社）', '法人', data.abByCorp ?? [], true],
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

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
function buildColumns({ months, withCost, aggMeta }) {
  const m = (k, fallback) => ymLabel(aggMeta?.[k], fallback);
  const m0 = m('m0', '当月');
  const m1 = m('m1', '翌月');
  const m2 = m('m2', '翌々月');
  const m3 = m('m3', '3か月後');

  /** 値上げ幅 = その月のA基準 − 実績の平均出荷単価。単価0は未申請なので空にする */
  const diff = (key) => (r) => {
    const a = Number(r[key]);
    if (!(a > 0) || r.hist_avg_price == null) return '';
    return round(a - Number(r.hist_avg_price));
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

    // 出荷実績（案件の土台）
    ['平均出荷単価', (r) => round(r.hist_avg_price)],
    ['数量合計', (r) => round(r.hist_qty)],
    ['数量（月平均）', (r) => (r.hist_qty == null ? '' : round(Number(r.hist_qty) / months, 2))],

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
      if (!(a > 0) || r.hist_avg_price == null || r.hist_qty == null) return '';
      return round((a - Number(r.hist_avg_price)) * (Number(r.hist_qty) / months));
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
 * 画面は月あたりと期間合計を1つのマスに重ねているが、Excelでは
 * そのまま計算に使えるよう、列を分けて数値で入れる。
 */
export function buildDashboardWorkbook(data, opts = {}) {
  const months = Number(data.months) > 0 ? Number(data.months) : 12;
  const n = (v) => Number(v ?? 0);
  const m = (k, fallback) => ymLabel(data.aggMeta?.[k], fallback);
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

  // ── 条件（どの絞り込みで出したかを残す）
  const cond = [['項目', '内容']];
  for (const [label, value] of opts.filters ?? []) cond.push([label, value]);
  if ((opts.filters ?? []).length === 0) cond.push(['絞り込み', 'なし（全件）']);
  cond.push([]);
  cond.push(['表示範囲', data.scope?.label ?? '']);
  cond.push(['出荷実績の件数', n(data.histTotals?.deals)]);
  cond.push(['出荷実績の数量合計', round(data.histTotals?.qty)]);
  cond.push(['マスタ登録（A基準あり）の件数', n(data.aMonths?.covered)]);
  cond.push(['対象の月数', months]);
  addSheet('条件', cond, [28, 40]);

  // ── まとめ（月ごとに現状額・A基準額・値上げ額）
  const base = n(t.base_amt);
  const summary = [[
    '月', '現状額（月あたり）', '現状額（期間合計）',
    'A基準額（月あたり）', 'A基準額（期間合計）',
    '値上げ額（月あたり）', '値上げ額（期間合計）', '値上げ率',
  ]];
  for (const [label, amt] of [[m1, n(t.a1_amt)], [m2, n(t.a2_amt)], [m3, n(t.a3_amt)]]) {
    const gain = amt - base;
    summary.push([
      label, round(base / months), round(base),
      round(amt / months), round(amt),
      round(gain / months), round(gain),
      base > 0 ? round((gain / base) * 100, 1) / 100 : '',
    ]);
  }
  addSheet('まとめ', summary, [12, 18, 18, 18, 18, 18, 18, 10]);

  // ── 器具区分別・支店別・法人別（画面と同じ列）
  const head = (first) => [
    first, '件数', '数量合計', '数量（月平均）',
    '現状額（月あたり）', '現状額（期間合計）',
    `${m1} A基準額（月あたり）`, `${m1} 値上げ額（月あたり）`,
    `${m2} A基準額（月あたり）`, `${m2} 値上げ額（月あたり）`,
    `${m3} A基準額（月あたり）`, `${m3} 値上げ額（月あたり）`,
    `${m3} A基準額（期間合計）`, `${m3} 値上げ額（期間合計）`,
    '値上げ率',
    '想定B基準（月あたり）', '想定B基準の値上げ額（月あたり）', 'A基準との差（月あたり）',
  ];
  const line = (r) => {
    const b = n(r.base_amt);
    const g3 = n(r.a3_amt) - b;
    return [
      r.name || '—', n(r.deals), round(r.qty), round(n(r.qty) / months, 1),
      round(b / months), round(b),
      round(n(r.a1_amt) / months), round((n(r.a1_amt) - b) / months),
      round(n(r.a2_amt) / months), round((n(r.a2_amt) - b) / months),
      round(n(r.a3_amt) / months), round(g3 / months),
      round(n(r.a3_amt)), round(g3),
      b > 0 ? round((g3 / b) * 100, 1) / 100 : '',
      round(n(r.bsim_amt) / months), round((n(r.bsim_amt) - b) / months),
      round((n(r.bsim_amt) - n(r.a3_amt)) / months),
    ];
  };
  const widths = [22, 8, 12, 12, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 10, 18, 20, 18];
  for (const [sheet, label, rows] of [
    ['器具区分別', '器具区分', data.abByEquip ?? []],
    ['支店別', '支店', data.abByBranch ?? []],
    ['法人別', '法人', data.abByCorp ?? []],
  ]) {
    addSheet(sheet, [head(label), ...rows.map(line), line({ ...t, name: '合計' })], widths);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

export function buildWorkbook(rows, priceTypes = [], opts = {}) {
  const months = Number(opts.months) > 0 ? Number(opts.months) : 12;
  const columns = buildColumns({ months, withCost: Boolean(opts.withCost), aggMeta: opts.aggMeta });

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

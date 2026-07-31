import XLSX from 'xlsx';

/**
 * 現行管理表と同じ列構成（A列〜CI列）でExcelを組み立てる。
 * 取込側（importer.js）のHEADER_MAPと対になっているため、
 * 書き出したファイルをそのまま取り込み直せる。
 */
const COLUMNS = [
  ['売上年月', 'sales_ym'],
  ['法人コード', 'corp_code'],
  ['法人名', 'corp_name'],
  ['得意先コード', 'customer_code'],
  ['得意先名', 'customer_name'],
  ['納入先コード', 'delivery_code'],
  ['納入先名', 'delivery_name'],
  ['扱い先コード', 'handler_code'],
  ['扱い先名', 'handler_name'],
  ['業種名', 'industry'],
  ['器具区分', 'equip_code'],
  ['器具区分名', 'equip_name'],
  ['カテゴリーコード', 'category_code'],
  ['カテゴリー名', 'category_name'],
  ['器種コード', 'model_code'],
  ['ガスコード', 'gas_code'],
  ['器種名', 'model_name'],
  ['ガス種', 'gas_type'],
  ['出荷数', 'qty'],
  ['定価', 'list_price'],
  ['掛け率', 'rate'],
  ['出荷単価', 'base_price'],              // ❶
  ['新値上げ後掛け率', 'r1_target_rate'],
  ['新出荷単価', 'r1_target_price'],       // ❷
  ['出荷金額', 'ship_amount'],
  ['最終単価', 'final_price'],
  ['売上伝票ＮＯ', 'voucher_no'],
  ['見積伝票番号', 'quote_no'],
  ['受注日', 'order_date'],
  ['売上日', 'sales_date'],
  ['売上担当者支店名', 'branch'],
  ['売上担当者営業所名', 'office'],
  ['売上担当者名', 'sales_person'],
  ['得意先担当者名', 'customer_person'],
  ['確定商談日', 'negotiated_date'],
  ['商談結果', 'negotiation_note'],
  ['値上後単価', 'r1_agreed_price'],       // ❸
  ['値上がり単価', 'r1_raise_unit'],       // ❹
  ['値上がり金額', 'r1_raise_amount'],     // ❺
  ['値上日時', 'r1_raise_date'],
  ['稟議NO', 'r1_ringi_no'],
  ['新定価', 'new_list_price'],
  ['第１弾値上げ後掛率', 'r1_after_rate'],
  ['第２弾新値上げ単価', 'r2_target_price'], // ❻
  ['１回目提示日', 'offer1_date'],
  ['1回目提示率', 'offer1_rate'],
  ['1回目提示単価', 'offer1_price'],
  ['商談結果（記号入力）', 'r2_result_symbol'],
  ['最終確定日', 'final_confirm_date'],
  ['最終確定値上日', 'final_raise_date'],
  ['第2弾稟議NO', 'r2_ringi_no'],
  ['最終確定掛率', 'final_rate'],
  ['最終確定単価', 'r2_agreed_price'],     // ❼
  ['最終確定値上額', 'r2_raise_unit'],     // ❽
  ['最終確定値上金額', 'r2_raise_amount'], // ❾
  ['ステータス', 'status'],
  ['単価種別', 'price_type_label'],
];

const STATUS_LABELS = {
  not_started: '未着手',
  negotiating: '交渉中',
  r1_agreed: '第1弾妥結',
  r2_negotiating: '第2弾交渉中',
  r2_agreed: '第2弾妥結',
  declined: '値上げ不可',
};

export function buildWorkbook(rows, priceTypes = []) {
  const ptName = new Map(priceTypes.map((p) => [p.code, `${p.code}. ${p.name}`]));

  const header = COLUMNS.map(([label]) => label);
  const body = rows.map((r) =>
    COLUMNS.map(([, key]) => {
      if (key === 'status') return STATUS_LABELS[r.status] || r.status;
      if (key === 'price_type_label') return ptName.get(r.price_type_code) ?? '';
      const v = r[key];
      return v === null || v === undefined ? '' : v;
    })
  );

  // 合計行（❺ + ❾ = 値上げ金額総数）を末尾に置く
  const totalR1 = rows.reduce((s, r) => s + (Number(r.r1_raise_amount) || 0), 0);
  const totalR2 = rows.reduce((s, r) => s + (Number(r.r2_raise_amount) || 0), 0);
  const totalRow = COLUMNS.map(([, key]) => {
    if (key === 'sales_ym') return '合計';
    if (key === 'r1_raise_amount') return totalR1;
    if (key === 'r2_raise_amount') return totalR2;
    return '';
  });

  const ws = XLSX.utils.aoa_to_sheet([header, ...body, [], totalRow]);
  ws['!cols'] = COLUMNS.map(([label]) => ({ wch: Math.max(10, Math.min(24, label.length * 2)) }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '値上げ管理表');
  // compression を有効にしないとxlsxが無圧縮で書き出され、
  // 2万行規模でファイルが数十MBに膨らむ（サーバーレスの応答上限を超える）
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

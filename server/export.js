import XLSX from 'xlsx';

/**
 * 管理表と同じ列名でExcelを組み立てる。
 * 取込側（server/fields.js）の項目名と対になっているため、
 * 書き出したファイルをそのまま取り込み直せる。
 * 単価だけの管理表のため、台数と金額の列は持たない。
 */
const COLUMNS = [
  // 書き出したファイルに合意単価などを書き込んで戻せるよう、行を特定できるIDを持たせる。
  // これが無いと、同じ得意先・同じ器種の行が複数あるときにどの行か決められない。
  ['案件ID', 'id'],
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
  ['定価', 'list_price'],
  ['掛け率', 'rate'],
  ['出荷単価', 'base_price'],              // ❶
  ['新値上げ後掛け率', 'r1_target_rate'],
  ['新出荷単価', 'r1_target_price'],       // ❷
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
  ['第1弾適用年月', 'r1_applied_ym'],
  ['第1弾完了', 'r1_done_label'],
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
  ['第2弾適用年月', 'r2_applied_ym'],
  ['第2弾完了', 'r2_done_label'],
  ['交渉状況（法人）', 'corp_status_label'],
  ['単価種別', 'price_type_label'],
];

const CORP_STATUS_LABELS = {
  not_started: '未着手',
  negotiating: '交渉中',
  agreed: '合意',
  declined: '値上げ不可',
};

export function buildWorkbook(rows, priceTypes = []) {
  const ptName = new Map(priceTypes.map((p) => [p.code, `${p.code}. ${p.name}`]));

  const header = COLUMNS.map(([label]) => label);
  const body = rows.map((r) =>
    COLUMNS.map(([, key]) => {
      if (key === 'r1_done_label') return Number(r.r1_done) ? '〇' : '';
      if (key === 'r2_done_label') return Number(r.r2_done) ? '〇' : '';
      if (key === 'corp_status_label') return CORP_STATUS_LABELS[r.corp_status] ?? '';
      if (key === 'price_type_label') return ptName.get(r.price_type_code) ?? '';
      const v = r[key];
      return v === null || v === undefined ? '' : v;
    })
  );

  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws['!cols'] = COLUMNS.map(([label]) => ({ wch: Math.max(10, Math.min(24, label.length * 2)) }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '値上げ管理表');
  // compression を有効にしないとxlsxが無圧縮で書き出され、
  // 2万行規模でファイルが数十MBに膨らむ（サーバーレスの応答上限を超える）
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

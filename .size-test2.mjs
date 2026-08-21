import { buildWorkbook } from './server/export.js';
const aggMeta = { m0: '2026-08', m1: '2026-09', m2: '2026-10', m3: '2026-11' };
const actualMeta = { ym: '2026-07' };
// 本番の実データに合わせた長さ・種類数（法人6425 得意先6195 納入先16909 品名1713 商品3079 担当314、商談メモは空）
const mk = (i) => ({
  id: i, corp_code: `C${100000 + (i % 6425)}`, corp_name: `サンプルガス${i % 6425}`,
  customer_name: `サンプル販売${i % 6195}店`, delivery_name: `納入${i % 16909}`,
  model_code: `M${i % 3079}`, product_name: `GT-${i % 1713}`, gas_type: i % 2 ? '13A' : 'LP',
  model_name: `ふろ給湯器${i % 747}`, equip_name: ['給湯器', 'コンロ', 'レンジフード', '湯沸器'][i % 4],
  branch: `${['東京', '名古屋', '大阪', '福岡'][i % 4]}支店`, office: `${i % 60}営業所`,
  sales_person: `山田太郎${i % 314}`,
  past_price: 20000 + (i % 5000), past_date: '2025-06-01',
  master_avg_price: 21000 + (i % 5000), master_price: 21500 + (i % 5000),
  master_qty: (i % 20) + 1, master_amount: (21000 + (i % 5000)) * ((i % 20) + 1),
  plan_qty: (i % 18) + 1,
  a_price_m0: 22000 + (i % 5000), a_date_m0: '2026-08-05', a_ringi_m0: `R${i % 4000}`,
  a_price_m1: 22500 + (i % 5000), a_date_m1: '2026-08-05', a_ringi_m1: `R${i % 4000}`,
  a_price_m2: 22800 + (i % 5000), a_date_m2: '2026-08-05', a_ringi_m2: `R${i % 4000}`,
  a_price_m3: 23000 + (i % 5000), a_date_m3: '2026-08-05', a_ringi_m3: `R${i % 4000}`,
  r2_target_price: null, nego_result: null, nego_note: null,
  final_date: null, final_price: null, r2_applied_ym: null,
  r2_state: 'open', corp_status: null, cost_price: 15000 + (i % 3000),
});
for (const n of [6000, 20000, 60000, 100000, 183193]) {
  const rows = Array.from({ length: n }, (_, i) => mk(i));
  const t = Date.now();
  const buf = buildWorkbook(rows, [], { months: 12, masterMonths: 3, withCost: true, aggMeta, actualMeta });
  console.log(`${String(n).padStart(7)}行  ${(buf.length / 1024 / 1024).toFixed(2)} MB  ${((Date.now() - t) / 1000).toFixed(1)}秒`);
}

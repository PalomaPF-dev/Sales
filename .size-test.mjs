import { buildWorkbook } from './server/export.js';

const aggMeta = { m0: '2026-08', m1: '2026-09', m2: '2026-10', m3: '2026-11' };
const actualMeta = { ym: '2026-07' };
// 本番に近い長さの文字を入れた行を作る
const mk = (i) => ({
  id: i, corp_code: `C${100000 + i}`, corp_name: `株式会社サンプルガスエナジー${i % 900}`,
  customer_name: `サンプル${i % 700}販売株式会社 ${i % 30}営業部`,
  delivery_name: `納入先マンション${i % 5000}号棟`,
  model_code: `MDL-${i % 9000}-AB`, product_name: `ふろ給湯器 GT-C${2060 + (i % 40)}SAWX BL`,
  gas_type: i % 2 ? '都市ガス13A' : 'LPガス', model_name: `ふろ給湯器 GT-C${2060 + (i % 40)}`,
  equip_name: ['給湯器', 'コンロ', 'レンジフード', '湯沸器'][i % 4],
  branch: `${['東京', '名古屋', '大阪', '福岡'][i % 4]}支店`, office: `${i % 60}営業所`,
  sales_person: `山田 太郎${i % 300}`,
  past_price: 20000 + (i % 5000), past_date: '2025-06-01',
  master_avg_price: 21000 + (i % 5000), master_price: 21500 + (i % 5000),
  master_qty: (i % 20) + 1, master_amount: (21000 + (i % 5000)) * ((i % 20) + 1),
  plan_qty: (i % 18) + 1,
  a_price_m0: 22000 + (i % 5000), a_date_m0: '2026-08-05', a_ringi_m0: `R-${i}`,
  a_price_m1: 22500 + (i % 5000), a_date_m1: '2026-08-05', a_ringi_m1: `R-${i}`,
  a_price_m2: 22800 + (i % 5000), a_date_m2: '2026-08-05', a_ringi_m2: `R-${i}`,
  a_price_m3: 23000 + (i % 5000), a_date_m3: '2026-08-05', a_ringi_m3: `R-${i}`,
  r2_target_price: 23500 + (i % 5000),
  nego_result: '〇', nego_note: '本部と合意済み。9月から新単価で運用する予定。',
  final_date: '2026-08-10', final_price: 22800 + (i % 5000), r2_applied_ym: '2026-09',
  r2_state: 'done', corp_status: 'agreed', cost_price: 15000 + (i % 3000),
});

for (const n of [6000, 20000, 50000, 100000, 183193]) {
  const rows = Array.from({ length: n }, (_, i) => mk(i));
  const t = Date.now();
  const before = process.memoryUsage().heapUsed;
  const buf = buildWorkbook(rows, [], { months: 12, masterMonths: 3, withCost: true, aggMeta, actualMeta });
  const ms = Date.now() - t;
  const peak = process.memoryUsage().heapUsed;
  console.log(`${String(n).padStart(7)}行  ${(buf.length / 1024 / 1024).toFixed(2)} MB  ${(ms / 1000).toFixed(1)}秒  heap+${((peak - before) / 1024 / 1024).toFixed(0)}MB`);
  global.gc?.();
}

/**
 * 取り込める項目の定義。
 *
 * 管理表は支店・器具ごとに列の並びや見出しの表記が揃っていないため、
 * 「何列目か」ではなく「どの項目か」で対応づける。
 * ここが取込（server/importer.js）と画面の列対応（client の Excel取込）の
 * 共通の土台になる。
 */

// 見出しの表記ゆれを吸収するための正規化。
// 全角英数記号→半角、空白・記号の除去、丸数字や「第１弾」などの揺れを寄せる。
export function normalizeHeader(raw) {
  let s = String(raw ?? '');
  // 全角英数字・記号 → 半角
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/／/g, '/').replace(/％/g, '%').replace(/　/g, '');
  // 括弧・区切り・空白は無視する（「1回目提示日」「1回目 提示日」を同じ扱いにする）
  s = s.replace(/[\s()（）\[\]【】・.,、。_\-ー―－〜~:：]/g, '');
  return s.toUpperCase();
}

/**
 * 項目の一覧。
 *  key     … deals テーブルの列名
 *  label   … 画面に出す名前
 *  group   … 画面でのまとまり
 *  type    … text / number / date
 *  aliases … 見出しの候補（正規化して突き合わせる）
 *  required… これが無いと取り込めない
 */
export const FIELDS = [
  // 基本情報
  { key: 'sales_ym', label: '売上年月', group: '基本', type: 'text', aliases: ['売上年月', '売上年月度', '年月'] },
  { key: 'corp_code', label: '法人コード', group: '基本', type: 'text', aliases: ['法人コード'] },
  { key: 'corp_name', label: '法人名', group: '基本', type: 'text', aliases: ['法人名'] },
  { key: 'customer_code', label: '得意先コード', group: '基本', type: 'text', aliases: ['得意先コード', '取引先コード'] },
  { key: 'customer_name', label: '得意先名', group: '基本', type: 'text', aliases: ['得意先名', '取引先名'] },
  { key: 'delivery_code', label: '納入先コード', group: '基本', type: 'text', aliases: ['納入先コード'] },
  { key: 'delivery_name', label: '納入先名', group: '基本', type: 'text', aliases: ['納入先名'] },
  { key: 'handler_code', label: '扱い先コード', group: '基本', type: 'text', aliases: ['扱い先コード', '取扱先コード'] },
  { key: 'handler_name', label: '扱い先名', group: '基本', type: 'text', aliases: ['扱い先名', '取扱先名'] },
  { key: 'industry', label: '業種名', group: '基本', type: 'text', aliases: ['業種名', '業種'] },

  // 商品
  { key: 'equip_code', label: '器具区分', group: '商品', type: 'text', aliases: ['器具区分', '器具区分コード'] },
  { key: 'equip_name', label: '器具区分名', group: '商品', type: 'text', aliases: ['器具区分名', '器具名'] },
  { key: 'category_code', label: 'カテゴリーコード', group: '商品', type: 'text', aliases: ['カテゴリーコード', 'カテゴリコード'] },
  { key: 'category_name', label: 'カテゴリー名', group: '商品', type: 'text', aliases: ['カテゴリー名', 'カテゴリ名'] },
  { key: 'model_code', label: '器種コード', group: '商品', type: 'text', aliases: ['器種コード', '機種コード', '商品コード'] },
  { key: 'model_name', label: '器種名', group: '商品', type: 'text', aliases: ['器種名', '機種名', '商品名'] },
  { key: 'gas_code', label: 'ガスコード', group: '商品', type: 'text', aliases: ['ガスコード'] },
  { key: 'gas_type', label: 'ガス種', group: '商品', type: 'text', aliases: ['ガス種', 'ガス種別'] },

  // 価格
  { key: 'list_price', label: '定価', group: '価格', type: 'number', aliases: ['定価'] },
  { key: 'rate', label: '掛け率', group: '価格', type: 'number', aliases: ['掛け率', '掛率'] },
  { key: 'base_price', label: '❶ 出荷単価', group: '価格', type: 'number', aliases: ['出荷単価', '現行単価'], required: true },
  // マスタ登録（集約表）で入る項目。取込のズレを開発者が直せるよう FIELDS に載せる
  { key: 'qty', label: '出荷数量', group: '価格', type: 'number', aliases: ['マスタ単価売上数', '出荷数量'] },
  { key: 'a_price_m1', label: 'A基準 翌月単価', group: '価格', type: 'number', aliases: [] },
  { key: 'a_price_m2', label: 'A基準 翌々月単価', group: '価格', type: 'number', aliases: [] },
  { key: 'a_price_m3', label: 'A基準 3か月後単価', group: '価格', type: 'number', aliases: [] },
  { key: 'cost_price', label: '実績原価', group: '価格', type: 'number', aliases: [] },
  { key: 'final_price', label: '最終単価', group: '価格', type: 'number', aliases: ['最終単価'] },
  { key: 'new_list_price', label: '新定価', group: '価格', type: 'number', aliases: ['新定価'] },

  // 値上げ交渉（旧・第2弾。第1弾は廃止した。
  //   列名の r2_ は歴史的経緯で残しているが、いまは唯一の交渉を指す）
  { key: 'r2_target_price', label: '❷ 目標値上げ単価', group: '値上げ交渉', type: 'number', aliases: ['第2弾新値上げ単価', '第2弾目標単価', '第2弾新値上単価', '目標値上げ単価'] },
  { key: 'offer1_date', label: '1回目提示日', group: '値上げ交渉', type: 'date', aliases: ['1回目提示日'] },
  { key: 'offer1_rate', label: '1回目提示率', group: '値上げ交渉', type: 'number', aliases: ['1回目提示率'] },
  { key: 'offer1_price', label: '1回目提示単価', group: '値上げ交渉', type: 'number', aliases: ['1回目提示単価'] },
  { key: 'r2_result_symbol', label: '商談結果（記号入力）', group: '値上げ交渉', type: 'text', aliases: ['商談結果記号入力', '商談結果記号'] },
  { key: 'final_confirm_date', label: '最終確定日', group: '値上げ交渉', type: 'date', aliases: ['最終確定日'] },
  { key: 'final_raise_date', label: '最終確定値上日', group: '値上げ交渉', type: 'date', aliases: ['最終確定値上日'] },
  { key: 'r2_ringi_no', label: '稟議NO', group: '値上げ交渉', type: 'text', aliases: ['第2弾稟議NO', '第2弾稟議番号'] },
  { key: 'final_rate', label: '最終確定掛率', group: '値上げ交渉', type: 'number', aliases: ['最終確定掛率'] },
  { key: 'r2_agreed_price', label: '❸ 合意単価（最終確定単価）', group: '値上げ交渉', type: 'number', aliases: ['最終確定単価', '合意単価'] },
  { key: 'r2_applied_ym', label: '適用年月', group: '値上げ交渉', type: 'text', aliases: ['第2弾適用年月', '適用年月'] },

  // 担当
  { key: 'voucher_no', label: '売上伝票NO', group: '担当', type: 'text', aliases: ['売上伝票NO', '売上伝票番号'] },
  { key: 'quote_no', label: '見積伝票番号', group: '担当', type: 'text', aliases: ['見積伝票番号', '見積伝票NO'] },
  { key: 'order_date', label: '受注日', group: '担当', type: 'date', aliases: ['受注日'] },
  { key: 'sales_date', label: '売上日', group: '担当', type: 'date', aliases: ['売上日'] },
  { key: 'branch', label: '支店', group: '担当', type: 'text', aliases: ['売上担当者支店名', '支店名', '支店'] },
  { key: 'office', label: '営業所', group: '担当', type: 'text', aliases: ['売上担当者営業所名', '営業所名', '営業所'] },
  { key: 'sales_person', label: '担当者', group: '担当', type: 'text', aliases: ['売上担当者名', '担当者名', '営業担当者名'] },
  { key: 'customer_person', label: '得意先担当者名', group: '担当', type: 'text', aliases: ['得意先担当者名'] },
];

export const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
export const REQUIRED_KEYS = FIELDS.filter((f) => f.required).map((f) => f.key);
export const TEXT_KEYS = new Set(FIELDS.filter((f) => f.type === 'text').map((f) => f.key));
export const DATE_KEYS = new Set(FIELDS.filter((f) => f.type === 'date').map((f) => f.key));
export const NUMBER_KEYS = new Set(FIELDS.filter((f) => f.type === 'number').map((f) => f.key));

// 正規化した見出し → 項目key。先に定義された別名を優先する
const ALIAS_INDEX = new Map();
for (const f of FIELDS) {
  for (const a of [f.label, ...f.aliases]) {
    const n = normalizeHeader(a);
    if (n && !ALIAS_INDEX.has(n)) ALIAS_INDEX.set(n, f.key);
  }
}

/**
 * 見出し行から列の対応を自動で組み立てる。
 * 同じ項目に複数の列が当たった場合は、後ろの列を採用する
 * （管理表では大分類・中分類のあとに総合の列が来るため）。
 */
export function autoMapHeaders(headers) {
  const mapping = {};       // fieldKey -> 列index
  const matched = [];       // { index, header, field }
  const unmatched = [];     // { index, header }
  headers.forEach((h, i) => {
    const text = String(h ?? '').trim();
    if (!text) return;
    const key = ALIAS_INDEX.get(normalizeHeader(text));
    if (key) {
      mapping[key] = i;     // 後勝ち
      matched.push({ index: i, header: text, field: key });
    } else {
      unmatched.push({ index: i, header: text });
    }
  });
  const missingRequired = REQUIRED_KEYS.filter((k) => mapping[k] === undefined);
  return { mapping, matched, unmatched, missingRequired };
}

/** 見出し行を探す。売上年月・得意先名・出荷単価のいずれかが並ぶ行を見出しとみなす */
export function findHeaderRow(grid, limit = 15) {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(grid.length, limit); i++) {
    const cells = (grid[i] || []).map((c) => String(c ?? '').trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const score = cells.filter((c) => ALIAS_INDEX.has(normalizeHeader(c))).length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return bestScore >= 3 ? best : -1;
}

/**
 * データ部分の指紋。
 * Excelは開いて保存し直すだけでバイト列が変わるため、ファイルの内容ハッシュだけでは
 * 「中身は同じなのに別ファイル扱い」になり、二重取込を止められない。
 * 見出しより下のセルの値だけから作ることで、データが同じなら同じ値になる。
 */
export function fingerprintCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function fingerprintRows(rows) {
  return rows.map((r) => (r || []).map(fingerprintCell).join('\t')).join('\n');
}

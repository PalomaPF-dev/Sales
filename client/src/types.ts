export interface User {
  id: number;
  name: string;
  role: 'sales' | 'branch_manager' | 'planning' | 'admin' | 'developer';
  branch: string | null;
  office: string | null;
  loginId?: string | null;
  mustChangePassword?: boolean;
  authDisabled?: boolean;
}

export interface PriceType {
  code: number;
  name: string;
  category: string;
  note: string;
}

/** 弾ごとの進み具合 */
export type RoundState = 'open' | 'agreed' | 'done';

export interface Deal {
  id: number;
  sales_ym: string | null;
  corp_code: string | null;
  corp_name: string | null;
  customer_code: string | null;
  customer_name: string | null;
  delivery_name: string | null;
  handler_name: string | null;
  industry: string | null;
  equip_name: string | null;
  category_name: string | null;
  model_name: string | null;
  /** 商品コード（価格調査の「商品コード」） */
  model_code?: string | null;
  /** 商品名（価格調査の「商品名」。器種名は品目階層名） */
  product_name?: string | null;
  gas_type: string | null;
  list_price: number | null;
  rate: number | null;
  base_price: number | null;        // ❶ 出荷単価
  /** 基準価格表の区分（大手 / 中規模 / 小規模）。担当者が選ぶと目標が入る */
  kubun: string | null;
  // マスタ登録（集約表）で入る項目
  agg_key?: string | null;
  qty?: number | null;              // 出荷数量
  cost_price?: number | null;       // 実績原価（管理者・開発者にだけ返る）
  a_price_m0?: number | null;       // A基準: 当月の申請単価
  a_price_m1?: number | null;       // A基準: 翌月の申請単価
  a_price_m2?: number | null;       // A基準: 翌々月の申請単価
  a_price_m3?: number | null;       // A基準: 3か月後の申請単価
  // A基準それぞれの承認日（マスタ登録の「登録日」）。法人×品目の中で最新の日
  a_date_m0?: string | null;
  a_date_m1?: string | null;
  a_date_m2?: string | null;
  a_date_m3?: string | null;
  // A基準それぞれの稟議No（マスタ登録に「稟議」列があるファイルのみ）
  a_ringi_m0?: string | null;
  a_ringi_m1?: string | null;
  a_ringi_m2?: string | null;
  a_ringi_m3?: string | null;
  b_price?: number | null;          // B基準: 実際の決定単価
  master_avg_price?: number | null; // 当月の実単価（価格調査。金額÷数量。見積ぶんで下がる）
  master_price?: number | null;     // 当月のマスタ単価（値決めの単価。A基準はこれと比べる）
  master_qty?: number | null;       // 当月の数量（価格調査）
  master_amount?: number | null;    // 当月の金額（合計。実績と合うようにそのまま持つ）
  plan_qty?: number | null;         // マスタ分の数量（A基準はこれに対して当てる）
  plan_amount?: number | null;      // マスタ分の金額（A基準の比較のもと）
  past_price?: number | null;       // 過去最新単価（値上げ前）
  past_date?: string | null;        // 過去最新受注日
  /** 基準価格表と突き合わせて判別した品名（サーバーが添える。マスター未登録時は付かない） */
  std_name?: string | null;
  /** 判別の方法。code=器種ガスコード一致 / name=品名一致 / similar=類似（先頭一致） */
  std_kind?: 'code' | 'name' | 'similar' | null;
  /** 判別した器種の、区分ごとの値上後単価（区分を選ぶ前の候補表示に使う） */
  std_targets?: Record<string, number> | null;
  // 値上げ交渉（列名の r2_ は旧・第2弾の名残。いまは唯一の交渉を指す）
  r2_target_price: number | null;   // ❷ 目標値上げ単価（管理者のみ変更可）
  r2_agreed_price: number | null;   // ❸ 合意単価
  r2_raise_unit: number | null;     // ❹ ❸−❶
  r2_applied_ym: string | null;     // 適用年月
  nego_result?: string | null;      // 商談結果（○=合意 / △=交渉中 / ×=不可）
  nego_note?: string | null;        // 商談メモ（商談結果の詳細。品目ごとに残す）
  final_date?: string | null;       // 最終確定日
  final_price?: number | null;      // 最終確定単価
  r2_done: number;
  r2_state: RoundState;

  voucher_no: string | null;
  quote_no: string | null;
  sales_person: string | null;
  branch: string | null;
  office: string | null;
  price_type_code: number | null;
  // 法人の交渉情報（一覧で交渉状況を出すために付与される）
  corp_status?: string | null;
  corp_contact_date?: string | null;
  corp_note?: string | null;
  corp_log_count?: number;
}

/** 法人ごとの交渉情報 */
export interface CorpNegotiation {
  corp_code: string;
  corp_name: string | null;
  status: string;
  contact_date: string | null;
  note: string | null;
  updated_at: string | null;
}

export interface CorpSummary {
  corp_code: string;
  corp_name: string | null;
  deals: number;
  r2_done: number;
  status: string | null;
  contact_date: string | null;
  note: string | null;
  log_count: number;
}

export interface NegotiationLogEntry {
  id: number;
  corp_code: string;
  user_id: number | null;
  user_name: string | null;
  contact_date: string | null;
  channel: string | null;
  result: string | null;
  note: string;
  created_at: string;
}

export interface Meta {
  priceTypes: PriceType[];
  equips: { name: string; count: number }[];
  persons: { name: string; count: number }[];
  customers: { code: string; name: string; count: number }[];
  corps: { code: string; name: string; count: number }[];
  branches: { name: string; count: number }[];
  offices: { branch: string; name: string; count: number }[];
  exportMaxRows?: number;
  states: { code: RoundState; name: string }[];
  corpStatuses: { code: string; name: string }[];
  /** マスタ登録（集約表）の取込情報。A基準の月（YYYY-MM）と出荷単価の期間 */
  aggMeta?: { m0?: string; m1: string; m2: string; m3: string; basePeriod: string; filename?: string } | null;
  /** 価格調査（当月実績）の取込情報。ym は当月（例 2026-07） */
  actualMeta?: { ym?: string; filename?: string; updatedAt?: string } | null;
}

export const ROUND_STATE_NAMES: Record<string, string> = {
  open: '未入力',
  agreed: '合意済',
  done: '完了',
};

export const CORP_STATUS_NAMES: Record<string, string> = {
  not_started: '未着手',
  negotiating: '交渉中',
  agreed: '合意',
  declined: '値上げ不可',
};

/** 商談結果の記号と意味 */
export const NEGO_LABELS: Record<string, string> = {
  '〇': '合意',
  '□': '広域待ち',
  '△': '否決',
  '×': '本社へ相談',
};

export const ROLE_NAMES: Record<string, string> = {
  sales: '営業担当者',
  branch_manager: '支店長',
  planning: '営業企画部',
  admin: '管理者',
  developer: '開発者',
};

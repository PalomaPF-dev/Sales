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
  hist_avg_price?: number | null;   // 出荷実績（月別履歴）の平均単価（法人×品目）
  hist_qty?: number | null;         // 出荷実績の数量合計（法人×品目）
  master_avg_price?: number | null; // マスタ登録の1~3月出荷実績の平均単価（数量加重平均）
  master_qty?: number | null;       // マスタ登録の1~3月売上数の合計
  // 価格調査の実単価（月ごと）。並びは Meta.actualMeta.months と同じ
  act_price_1?: number | null;
  act_price_2?: number | null;
  act_price_3?: number | null;
  act_price_4?: number | null;
  act_price_5?: number | null;
  act_price_6?: number | null;
  act_price_7?: number | null;
  act_price_8?: number | null;
  act_price_9?: number | null;
  act_price_10?: number | null;
  act_price_11?: number | null;
  act_price_12?: number | null;
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
  /** 出荷実績（月別履歴）の取込情報 */
  histMeta?: { period: string; months?: number | null; filename?: string } | null;
  /** 価格調査（実単価）の取込情報。months は ['2026-04', ...] の並び */
  actualMeta?: { months: string[]; filename?: string; updatedAt?: string } | null;
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

export const ROLE_NAMES: Record<string, string> = {
  sales: '営業担当者',
  branch_manager: '支店長',
  planning: '営業企画部',
  admin: '管理者',
  developer: '開発者',
};

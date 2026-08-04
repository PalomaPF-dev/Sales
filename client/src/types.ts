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
  // 第1弾
  r1_target_price: number | null;   // ❷ 目標値上げ単価（管理者のみ変更可）
  r1_agreed_price: number | null;   // ❸ 合意単価
  r1_raise_unit: number | null;     // ❹ ❸−❶
  r1_applied_ym: string | null;     // 適用年月
  r1_done: number;
  r1_state: RoundState;
  // 第2弾
  r2_target_price: number | null;   // ❻ 目標値上げ単価（管理者のみ変更可）
  r2_agreed_price: number | null;   // ❼ 合意単価
  r2_raise_unit: number | null;     // ❽ ❼−❸
  r2_applied_ym: string | null;
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
  r1_done: number;
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

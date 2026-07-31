export interface User {
  id: number;
  name: string;
  role: 'sales' | 'branch_manager' | 'planning' | 'admin';
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

export interface Deal {
  id: number;
  sales_ym: string | null;
  corp_name: string | null;
  customer_code: string | null;
  customer_name: string | null;
  delivery_name: string | null;
  industry: string | null;
  equip_name: string | null;
  category_name: string | null;
  model_name: string | null;
  gas_type: string | null;
  qty: number | null;
  list_price: number | null;
  rate: number | null;
  base_price: number | null;        // ❶ 出荷単価
  r1_target_price: number | null;   // ❷ 目標値上げ単価（第1弾）
  r1_agreed_price: number | null;   // ❸ 値上後単価
  r1_raise_unit: number;            // ❹
  r1_raise_amount: number;          // ❺
  r2_target_price: number | null;   // ❻ 目標値上げ単価（第2弾）
  r2_agreed_price: number | null;   // ❼ 最終確定単価
  r2_raise_unit: number;            // ❽
  r2_raise_amount: number;          // ❾
  r1_target_amount: number;
  r2_target_amount: number;
  voucher_no: string | null;
  quote_no: string | null;
  sales_person: string | null;
  branch: string | null;
  office: string | null;
  negotiated_date: string | null;
  negotiation_note: string | null;
  r1_ringi_no: string | null;
  r1_raise_date: string | null;
  new_list_price: number | null;
  offer1_date: string | null;
  offer1_rate: number | null;
  offer1_price: number | null;
  r2_result_symbol: string | null;
  r2_ringi_no: string | null;
  final_confirm_date: string | null;
  price_type_code: number | null;
  status: string;
}

export interface AppItem {
  id: number;
  deal_id: number;
  base_price: number | null;
  target_price: number | null;
  agreed_price: number;
  qty: number | null;
  customer_name?: string;
  model_name?: string;
  equip_name?: string;
  gas_type?: string;
  delivery_name?: string;
}

export interface Approval {
  id: number;
  step: 'branch' | 'planning';
  approver_name: string | null;
  action: 'approved' | 'rejected';
  comment: string | null;
  acted_at: string;
}

export interface Application {
  id: number;
  round: 1 | 2;
  title: string;
  customer_code: string | null;
  customer_name: string | null;
  applicant_id: number;
  applicant_name?: string;
  branch: string | null;
  price_type_code: number | null;
  price_type_name?: string;
  price_type_category?: string;
  status: 'draft' | 'pending_branch' | 'pending_planning' | 'approved' | 'rejected' | 'withdrawn';
  route: 'branch' | 'planning' | null;
  rule_name: string | null;
  target_amount: number | null;
  agreed_amount: number | null;
  achievement_rate: number | null;
  comment: string | null;
  created_at: string;
  decided_at: string | null;
  item_count?: number;
  items?: AppItem[];
  approvals?: Approval[];
}

export interface Rule {
  id?: number;
  name: string;
  min_rate: number | null;
  max_rate: number | null;
  final_step: 'branch' | 'planning';
  priority?: number;
  active?: number | boolean;
}

export interface Meta {
  priceTypes: PriceType[];
  equips: { name: string; count: number }[];
  persons: { name: string; count: number }[];
  customers: { code: string; name: string; count: number }[];
  branches: { name: string; count: number }[];
  offices: { branch: string; name: string; count: number }[];
  exportMaxRows?: number;
  statuses: { code: string; name: string }[];
}

export const STATUS_NAMES: Record<string, string> = {
  not_started: '未着手',
  negotiating: '交渉中',
  r1_agreed: '第1弾妥結',
  r2_negotiating: '第2弾交渉中',
  r2_agreed: '第2弾妥結',
  declined: '値上げ不可',
};

export const APP_STATUS_NAMES: Record<string, string> = {
  draft: '下書き',
  pending_branch: '支店長承認待ち',
  pending_planning: '営業企画部承認待ち',
  approved: '承認済み',
  rejected: '差戻し',
  withdrawn: '取下げ',
};

export const ROLE_NAMES: Record<string, string> = {
  sales: '営業担当者',
  branch_manager: '支店長',
  planning: '営業企画部',
  admin: '管理者',
};

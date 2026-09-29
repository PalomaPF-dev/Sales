/**
 * 出荷実績の色分け（色塗り判定）の画面で共通に使う型と部品。
 * Excelの部品（xlsx）は大きいので、ここには入れない（ファイルを選んだときだけ読む）。
 */

export interface ShipCategory { key: string; label: string; color: string }

export interface ShipRules {
  /** 判定の対象にするカテゴリー名大（湯沸・PH・PR・FH）。これ以外は取り込まない */
  targetCategories: string[];
  excludeCorps: string[];
  pinkCorps: string[];
  pinkPrefixes: string[];
  pinkExcept: string[];
  pinkSuffixes: string[];
  contractQuotes: string[];
  greenCorpCodes: { code: string; name: string; until: string }[];
  periodCustomers: { code: string; name: string; until: string }[];
  orderCutoff: string;
  /** 過去の色塗り（条件5・7）に使う出荷データの起点（売上日）。空ならすべて */
  historyFrom: string;
  kettleCategory: string;
  grayKeywords: string[];
  grayModels: string[];
  grayPrefixes: string[];
}

export interface ShipRulesRes {
  rules: ShipRules;
  defaults: ShipRules;
  categories: ShipCategory[];
  ruleLabels: Record<string, string>;
  basePrices: { count: number; updatedAt: string | null };
}

/** 判定条件に当たらなかった行（目視確認）と、対象外（輸出） */
export const UNSET: ShipCategory = { key: 'unset', label: '未判定（目視確認）', color: '#FFFFFF' };
export const EXCLUDED: ShipCategory = { key: 'excluded', label: '対象外（輸出）', color: '#E5E5E5' };

/** 画面の並び。色塗り資料の凡例の順に、未判定・対象外を後ろへ足す */
export const allCategories = (cats: ShipCategory[]) => [...cats, UNSET, EXCLUDED];

export const SOURCE_LABELS: Record<string, string> = {
  manual: '手動',
  file: 'ファイルの色',
  auto: '自動判定',
};

export interface ShipBatch {
  id: number;
  data_date: string;
  filename: string | null;
  sheet: string | null;
  row_count: number;
  colored_count: number;
  status: string;
  taken_at: string;
  taken_by_name: string | null;
  classified_at: string | null;
  min_sale: string | null;
  max_sale: string | null;
}

/** 日本時間の今日（YYYY-MM-DD） */
export const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

/** 区分の色の呼び名。Excelの集計表では塗りを付けられないため、名前で添える */
export const COLOR_NAMES: Record<string, string> = {
  raised: '水色',
  ordered: '緑',
  contract: '黄',
  unsigned: 'ピンク',
  nonpos: 'オレンジ',
  other: '灰',
  unset: '色なし',
  excluded: '—',
};

/**
 * この機能を使える権限。まずは管理者だけで試す（開発者は管理者と同じ扱い）。
 * サーバー側の server/shipColor.js の SHIP_VIEW_ROLES と合わせる（画面で隠すだけでなくAPIも止めている）
 */
export const SHIP_VIEW_ROLES = ['admin', 'developer'];
export const canUseShipColor = (role: string) => SHIP_VIEW_ROLES.includes(role);

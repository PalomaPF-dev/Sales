import type { ReactNode } from 'react';
import { APP_STATUS_NAMES, STATUS_NAMES } from '../types';

const DEAL_STATUS_COLOR: Record<string, string> = {
  not_started: 'gray',
  negotiating: 'blue',
  r1_agreed: 'green',
  r2_negotiating: 'orange',
  r2_agreed: 'green',
  declined: 'red',
};

const APP_STATUS_COLOR: Record<string, string> = {
  draft: 'gray',
  pending_branch: 'yellow',
  pending_planning: 'orange',
  approved: 'green',
  rejected: 'red',
  withdrawn: 'gray',
};

export function DealStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${DEAL_STATUS_COLOR[status] || 'gray'}`}>{STATUS_NAMES[status] || status}</span>;
}

export function AppStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${APP_STATUS_COLOR[status] || 'gray'}`}>{APP_STATUS_NAMES[status] || status}</span>;
}

export function PriceTypeBadge({ code, name, category }: { code: number | null; name?: string; category?: string }) {
  if (code == null) return <span className="badge gray">未設定</span>;
  const color = category === '物件対応' ? 'violet' : category === '販売店対応' ? 'blue' : 'gray';
  return (
    <span className={`badge ${color}`} title={category}>
      {code}. {name || ''}
    </span>
  );
}

export function RouteBadge({ route }: { route: string | null }) {
  if (!route) return null;
  return route === 'branch' ? (
    <span className="badge blue">支店長決裁</span>
  ) : (
    <span className="badge orange">営業企画部決裁</span>
  );
}

export function Meter({ value, max, color }: { value: number; max: number; color: string }) {
  const rate = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="meter" role="img" aria-label={`進捗 ${rate.toFixed(1)}%`}>
      <span style={{ width: `${rate}%`, background: color }} />
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="card">
      {title && <h3>{title}</h3>}
      {children}
    </div>
  );
}

const STAGE_STEPS = [
  { key: 'negotiating', label: '交渉' },
  { key: 'r1_agreed', label: '第1弾' },
  { key: 'r2_negotiating', label: '第2弾交渉' },
  { key: 'r2_agreed', label: '第2弾' },
];

// ステータスがどこまで進んだかの段階（-1 は未着手 / 値上げ不可は別扱い）
const STAGE_INDEX: Record<string, number> = {
  not_started: -1,
  negotiating: 0,
  r1_agreed: 1,
  r2_negotiating: 2,
  r2_agreed: 3,
};

/**
 * 値上げ交渉がどこまで進んでいるかを一覧上で示す。
 * 段階のドットに加えて、直近の商談日と結果を添える。
 */
export function NegotiationStage({ deal }: {
  deal: {
    status: string;
    last_contact_date?: string | null;
    last_result?: string | null;
    last_note?: string | null;
    log_count?: number;
    negotiated_date?: string | null;
    r2_result_symbol?: string | null;
  };
}) {
  const declined = deal.status === 'declined';
  const current = STAGE_INDEX[deal.status] ?? -1;
  const lastDate = deal.last_contact_date || deal.negotiated_date;

  return (
    <div className="stage">
      <div className="stage-dots" title={STATUS_NAMES[deal.status] || deal.status}>
        {STAGE_STEPS.map((s, i) => (
          <span
            key={s.key}
            className={declined ? 'declined' : i <= current ? 'done' : ''}
            title={s.label}
          />
        ))}
      </div>
      <span className="stage-label">
        {declined ? '値上げ不可' : STATUS_NAMES[deal.status] || deal.status}
      </span>
      {(lastDate || deal.last_result) && (
        <span className="stage-sub" title={deal.last_note || ''}>
          {lastDate ? String(lastDate).slice(0, 10) : ''}
          {deal.last_result ? ` ${deal.last_result}` : ''}
          {deal.log_count ? `（履歴${deal.log_count}）` : ''}
        </span>
      )}
    </div>
  );
}

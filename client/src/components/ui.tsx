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

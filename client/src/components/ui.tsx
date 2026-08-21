import { useState, type ReactNode } from 'react';
import { CORP_STATUS_NAMES, ROUND_STATE_NAMES } from '../types';
import type { RoundState } from '../types';

const ROUND_STATE_COLOR: Record<string, string> = {
  open: 'gray',
  agreed: 'blue',
  done: 'green',
};

const CORP_STATUS_COLOR: Record<string, string> = {
  not_started: 'gray',
  negotiating: 'blue',
  agreed: 'green',
  declined: 'red',
};

/** 弾ごとの進み具合（未入力 / 合意済 / 完了） */
export function RoundStateBadge({ state }: { state: RoundState | string }) {
  return (
    <span className={`badge ${ROUND_STATE_COLOR[state] || 'gray'}`}>
      {ROUND_STATE_NAMES[state] || state}
    </span>
  );
}

/** 法人の交渉状況 */
export function CorpStatusBadge({ status }: { status?: string | null }) {
  const s = status || 'not_started';
  return (
    <span className={`badge ${CORP_STATUS_COLOR[s] || 'gray'}`}>
      {CORP_STATUS_NAMES[s] || s}
    </span>
  );
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

/** 数として読む。未入力・nullは0に落とす */
export const num = (n: unknown) => Number(n ?? 0);

/** 数字の列の見た目。桁を揃えて右寄せにする */
export const nums = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;

/**
 * カードの説明文。長い説明で表が押し下げられないよう、既定では閉じておく。
 * 「この表の読み方」を押すと開き、選んだ状態は覚える（カードごと）。
 */
export function NoteFold({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(`note.${id}`) === '1'; } catch { return false; }
  });
  const toggle = () => setOpen((v) => {
    try { localStorage.setItem(`note.${id}`, v ? '0' : '1'); } catch { /* 使えなくても困らない */ }
    return !v;
  });
  return (
    <div className="notefold">
      <button type="button" className="notefold-btn" onClick={toggle} aria-expanded={open}>
        <span className="mk">{open ? '▾' : '▸'}</span>この表の読み方
      </button>
      {open && <p className="pt-note" style={{ marginTop: 8 }}>{children}</p>}
    </div>
  );
}

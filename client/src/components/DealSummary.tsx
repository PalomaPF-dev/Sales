import { useEffect, useState } from 'react';
import { api, yen, pct } from '../api';

export interface SummaryRow {
  branch?: string | null;
  office?: string | null;
  equip_name?: string | null;
  customer_name?: string | null;
  sales_person?: string | null;
  status?: string | null;
  deals: number;
  qty: number;
  r1_target: number;
  r2_target: number;
  total_target: number;
  r1_amount: number;
  r2_amount: number;
  total_amount: number;
  cnt_not_started: number;
  cnt_negotiating: number;
  cnt_r1_agreed: number;
  cnt_r2_negotiating: number;
  cnt_r2_agreed: number;
  cnt_declined: number;
}

interface SummaryRes {
  group: string;
  labelKey: keyof SummaryRow;
  rows: SummaryRow[];
  total: SummaryRow;
}

const GROUPS = [
  { key: 'branch', label: '支店' },
  { key: 'office', label: '営業所' },
  { key: 'equip', label: '器具区分' },
  { key: 'customer', label: '得意先' },
  { key: 'person', label: '担当者' },
] as const;

const STATUS_LABEL: Record<string, string> = {
  not_started: '未着手', negotiating: '交渉中', r1_agreed: '第1弾妥結',
  r2_negotiating: '第2弾交渉中', r2_agreed: '第2弾妥結', declined: '値上げ不可',
};

/** 交渉の進み具合を1本の帯で表す */
function ProgressBar({ r }: { r: SummaryRow }) {
  const segments = [
    { n: Number(r.cnt_r2_agreed), color: 'var(--good)', label: '第2弾妥結' },
    { n: Number(r.cnt_r1_agreed), color: 'var(--series-1)', label: '第1弾妥結' },
    { n: Number(r.cnt_r2_negotiating), color: 'var(--series-2)', label: '第2弾交渉中' },
    { n: Number(r.cnt_negotiating), color: 'var(--warning)', label: '交渉中' },
    { n: Number(r.cnt_declined), color: 'var(--critical)', label: '値上げ不可' },
    { n: Number(r.cnt_not_started), color: 'var(--grid)', label: '未着手' },
  ].filter((s) => s.n > 0);
  const total = segments.reduce((s, x) => s + x.n, 0) || 1;
  return (
    <div className="progress-track" role="img"
         aria-label={segments.map((s) => `${s.label} ${s.n}件`).join('、')}>
      {segments.map((s) => (
        <span key={s.label} style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
              title={`${s.label} ${s.n.toLocaleString()}件`} />
      ))}
    </div>
  );
}

/**
 * 案件一覧の集計。画面の絞り込み条件をそのまま引き継ぐ。
 * 目標値上金額と実績を隣り合わせに置き、達成率と交渉の進み具合を並べて見られるようにする。
 */
export default function DealSummary({ query }: { query: URLSearchParams }) {
  const [group, setGroup] = useState<string>('branch');
  const [data, setData] = useState<SummaryRes | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const qs = new URLSearchParams(query);
    qs.set('group', group);
    api<SummaryRes>(`/deals/summary?${qs}`).then(setData).catch((e) => setError(e.message));
  }, [group, query.toString()]);

  const rate = (a: number, t: number) => (t > 0 ? (a / t) * 100 : 0);

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>集計</strong>
        <div className="seg">
          {GROUPS.map((g) => (
            <button key={g.key} className={group === g.key ? 'on' : ''} onClick={() => setGroup(g.key)}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="grow" />
        <span className="legend" style={{ margin: 0 }}>
          <span><i style={{ background: 'var(--good)' }} />第2弾妥結</span>
          <span><i style={{ background: 'var(--series-1)' }} />第1弾妥結</span>
          <span><i style={{ background: 'var(--series-2)' }} />第2弾交渉中</span>
          <span><i style={{ background: 'var(--warning)' }} />交渉中</span>
          <span><i style={{ background: 'var(--grid)' }} />未着手</span>
        </span>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>{GROUPS.find((g) => g.key === group)?.label}</th>
              <th className="num">明細</th>
              <th className="num">台数</th>
              <th className="num">目標値上金額</th>
              <th className="num">実績値上金額</th>
              <th className="num">達成率</th>
              <th style={{ minWidth: 180 }}>交渉状況</th>
              <th className="num">妥結</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((r, i) => {
              const label = (r[data.labelKey] as string) || '（未設定）';
              const agreed = Number(r.cnt_r1_agreed) + Number(r.cnt_r2_agreed);
              return (
                <tr key={`${label}-${i}`}>
                  <td title={r.office ? `${r.branch} / ${r.office}` : label}>{label}</td>
                  <td className="num">{Number(r.deals).toLocaleString()}</td>
                  <td className="num">{Number(r.qty).toLocaleString()}</td>
                  <td className="num">¥{yen(r.total_target)}</td>
                  <td className="num"><strong>¥{yen(r.total_amount)}</strong></td>
                  <td className="num">{pct(rate(Number(r.total_amount), Number(r.total_target)))}</td>
                  <td><ProgressBar r={r} /></td>
                  <td className="num">{agreed.toLocaleString()} / {Number(r.deals).toLocaleString()}</td>
                </tr>
              );
            })}
            {data && (
              <tr className="total-row">
                <td>合計</td>
                <td className="num">{Number(data.total.deals).toLocaleString()}</td>
                <td className="num">{Number(data.total.qty).toLocaleString()}</td>
                <td className="num">¥{yen(data.total.total_target)}</td>
                <td className="num"><strong>¥{yen(data.total.total_amount)}</strong></td>
                <td className="num">
                  {pct(rate(Number(data.total.total_amount), Number(data.total.total_target)))}
                </td>
                <td><ProgressBar r={data.total} /></td>
                <td className="num">
                  {(Number(data.total.cnt_r1_agreed) + Number(data.total.cnt_r2_agreed)).toLocaleString()}
                  {' / '}{Number(data.total.deals).toLocaleString()}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {group === 'status' && data && (
        <p className="pt-note">
          {data.rows.map((r) => `${STATUS_LABEL[r.status ?? ''] ?? r.status}: ${r.deals}`).join(' / ')}
        </p>
      )}
    </div>
  );
}

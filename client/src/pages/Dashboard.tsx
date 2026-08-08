import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card } from '../components/ui';
import type { Meta } from '../types';

/** 案件一覧と同じ絞り込みを受ける。集計と一覧を同じ条件で行き来できるようにするため */
const FILTER_KEYS = ['equip', 'person', 'corp', 'branch', 'office'] as const;

/**
 * 支店別・法人別の値上げ額の集計。
 *   目標額 = 現状の出荷単価 × 数量の合計
 *   実績   = マスタ登録単価（A基準）前提で、数量を固定したままの月別合計
 *   値上げ額 = 実績（3か月後） − 目標額
 */
interface AbRow {
  name?: string | null;
  branch?: string | null;
  deals: number;
  qty: number;
  base_amt: number;
  a1_amt: number;
  a2_amt: number;
  a3_amt: number;
}

interface DashboardRes {
  scope: { level: string; label: string; missing?: string; note?: string };
  abTotals?: AbRow;
  abByBranch?: AbRow[];
  abByOffice?: AbRow[];
  abByCorp?: AbRow[];
  months?: number;
  aggMeta?: { m1: string; m2: string; m3: string; basePeriod: string } | null;
}

const num = (n: unknown) => Number(n ?? 0);
const yen = (v: number) => `¥${Math.round(v).toLocaleString()}`;

/** KPIタイル。既存の .tiles / .tile の見た目に合わせる */
function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="delta">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<DashboardRes | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [msg, setMsg] = useState('');

  const get = (k: string) => params.get(k) || '';
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch(() => {});
  }, []);

  useEffect(() => {
    const qs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (get(k)) qs.set(k, get(k));
    setData(null);
    api<DashboardRes>(`/dashboard?${qs}`).then(setData).catch((e) => setMsg(e.message));
  }, [params]);

  if (msg) return <div className="alert error">{msg}</div>;
  if (!data) return <p style={{ color: 'var(--muted)' }}>読み込み中...</p>;

  const t = data.abTotals;
  const totalGain = num(t?.a3_amt) - num(t?.base_amt);
  const m1 = data.aggMeta?.m1 || '翌月';
  const m2 = data.aggMeta?.m2 || '翌々月';
  const m3 = data.aggMeta?.m3 || '3か月後';
  const months = data.months || 12;
  const offices = meta?.offices.filter((o) => !get('branch') || o.branch === get('branch')) || [];

  const nums = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;

  /** 月のマス。実績（A基準前提の売上）と、その下に値上げ額（実績−目標額）を出す */
  const MonthCell = ({ amt, base }: { amt: number; base: number }) => {
    const gain = amt - base;
    return (
      <td style={nums}>
        {yen(amt)}
        <div style={{ fontSize: 11, fontWeight: 700,
                      color: gain < 0 ? '#c2410c' : gain > 0 ? '#15803d' : 'var(--muted)' }}>
          {gain === 0 ? '—' : `${gain > 0 ? '＋' : '−'}${yen(Math.abs(gain))}`}
        </div>
      </td>
    );
  };

  /** 集計表。支店別・営業所別・法人別で同じ形を使う */
  const AbTable = ({ head, rows, withBranch }:
    { head: string; rows: AbRow[]; withBranch?: boolean }) => (
    <div className="tbl-scroll" style={{ maxHeight: 460 }}>
      <table className="tbl">
        <thead>
          <tr>
            {withBranch && <th>支店</th>}
            <th>{head}</th>
            <th style={nums}>件数</th>
            <th style={nums} title={`期間全体の合計と、1か月あたり（÷${months}か月）`}>
              数量<br /><small>合計 / 月平均</small>
            </th>
            <th style={nums} title="実績の平均出荷単価 × 数量の合計">目標額<br /><small>（出荷単価前提）</small></th>
            <th style={nums}>{m1}<br /><small>実績 / 値上げ額</small></th>
            <th style={nums}>{m2}<br /><small>実績 / 値上げ額</small></th>
            <th style={nums}>{m3}<br /><small>実績 / 値上げ額</small></th>
          </tr>
        </thead>
        <tbody>
          {[...rows, { ...t!, name: '合計', branch: '' }].map((r, i) => {
            const last = i === rows.length;
            const base = num(r.base_amt);
            return (
              <tr key={i} style={last ? { fontWeight: 700, borderTop: '2px solid var(--grid)' } : undefined}>
                {withBranch && <td>{last ? '' : (r.branch || '—')}</td>}
                <td>{r.name || '—'}</td>
                <td style={nums}>{num(r.deals).toLocaleString()}</td>
                <td style={nums}>
                  {num(r.qty).toLocaleString()}
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    月{(num(r.qty) / months).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </div>
                </td>
                <td style={nums}>{yen(base)}</td>
                <MonthCell amt={num(r.a1_amt)} base={base} />
                <MonthCell amt={num(r.a2_amt)} base={base} />
                <MonthCell amt={num(r.a3_amt)} base={base} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <h1 className="page-title">ダッシュボード</h1>
      <p className="page-sub">
        支店別・営業所別・法人別の値上げ額です。<strong>目標額</strong>は実績の平均出荷単価 × 数量の合計、
        <strong>実績</strong>はマスタ登録単価（A基準）前提で数量を固定した月別合計、
        その差が<strong>値上げ額</strong>です。金額は期間全体（{data.aggMeta?.basePeriod ? '' : ''}
        {meta?.histMeta?.period ?? ''}）の合計で、月あたりは÷{months}か月です。
        対象は<strong>A基準の入っている案件</strong>だけ（マスタ登録に無い品目は値上げの対象外のため）。
        表示範囲: <strong>{data.scope.label}</strong>
      </p>

      <div className="filters">
        <label className="fld">
          法人
          <select value={get('corp')} onChange={(e) => setParam('corp', e.target.value)}>
            <option value="">すべて</option>
            {meta?.corps.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <label className="fld">
          支店
          <select value={get('branch')} onChange={(e) => { setParam('branch', e.target.value); setParam('office', ''); }}>
            <option value="">全社</option>
            {meta?.branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </label>
        <label className="fld">
          営業所
          <select value={get('office')} onChange={(e) => setParam('office', e.target.value)}>
            <option value="">すべて</option>
            {offices.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
        </label>
        <label className="fld">
          器具区分
          <select value={get('equip')} onChange={(e) => setParam('equip', e.target.value)}>
            <option value="">すべて</option>
            {meta?.equips.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
        </label>
        <label className="fld">
          担当者
          <select value={get('person')} onChange={(e) => setParam('person', e.target.value)}>
            <option value="">すべて</option>
            {meta?.persons.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
      </div>

      <div className="tiles">
        <Kpi label="対象（A基準あり）" value={`${num(t?.deals).toLocaleString()}件`}
             sub={`数量 ${num(t?.qty).toLocaleString()}（月${Math.round(num(t?.qty) / months).toLocaleString()}）`} />
        <Kpi label="目標額（出荷単価前提）" value={yen(num(t?.base_amt))} />
        <Kpi label={`実績（${m3}・A基準前提）`} value={yen(num(t?.a3_amt))} />
        <Kpi label="値上げ額の合計" value={`${totalGain >= 0 ? '＋' : '−'}${yen(Math.abs(totalGain))}`}
             sub={`月あたり ${totalGain >= 0 ? '＋' : '−'}${yen(Math.abs(totalGain) / months)}`
               + (num(t?.base_amt) > 0
                 ? ` ・ 目標額比 ${(Math.round((totalGain / num(t?.base_amt)) * 1000) / 10).toLocaleString()}%` : '')} />
      </div>

      <Card title="支店別の値上げ額">
        <AbTable head="支店" rows={data.abByBranch ?? []} />
      </Card>

      <Card title="営業所別の値上げ額">
        <AbTable head="営業所" rows={data.abByOffice ?? []} withBranch />
      </Card>

      <Card title="法人別の値上げ額（目標額の上位30）">
        <AbTable head="法人" rows={data.abByCorp ?? []} />
      </Card>
    </div>
  );
}

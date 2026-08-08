import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card } from '../components/ui';
import type { Meta } from '../types';

/** 案件一覧と同じ絞り込みを受ける。集計と一覧を同じ条件で行き来できるようにするため */
const FILTER_KEYS = ['equip', 'person', 'corp', 'branch', 'office', 'aDateYm', 'aDateOp'] as const;

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
  /** 想定B基準（法人ごとの妥結見通し）にした場合の売上。決定済みはB基準そのもの */
  bsim_amt: number;
  b_rows: number;
}

interface DashboardRes {
  scope: { level: string; label: string; missing?: string; note?: string };
  /** 出荷実績の全体（マスタ登録の絞り込みを受けない、純粋な品目件数と数量） */
  histTotals?: { deals: number; qty: number };
  /** 月別のマスタ登録（A基準）。申請の入った件数と値上げ額の合計（絞り込みが効く） */
  aMonths?: {
    covered: number;
    cnt_m0: number; cnt_m1: number; cnt_m2: number; cnt_m3: number;
    raise_m0: number | null; raise_m1: number | null; raise_m2: number | null; raise_m3: number | null;
    /** 想定B基準にした場合の値上げ額（3か月後のA基準と同じ土俵で比べる） */
    raise_bsim: number | null;
    b_rows: number;
  };
  abTotals?: AbRow;
  abByEquip?: AbRow[];
  abByBranch?: AbRow[];
  abByOffice?: AbRow[];
  abByCorp?: AbRow[];
  months?: number;
  aggMeta?: { m0?: string; m1: string; m2: string; m3: string; basePeriod: string } | null;
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
  const m0 = data.aggMeta?.m0 || '当月';
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
            <th style={nums} title="法人ごとに決めた妥結の見通し（A基準の何%）で試算した場合。決定単価が入っている案件はその単価">
              想定B基準<br /><small>実績 / 値上げ額</small>
            </th>
            <th style={nums} title="想定B基準 − A基準（3か月後）。マイナスは値引きして妥結する見込みの分">
              A基準との差
            </th>
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
                <MonthCell amt={num(r.bsim_amt)} base={base} />
                {(() => {
                  const gap = num(r.bsim_amt) - num(r.a3_amt);
                  return (
                    <td style={{ ...nums, fontWeight: 600,
                                 color: gap < 0 ? '#c2410c' : gap > 0 ? '#15803d' : 'var(--muted)' }}>
                      {gap === 0 ? '—' : `${gap > 0 ? '＋' : '−'}${yen(Math.abs(gap))}`}
                    </td>
                  );
                })()}
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
        出荷実績（{meta?.histMeta?.period ?? '期間全体'}）の<strong>純粋な品目件数</strong>を母数に、
        マスタ登録（A基準）の件数と、月ごとの<strong>値上げ額</strong>（(A基準−実績の平均出荷単価)×数量）を出します。
        <strong>承認日</strong>で絞ると、マスタ登録件数と値上げ額がその条件に変わります
        （出荷実績の母数は変わりません）。
        下の表の<strong>目標額</strong>は実績の平均出荷単価×数量、<strong>実績</strong>はA基準前提で
        数量を固定した月別合計、その差が値上げ額です。金額は期間全体の合計、月あたりは÷{months}か月。
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
        {/* 承認日での絞り込み（案件一覧と同じ。3か月後のA基準の承認日が基準） */}
        <label className="fld" title={`${m3}のA基準の承認日で絞り込みます`}>
          承認日
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="month"
              value={get('aDateYm')}
              onChange={(e) => setParam('aDateYm', e.target.value)}
              style={{ flex: '1 1 auto', minWidth: 0 }}
            />
            <select
              value={get('aDateOp') || 'from'}
              onChange={(e) => setParam('aDateOp', e.target.value === 'from' ? '' : e.target.value)}
              style={{ flex: '0 0 auto' }}
            >
              <option value="from">以降</option>
              <option value="before">より前</option>
            </select>
          </div>
        </label>
      </div>

      {/*
        出荷実績（土台）→ マスタ登録の件数（品目ベースの件数が母数）→
        月ごとの値上げ額（月あたり）の並び。
        承認日の絞り込みを変えると、ここもその条件で数え直される。
      */}
      <div className="tiles">
        <Kpi label={`出荷実績${meta?.histMeta?.period ? `（${meta.histMeta.period}）` : ''}`}
             value={`${num(data.histTotals?.deals).toLocaleString()}件`}
             sub={`数量 ${num(data.histTotals?.qty).toLocaleString()}（月${Math.round(num(data.histTotals?.qty) / months).toLocaleString()}）`} />
        <Kpi label="マスタ登録（A基準あり）"
             value={`${num(data.aMonths?.covered).toLocaleString()} / ${num(data.histTotals?.deals).toLocaleString()}件`}
             sub={num(data.histTotals?.deals) > 0
               ? `品目ベースの ${(Math.round((num(data.aMonths?.covered) / num(data.histTotals?.deals)) * 1000) / 10).toLocaleString()}%`
               : undefined} />
        {([
          [m0, data.aMonths?.raise_m0],
          [m1, data.aMonths?.raise_m1],
          [m2, data.aMonths?.raise_m2],
          [m3, data.aMonths?.raise_m3],
        ] as [string, number | null | undefined][]).map(([label, raise]) => {
          const r = num(raise) / months;
          return (
            <Kpi key={label}
                 label={`値上げ額（月あたり） ${label}`}
                 value={`${r >= 0 ? '＋' : '−'}${yen(Math.abs(r))}`}
                 sub={`期間合計 ${num(raise) >= 0 ? '＋' : '−'}${yen(Math.abs(num(raise)))}`} />
          );
        })}
        {/* 法人ごとの妥結見通し（想定B基準）で試算した場合。A基準との差も出す */}
        {(() => {
          const bs = num(data.aMonths?.raise_bsim) / months;
          const gap = (num(data.aMonths?.raise_bsim) - num(data.aMonths?.raise_m3)) / months;
          return (
            <Kpi label={`想定B基準（月あたり） ${m3}`}
                 value={`${bs >= 0 ? '＋' : '−'}${yen(Math.abs(bs))}`}
                 sub={`A基準との差 ${gap >= 0 ? '＋' : '−'}${yen(Math.abs(gap))}`
                   + `（決定済み ${num(data.aMonths?.b_rows).toLocaleString()}件）`} />
          );
        })()}
      </div>

      <Card title="器具区分別の値上げ額">
        <AbTable head="器具区分" rows={data.abByEquip ?? []} />
      </Card>

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

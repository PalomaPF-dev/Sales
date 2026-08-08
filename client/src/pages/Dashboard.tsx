import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card } from '../components/ui';
import type { Meta } from '../types';

/** 案件一覧と同じ絞り込みを受ける。集計と一覧を同じ条件で行き来できるようにするため */
const FILTER_KEYS = ['equip', 'person', 'corp', 'branch', 'office', 'aDateYm', 'aDateOp'] as const;

/**
 * 支店別・法人別の値上げ額の集計。
 *   現状額 = 現状の出荷単価 × 数量の合計（値上げしなかった場合）
 *   A基準額 = マスタ登録単価（A基準）前提で、数量を固定したままの月別合計
 *   値上げ額 = A基準額（3か月後） − 現状額
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

/** グラフの目盛り用に金額を短く書く。458億 / 9,240万 / ¥1,234 */
const shortYen = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toLocaleString(undefined, { maximumFractionDigits: 1 })}億`;
  if (a >= 1e4) return `${(v / 1e4).toLocaleString(undefined, { maximumFractionDigits: 0 })}万`;
  return yen(v);
};

/**
 * まとめの棒グラフ。現状額と、A基準の月別（9月・10月・11月）を並べる。
 *
 * 外部の部品を使わず、そのまま描けるSVGで作る（読み込みを増やさないため）。
 * 幅は親に合わせて伸縮する。
 */
function SummaryChart({ bars }: { bars: { label: string; value: number; gain?: number }[] }) {
  const W = 760;
  const H = 250;
  const padT = 46;   // 棒の上に金額と値上げ額を書く分
  const padB = 34;   // 月名を書く分
  const max = Math.max(...bars.map((b) => b.value), 1);
  const bw = W / bars.length;
  const plot = H - padT - padB;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}
         role="img" aria-label="現状額とA基準の比較">
      {/* 現状額の高さに水平線を引き、各月がどれだけ上回るかを見えるようにする */}
      {bars[0] && (() => {
        const y = H - padB - (bars[0].value / max) * plot;
        return <line x1={0} y1={y} x2={W} y2={y} stroke="#cbd5e1" strokeDasharray="4 4" />;
      })()}
      {bars.map((b, i) => {
        const h = (b.value / max) * plot;
        const x = i * bw + bw * 0.2;
        const w = bw * 0.6;
        const y = H - padB - h;
        const first = i === 0;
        return (
          <g key={b.label}>
            <rect x={x} y={y} width={w} height={Math.max(h, 1)} rx={4}
                  fill={first ? '#94a3b8' : '#2563eb'} />
            <text x={x + w / 2} y={y - 8} textAnchor="middle" fontSize={17} fontWeight={700} fill="#0f172a">
              {shortYen(b.value)}
            </text>
            {b.gain != null && b.gain !== 0 && (
              <text x={x + w / 2} y={y - 26} textAnchor="middle" fontSize={14} fontWeight={700}
                    fill={b.gain < 0 ? '#c2410c' : '#15803d'}>
                {b.gain > 0 ? '＋' : '−'}{shortYen(Math.abs(b.gain))}
              </text>
            )}
            <text x={x + w / 2} y={H - 12} textAnchor="middle" fontSize={15} fill="#475569">
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

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

  // 承認日の初期値を入れ終えるまで集計を呼ばない（無駄な1回を避ける）
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api<Meta>('/meta')
      .then((m) => {
        setMeta(m);
        // 既定は「当月以降に承認された単価だけ」。それより前の承認は
        // 値上げ前の古い単価が多く、値上げ額として見ると実態と合わない。
        // 全期間を見たいときは承認日の欄を空にする。
        if (!params.get('aDateYm') && m.aggMeta?.m0) {
          const next = new URLSearchParams(params);
          next.set('aDateYm', m.aggMeta.m0);
          setParams(next, { replace: true });
        }
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!ready) return;
    const qs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (get(k)) qs.set(k, get(k));
    setData(null);
    api<DashboardRes>(`/dashboard?${qs}`).then(setData).catch((e) => setMsg(e.message));
  }, [params, ready]);

  if (msg) return <div className="alert error">{msg}</div>;
  if (!data) return <p style={{ color: 'var(--muted)' }}>読み込み中...</p>;

  const t = data.abTotals;
  const m1 = data.aggMeta?.m1 || '翌月';
  const m2 = data.aggMeta?.m2 || '翌々月';
  const m3 = data.aggMeta?.m3 || '3か月後';
  const months = data.months || 12;
  const offices = meta?.offices.filter((o) => !get('branch') || o.branch === get('branch')) || [];

  const nums = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;

  /** 月のマス。A基準前提の売上と、その下に値上げ額（A基準額−現状額）を出す */
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
            <th style={nums} title="現状の出荷単価（実績の平均）× 数量の合計。値上げしなかった場合の金額">現状額<br /><small>（出荷単価前提）</small></th>
            <th style={nums}>{m1}<br /><small>A基準額 / 値上げ額</small></th>
            <th style={nums}>{m2}<br /><small>A基準額 / 値上げ額</small></th>
            <th style={nums}>{m3}<br /><small>A基準額 / 値上げ額</small></th>
            <th style={nums} title="法人ごとに決めた妥結の見通し（A基準の何%）で試算した場合。決定単価が入っている案件はその単価">
              想定B基準<br /><small>想定額 / 値上げ額</small>
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
        <strong>承認日</strong>は既定で<strong>当月以降に承認された単価だけ</strong>を見ています
        （それより前は値上げ前の古い単価が多いため）。欄を空にすると全期間になります。
        絞り込みでマスタ登録件数と値上げ額が変わります（出荷実績の母数は変わりません）。
        下の表の<strong>現状額</strong>は現状の出荷単価（実績の平均）×数量で、値上げしなかった場合の金額です。
        各月の<strong>A基準額</strong>はA基準前提で数量を固定した月別合計で、その差が値上げ額です。金額は期間全体の合計、月あたりは÷{months}か月。
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
        {/* 当月は値上げ前の単価が多く比較にならないため、翌月（9月）から出す */}
        {([
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

      <Card title={`まとめ（現状額とA基準）${get('aDateYm') ? `　承認日 ${get('aDateYm')} ${get('aDateOp') === 'before' ? 'より前' : '以降'}` : ''}`}>
        <p className="pt-note" style={{ marginTop: 0 }}>
          灰色が<strong>現状額</strong>（値上げしなかった場合）、青が<strong>A基準額</strong>（申請単価どおりの場合）。
          青の上の緑の数字が<strong>値上げ額</strong>（A基準額 − 現状額）です。
          金額は期間全体（{meta?.histMeta?.period ?? ''}）の合計で、数量は実績のまま固定しています。
        </p>
        <SummaryChart bars={[
          { label: '現状額', value: num(t?.base_amt) },
          { label: m1, value: num(t?.a1_amt), gain: num(t?.a1_amt) - num(t?.base_amt) },
          { label: m2, value: num(t?.a2_amt), gain: num(t?.a2_amt) - num(t?.base_amt) },
          { label: m3, value: num(t?.a3_amt), gain: num(t?.a3_amt) - num(t?.base_amt) },
        ]} />
      </Card>

      <Card title="器具区分別の値上げ額">
        <AbTable head="器具区分" rows={data.abByEquip ?? []} />
      </Card>

      <Card title="支店別の値上げ額">
        <AbTable head="支店" rows={data.abByBranch ?? []} />
      </Card>

      <Card title="営業所別の値上げ額">
        <AbTable head="営業所" rows={data.abByOffice ?? []} withBranch />
      </Card>

      <Card title="法人別の値上げ額（現状額の上位30）">
        <AbTable head="法人" rows={data.abByCorp ?? []} />
      </Card>
    </div>
  );
}

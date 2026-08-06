import { useEffect, useMemo, useState } from 'react';
import { api, yen } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';
import type { Meta } from '../types';

/** サーバーが返すグループごとの集計（単価×数量の合計） */
interface SimRow {
  name: string | null;
  deals: number;
  qty: number;
  base_amt: number;      // 過去実績（出荷単価×数量）
  a1_amt: number;
  a2_amt: number;
  a3_amt: number;
  b_rows: number;
  b_qty: number;
  b_amt: number;         // B入力分（B×数量）
  a3_amt_nob: number;    // B未入力分のA売上（想定に使う）
  cost_amt?: number;     // 管理者のみ
  cost_qty?: number;
}

const GROUPS = [
  { key: 'equip', label: '器具区分ごと' },
  { key: 'corp', label: '法人ごと' },
  { key: 'branch', label: '支店ごと' },
];

const num = (v: unknown) => Number(v ?? 0);

/**
 * A基準とB基準のシミュレーション。
 *
 * 過去実績（出荷単価×数量）を土台に、
 * ・販売数量の増減（販売計画）
 * ・B未入力の行の想定（A基準の何%で妥結するか）
 * を動かして、A基準どおりの場合とB基準（実績＋想定）の売上の差を試算する。
 */
export default function Simulation() {
  const me = useUser();
  const [group, setGroup] = useState('equip');
  const [rows, setRows] = useState<SimRow[]>([]);
  const [withCost, setWithCost] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [adj, setAdj] = useState('0');       // 販売数量の増減（%）
  const [assume, setAssume] = useState('100'); // B未入力の想定（Aの%）
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch(() => {});
  }, []);
  useEffect(() => {
    api<{ rows: SimRow[]; withCost: boolean }>(`/simulation?group=${group}`)
      .then((r) => { setRows(r.rows); setWithCost(r.withCost); })
      .catch((e) => setMsg(e.message));
  }, [group]);

  const adjRate = 1 + (Number(adj) || 0) / 100;
  const assumeRate = (Number(assume) || 0) / 100;

  const calc = useMemo(() => rows.map((r) => {
    const aSales = num(r.a3_amt) * adjRate;
    const bSales = (num(r.b_amt) + num(r.a3_amt_nob) * assumeRate) * adjRate;
    return {
      name: r.name || '—',
      deals: num(r.deals),
      qty: num(r.qty) * adjRate,
      baseSales: num(r.base_amt) * adjRate,
      aSales,
      bSales,
      diff: bSales - aSales,
      aAvg: num(r.qty) > 0 ? num(r.a3_amt) / num(r.qty) : null,
      bAvg: num(r.b_qty) > 0 ? num(r.b_amt) / num(r.b_qty) : null,
      bRate: num(r.deals) > 0 ? Math.round((num(r.b_rows) / num(r.deals)) * 1000) / 10 : 0,
      grossA: withCost && r.cost_amt != null ? (num(r.a3_amt) - num(r.cost_amt)) * adjRate : null,
      grossB: withCost && r.cost_amt != null
        ? (num(r.b_amt) + num(r.a3_amt_nob) * assumeRate - num(r.cost_amt)) * adjRate : null,
    };
  }), [rows, adjRate, assumeRate, withCost]);

  const total = useMemo(() => calc.reduce((t, r) => ({
    deals: t.deals + r.deals, qty: t.qty + r.qty, baseSales: t.baseSales + r.baseSales,
    aSales: t.aSales + r.aSales, bSales: t.bSales + r.bSales, diff: t.diff + r.diff,
  }), { deals: 0, qty: 0, baseSales: 0, aSales: 0, bSales: 0, diff: 0 }), [calc]);

  const m3 = meta?.aggMeta?.m3 || '3か月後';

  return (
    <div>
      <h1 className="page-title">シミュレーション（A基準 → B基準）</h1>
      <p className="page-sub">
        過去実績の数量をもとに、A基準（{m3} の申請単価）どおりの売上と、
        B基準（実際の決定単価。未入力の行は下の想定で補う）の売上を試算します。
        販売計画の増減と妥結の想定を動かして、どのくらい変わるのかを確かめられます。
      </p>
      {msg && <div className="alert error" onClick={() => setMsg('')}>{msg}</div>}

      <div className="filters">
        <label className="fld">
          集計の単位
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            {GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </label>
        <label className="fld">
          販売数量の増減（%）
          <input type="number" value={adj} step="5"
            onChange={(e) => setAdj(e.target.value)} style={{ width: 110 }} />
        </label>
        <label className="fld">
          B未入力の想定（Aの%）
          <input type="number" value={assume} step="1"
            onChange={(e) => setAssume(e.target.value)} style={{ width: 110 }} />
        </label>
      </div>

      <Card title={`試算結果（${GROUPS.find((g) => g.key === group)?.label}）`}>
        <p className="pt-note" style={{ marginTop: 0 }}>
          売上 = 単価 × 数量の合計 ×（1 + 増減%）。
          B想定売上は、決定済みの行はB基準、未入力の行は「A基準 × 想定%」で計算しています。
          {withCost && ' 粗利は実績原価を引いた概算です（管理者のみ表示）。'}
        </p>
        <div className="tbl-scroll" style={{ maxHeight: 480 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{GROUPS.find((g) => g.key === group)?.label.replace('ごと', '')}</th>
                <th style={{ textAlign: 'right' }}>数量</th>
                <th style={{ textAlign: 'right' }}>過去実績売上</th>
                <th style={{ textAlign: 'right' }}>A基準売上</th>
                <th style={{ textAlign: 'right' }}>B想定売上</th>
                <th style={{ textAlign: 'right' }}>差（B−A）</th>
                <th style={{ textAlign: 'right' }}>A加重平均</th>
                <th style={{ textAlign: 'right' }}>B加重平均（入力分）</th>
                <th style={{ textAlign: 'right' }}>B入力率</th>
                {withCost && <th style={{ textAlign: 'right' }}>A粗利（概算）</th>}
                {withCost && <th style={{ textAlign: 'right' }}>B粗利（概算）</th>}
              </tr>
            </thead>
            <tbody>
              {calc.map((r, i) => (
                <tr key={i}>
                  <td>{r.name}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(r.qty).toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>¥{yen(r.baseSales)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>¥{yen(r.aSales)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>¥{yen(r.bSales)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                               color: r.diff < 0 ? '#c2410c' : r.diff > 0 ? '#15803d' : undefined }}>
                    {r.diff === 0 ? '—' : `${r.diff > 0 ? '＋' : '−'}¥${yen(Math.abs(r.diff))}`}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.aAvg == null ? '—' : `¥${yen(r.aAvg)}`}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.bAvg == null ? '未入力' : `¥${yen(r.bAvg)}`}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.bRate}%</td>
                  {withCost && <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.grossA == null ? '—' : `¥${yen(r.grossA)}`}</td>}
                  {withCost && <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.grossB == null ? '—' : `¥${yen(r.grossB)}`}</td>}
                </tr>
              ))}
              {calc.length > 1 && (
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--grid)' }}>
                  <td>合計</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(total.qty).toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>¥{yen(total.baseSales)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>¥{yen(total.aSales)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>¥{yen(total.bSales)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                               color: total.diff < 0 ? '#c2410c' : total.diff > 0 ? '#15803d' : undefined }}>
                    {total.diff === 0 ? '—' : `${total.diff > 0 ? '＋' : '−'}¥${yen(Math.abs(total.diff))}`}
                  </td>
                  <td colSpan={withCost ? 5 : 3} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {me.role === 'sales' || me.role === 'branch_manager' ? (
          <p className="pt-note">このページは営業企画・管理者向けです。</p>
        ) : null}
      </Card>
    </div>
  );
}

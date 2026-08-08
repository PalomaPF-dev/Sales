import { useEffect, useMemo, useState } from 'react';
import { api, yen } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';
import type { Meta } from '../types';

/** サーバーが返すグループごとの集計（単価×数量の合計） */
interface SimRow {
  name: string | null;
  corp_code?: string | null;   // 法人ごとの表のとき
  plan_rate?: number | null;   // 保存してある想定B基準（A基準に対する%）
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
  { key: 'corp_equip', label: '法人×器具区分ごと' },
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
  // 法人の選択。選ぶとその法人の中だけを器具区分ごとに出し、
  // 器具区分ごとの増減%をその法人向けの販売計画として設定できる
  const [corp, setCorp] = useState('');
  const [rows, setRows] = useState<SimRow[]>([]);
  const [withCost, setWithCost] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [adj, setAdj] = useState('0');       // 販売数量の増減（%）全体の初期値
  const [assume, setAssume] = useState('100'); // B未入力の想定（Aの%）
  // グループ（法人・器具区分・支店・法人×器具区分）ごとの増減%。空欄は全体の%に従う
  const [rowAdj, setRowAdj] = useState<Record<string, string>>({});
  // 表示の絞り込み（法人×器具区分は数万グループになるため）。合計は全グループ分のまま
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  // 想定B基準（A基準に対する%）。保存するとダッシュボードの試算にも反映される
  const [planDraft, setPlanDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch(() => {});
  }, []);
  useEffect(() => {
    const qs = new URLSearchParams({ group: corp ? 'equip' : group });
    if (corp) qs.set('corp', corp);
    api<{ rows: SimRow[]; withCost: boolean }>(`/simulation?${qs}`)
      .then((r) => {
        setRows(r.rows); setWithCost(r.withCost); setRowAdj({}); setQ('');
        // 保存済みの想定B基準を入力欄の初期値にする
        const d: Record<string, string> = {};
        for (const x of r.rows) if (x.plan_rate != null) d[x.name ?? ''] = String(x.plan_rate);
        setPlanDraft(d);
      })
      .catch((e) => setMsg(e.message));
  }, [group, corp]);

  // 想定B基準を入れられるのは、法人の中の器具区分ごと（法人を選択中）か、法人ごとの表
  const canPlan = Boolean(corp) || group === 'corp';

  /** 想定B基準を保存する。ダッシュボードの試算にもそのまま効く */
  const savePlans = async () => {
    setSaving(true);
    setMsg('');
    try {
      const items = rows.map((r) => ({
        corp_code: corp || r.corp_code || '',
        equip_name: corp ? (r.name ?? '') : '',
        b_rate: (planDraft[r.name ?? ''] ?? '').trim(),
      })).filter((x) => x.corp_code);
      const res = await api<{ saved: number; removed: number }>('/corp-plans', {
        method: 'PUT', body: JSON.stringify({ items }),
      });
      setMsg(`想定B基準を保存しました（設定 ${res.saved}件${res.removed ? ` ・ 解除 ${res.removed}件` : ''}）。`
        + 'ダッシュボードの「想定B基準」に反映されます');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const assumeRate = (Number(assume) || 0) / 100;

  const calc = useMemo(() => rows.map((r) => {
    // 増減%は、そのグループに個別の値があればそれを、無ければ全体の値を使う
    const own = (rowAdj[r.name ?? ''] ?? '').trim();
    const adjRate = 1 + (Number(own === '' ? adj : own) || 0) / 100;
    // 想定B基準も、そのグループに入っていればそれを、無ければ全体の想定%を使う
    const plan = (planDraft[r.name ?? ''] ?? '').trim();
    const bRate = plan === '' ? assumeRate : (Number(plan) || 0) / 100;
    const aSales = num(r.a3_amt) * adjRate;
    const bSales = (num(r.b_amt) + num(r.a3_amt_nob) * bRate) * adjRate;
    return {
      name: r.name || '—',
      ownAdj: own,
      ownPlan: plan,
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
        ? (num(r.b_amt) + num(r.a3_amt_nob) * bRate - num(r.cost_amt)) * adjRate : null,
    };
  }), [rows, adj, rowAdj, planDraft, assumeRate, withCost]);

  const total = useMemo(() => calc.reduce((t, r) => ({
    deals: t.deals + r.deals, qty: t.qty + r.qty, baseSales: t.baseSales + r.baseSales,
    aSales: t.aSales + r.aSales, bSales: t.bSales + r.bSales, diff: t.diff + r.diff,
  }), { deals: 0, qty: 0, baseSales: 0, aSales: 0, bSales: 0, diff: 0 }), [calc]);

  // 法人ごと・法人×器具区分は数千〜数万グループになるため、表示は数量上位に絞る
  // （合計は全グループ分のまま）。名前の絞り込みで目的の法人・器具を出せる
  const DISPLAY_MAX = 300;
  const filtered = q.trim() ? calc.filter((r) => r.name.includes(q.trim())) : calc;
  const shown = filtered.slice(0, DISPLAY_MAX);

  const m3 = meta?.aggMeta?.m3 || '3か月後';
  const corpName = meta?.corps.find((c) => c.code === corp)?.name ?? '';
  // 法人を選んでいる間は、その法人の中の器具区分ごとの表になる
  const unitLabel = corp ? `${corpName} の器具区分ごと`
    : GROUPS.find((g) => g.key === group)?.label ?? '';
  const rowLabel = corp ? '器具区分'
    : GROUPS.find((g) => g.key === group)?.label.replace('ごと', '') ?? '';

  return (
    <div>
      <h1 className="page-title">シミュレーション（A基準 → B基準）</h1>
      <p className="page-sub">
        過去実績の数量をもとに、A基準（{m3} の申請単価）どおりの売上と、
        B基準（実際の決定単価。未入力の行は下の想定で補う）の売上を試算します。
        <strong>法人を選ぶと、その法人の中を器具区分ごとに</strong>販売計画の増減を設定して試算できます
        （法人の中では器具ごとに単価が決まるため）。
      </p>
      {msg && (
        <div className={`alert ${msg.includes('保存しました') ? 'ok' : 'error'}`}
             onClick={() => setMsg('')}>{msg}</div>
      )}

      <div className="filters">
        <label className="fld" title="法人を選ぶと、その法人の中を器具区分ごとに出します">
          法人
          <select value={corp} onChange={(e) => setCorp(e.target.value)}>
            <option value="">全体（下の単位で集計）</option>
            {meta?.corps.map((c) => (
              <option key={c.code} value={c.code}>{c.name}（{c.count.toLocaleString()}）</option>
            ))}
          </select>
        </label>
        <label className="fld">
          集計の単位
          <select value={group} onChange={(e) => setGroup(e.target.value)} disabled={Boolean(corp)}>
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
        <label className="fld" style={{ minWidth: 220, flex: '1 1 220px' }}>
          表示の絞り込み（法人名・器具区分）
          <input type="text" value={q} placeholder="例: 東京ガス ／ ビルトイン"
            onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      <Card title={`試算結果（${unitLabel}）`}>
        <p className="pt-note" style={{ marginTop: 0 }}>
          売上 = 単価 × 数量の合計 ×（1 + 増減%）。
          <strong>増減%の欄に入れると、その{rowLabel}だけ販売計画を変えて試算できます</strong>（空欄は上の全体の%に従います）。
          {corp && ' 法人を選んでいるので、増減%はこの法人の器具区分ごとの販売計画になります。'}
          {canPlan && (
            <>
              {' '}
              <strong>想定B%</strong>は「A基準の何%で妥結する見込みか」です。保存すると
              ダッシュボードの「想定B基準」の列・タイルに反映され、A基準どおりの場合との差が見られます。
            </>
          )}
          B想定売上は、決定済みの行はB基準、未入力の行は「A基準 × 想定%」で計算しています。
          {withCost && ' 粗利は実績原価を引いた概算です（管理者のみ表示）。'}
          {calc.length > shown.length && ` 表示は数量上位${DISPLAY_MAX}グループまで（合計は全グループ分）。`}
        </p>
        <div className="tbl-scroll" style={{ maxHeight: 480 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{rowLabel}</th>
                <th style={{ textAlign: 'right' }} title="このグループだけの増減%。空欄は上の全体の%に従います">増減%</th>
                {canPlan && (
                  <th style={{ textAlign: 'right' }}
                      title="A基準の何%で妥結する見込みか。保存するとダッシュボードの「想定B基準」に反映されます">
                    想定B%<br /><small>（保存）</small>
                  </th>
                )}
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
              {shown.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td style={{ textAlign: 'right' }}>
                    <input
                      type="number" className="cell" placeholder={adj || '0'}
                      value={r.ownAdj}
                      onChange={(e) => setRowAdj((prev) => ({ ...prev, [r.name]: e.target.value }))}
                      style={{ width: 64, textAlign: 'right' }}
                    />
                  </td>
                  {canPlan && (
                    <td style={{ textAlign: 'right' }}>
                      <input
                        type="number" className="cell" placeholder={assume || '100'}
                        value={r.ownPlan}
                        onChange={(e) => setPlanDraft((prev) => ({ ...prev, [r.name]: e.target.value }))}
                        style={{ width: 64, textAlign: 'right' }}
                      />
                    </td>
                  )}
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
                  <td>合計{calc.length > shown.length && <small style={{ fontWeight: 400 }}>（全{calc.length.toLocaleString()}グループ分）</small>}</td>
                  <td />
                  {canPlan && <td />}
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
        {canPlan && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" onClick={savePlans} disabled={saving}>
              {saving ? '保存中...' : '想定B基準を保存（ダッシュボードに反映）'}
            </button>
            <span className="pt-note" style={{ margin: 0 }}>
              空欄にして保存すると、その{rowLabel}の想定は解除されます（A基準どおりに戻ります）。
            </span>
          </div>
        )}
        {me.role === 'sales' || me.role === 'branch_manager' ? (
          <p className="pt-note">このページは営業企画・管理者向けです。</p>
        ) : null}
      </Card>
    </div>
  );
}

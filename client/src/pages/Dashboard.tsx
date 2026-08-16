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
  abByCorp?: AbRow[];
  months?: number;
  aggMeta?: { m0?: string; m1: string; m2: string; m3: string; basePeriod: string } | null;
}

const num = (n: unknown) => Number(n ?? 0);
const yen = (v: number) => `¥${Math.round(v).toLocaleString()}`;

const nums = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;

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

/**
 * 金額のマス。すべて1か月あたりで出す（期間合計は出さない）。
 * base を渡すと、その月の値上げ額と、現状額に対する値上げ率も添える。
 */
function AmtCell({ amt, base, months }: { amt: number; base?: number; months: number }) {
  const gain = base == null ? null : amt - base;
  const rate = base != null && base > 0 ? Math.round((gain! / base) * 1000) / 10 : null;
  return (
    <td style={nums}>
      {yen(amt / months)}
      {gain != null && (
        <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2,
                      color: gain < 0 ? '#c2410c' : gain > 0 ? '#15803d' : 'var(--muted)' }}>
          {gain === 0 ? '—' : `${gain > 0 ? '＋' : '−'}${yen(Math.abs(gain) / months)}`}
          {rate != null && gain !== 0 && (
            <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
              {' '}({rate > 0 ? '+' : ''}{rate}%)
            </span>
          )}
        </div>
      )}
    </td>
  );
}

// 集計表の並び替えの対象。月の列は「その月の値上げ額（A基準額−現状額）」で並べる
// （A基準額そのものだと規模の大きい区分が常に上に来て、値上げの大小が見えないため）
type SortCol = 'name' | 'deals' | 'qty' | 'base' | 'a1' | 'a2' | 'a3' | 'bsim';

function sortValue(r: AbRow, col: SortCol): number | string {
  switch (col) {
    case 'name': return r.name ?? '';
    case 'deals': return num(r.deals);
    case 'qty': return num(r.qty);
    case 'base': return num(r.base_amt);
    case 'a1': return num(r.a1_amt) - num(r.base_amt);
    case 'a2': return num(r.a2_amt) - num(r.base_amt);
    case 'a3': return num(r.a3_amt) - num(r.base_amt);
    case 'bsim': return num(r.bsim_amt) - num(r.base_amt);
  }
}

/**
 * 集計表。器具区分別・支店別・法人別で同じ形を使う。
 * 金額はすべて1か月あたり。各月は「A基準額 / 値上げ額（値上げ率）」の順に出す。
 * 見出しを押すとその列で並び替える（合計の行は常に一番下に置く）。
 */
function AbTable({ head, rows, total, months, m1, m2, m3 }: {
  head: string; rows: AbRow[]; total?: AbRow;
  months: number; m1: string; m2: string; m3: string;
}) {
  // 未指定のときはサーバーの並び（現状額の大きい順）のまま
  const [sort, setSort] = useState<{ col: SortCol; desc: boolean } | null>(null);

  // 金額や件数は大きい順から、名前は読みの順から始める。
  // 同じ見出しを押すたびに 逆順 → 解除（既定の並び）に戻る。
  const toggleSort = (col: SortCol) => {
    const firstDesc = col !== 'name';
    if (!sort || sort.col !== col) setSort({ col, desc: firstDesc });
    else if (sort.desc === firstDesc) setSort({ col, desc: !firstDesc });
    else setSort(null);
  };

  const sorted = [...rows];
  if (sort) {
    sorted.sort((a, b) => {
      const va = sortValue(a, sort.col);
      const vb = sortValue(b, sort.col);
      const c = typeof va === 'string' || typeof vb === 'string'
        ? String(va).localeCompare(String(vb), 'ja')
        : va - vb;
      return sort.desc ? -c : c;
    });
  }

  /** 並び替えできる見出し。案件一覧と同じ見た目（矢印つき） */
  const Th = ({ col, right, title, children }: {
    col: SortCol; right?: boolean; title?: string; children: React.ReactNode;
  }) => {
    const on = sort != null && sort.col === col;
    const mark = !on || sort == null ? '' : sort.desc ? '▼' : '▲';
    return (
      <th className={`sortable${on ? ' sorted' : ''}`}
          style={right ? nums : undefined}
          onClick={() => toggleSort(col)}
          title={`${title ? `${title}。` : ''}押すと並び替えます（もう一度で逆順、3回目で元の並び）`}>
        {children}<span className="sort-mark">{mark}</span>
      </th>
    );
  };

  return (
    <div className="tbl-scroll" style={{ maxHeight: 460 }}>
      <table className="tbl">
        <thead>
          <tr>
            <Th col="name">{head}</Th>
            <Th col="deals" right>件数</Th>
            <Th col="qty" right title={`期間全体の合計と、1か月あたり（÷${months}か月）`}>
              数量<br /><small>合計 / 月平均</small>
            </Th>
            <Th col="base" right title="現状の出荷単価（実績の平均）× 数量。値上げしなかった場合の金額（1か月あたり）">
              現状額<br /><small>月あたり</small>
            </Th>
            <Th col="a1" right title={`${m1}の値上げ額で並びます`}>{m1}<br /><small>A基準額 / 値上げ額（率）</small></Th>
            <Th col="a2" right title={`${m2}の値上げ額で並びます`}>{m2}<br /><small>A基準額 / 値上げ額（率）</small></Th>
            <Th col="a3" right title={`${m3}の値上げ額で並びます`}>{m3}<br /><small>A基準額 / 値上げ額（率）</small></Th>
            <Th col="bsim" right
                title="法人ごとに決めた妥結の見通し（A基準の何%）で試算した場合。決定単価が入っている案件はその単価。想定の値上げ額で並びます">
              想定B基準<br /><small>想定額 / 値上げ額（率）</small>
            </Th>
          </tr>
        </thead>
        <tbody>
          {[...sorted, ...(total ? [{ ...total, name: '合計' }] : [])].map((r, i) => {
            const last = i === sorted.length;
            const base = num(r.base_amt);
            return (
              <tr key={i} style={last ? { fontWeight: 700, borderTop: '2px solid var(--grid)' } : undefined}>
                <td>{r.name || '—'}</td>
                <td style={nums}>{num(r.deals).toLocaleString()}</td>
                <td style={nums}>
                  {num(r.qty).toLocaleString()}
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    月{(num(r.qty) / months).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </div>
                </td>
                <AmtCell amt={base} months={months} />
                <AmtCell amt={num(r.a1_amt)} base={base} months={months} />
                <AmtCell amt={num(r.a2_amt)} base={base} months={months} />
                <AmtCell amt={num(r.a3_amt)} base={base} months={months} />
                <AmtCell amt={num(r.bsim_amt)} base={base} months={months} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<DashboardRes | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [msg, setMsg] = useState('');

  const get = (k: string) => params.get(k) || '';
  /**
   * 絞り込みを書き換える。複数まとめて渡せるようにしてある。
   * 1つずつ呼ぶと、2回目が1回目より前の状態から作り直してしまい、
   * 先の変更が消える（支店を選ぶと同時に営業所を空にする場合など）。
   */
  const setMany = (updates: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  const setParam = (key: string, value: string) => setMany({ [key]: value });

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

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>ダッシュボード</h1>
        {/* いま見えている条件のまま、下の表をExcelにする */}
        <button
          className="btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            const qs = new URLSearchParams();
            for (const k of FILTER_KEYS) if (get(k)) qs.set(k, get(k));
            window.location.href = `/api/dashboard/export?${qs}`;
          }}
        >
          Excel出力
        </button>
      </div>
      <p className="page-sub">
        出荷実績（{meta?.histMeta?.period ?? '期間全体'}）の<strong>純粋な品目件数</strong>を母数に、
        マスタ登録（A基準）の件数と、月ごとの<strong>値上げ額</strong>（(A基準−実績の平均出荷単価)×数量）を出します。
        <strong>承認日</strong>は既定で<strong>当月以降に承認された単価だけ</strong>を見ています
        （それより前は値上げ前の古い単価が多いため）。欄を空にすると全期間になります。
        絞り込みでマスタ登録件数と値上げ額が変わります（出荷実績の母数は変わりません）。
        下の表の<strong>現状額</strong>は現状の出荷単価（実績の平均）×数量で、値上げしなかった場合の金額です。
        各月の<strong>A基準額</strong>はA基準前提で数量を固定した金額で、その差が値上げ額、
        現状額に対する割合が<strong>値上げ率</strong>です。
        金額はすべて<strong>1か月あたり</strong>（期間全体の合計 ÷ {months}か月）です。
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
          <select value={get('branch')} onChange={(e) => setMany({ branch: e.target.value, office: '' })}>
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
          // 現状額に対して何%の値上げになるか
          const base = num(t?.base_amt);
          const rate = base > 0 ? Math.round((num(raise) / base) * 1000) / 10 : null;
          return (
            <Kpi key={label}
                 label={`値上げ額（月あたり） ${label}`}
                 value={`${r >= 0 ? '＋' : '−'}${yen(Math.abs(r))}`}
                 sub={rate == null ? undefined : `現状額に対して ${rate > 0 ? '+' : ''}${rate}%`} />
          );
        })}
      </div>

      <Card title={`まとめ（現状額とA基準）${get('aDateYm') ? `　承認日 ${get('aDateYm')} ${get('aDateOp') === 'before' ? 'より前' : '以降'}` : ''}`}>
        <p className="pt-note" style={{ marginTop: 0 }}>
          <strong>現状額</strong>は値上げしなかった場合、<strong>A基準額</strong>は申請単価どおりの場合、
          その差が<strong>値上げ額</strong>で、現状額に対する割合が<strong>値上げ率</strong>です。
          金額はすべて<strong>1か月あたり</strong>（期間全体〈{meta?.histMeta?.period ?? ''}〉の合計 ÷ {months}か月）、
          数量は実績のまま固定しています。
        </p>
        <table className="tbl">
          <thead>
            <tr>
              <th>月</th>
              <th style={nums}>現状額<br /><small>月あたり</small></th>
              <th style={nums}>A基準額<br /><small>月あたり</small></th>
              <th style={nums}>値上げ額<br /><small>月あたり</small></th>
              <th style={nums} title="値上げ額 ÷ 現状額">値上げ率</th>
            </tr>
          </thead>
          <tbody>
            {([[m1, num(t?.a1_amt)], [m2, num(t?.a2_amt)], [m3, num(t?.a3_amt)]] as [string, number][])
              .map(([label, amt]) => {
                const base = num(t?.base_amt);
                const gain = amt - base;
                const rate = base > 0 ? Math.round((gain / base) * 1000) / 10 : null;
                return (
                  <tr key={label}>
                    <td><strong>{label}</strong></td>
                    <td style={nums}>{yen(base / months)}</td>
                    <td style={nums}>{yen(amt / months)}</td>
                    <td style={{ ...nums, fontWeight: 700,
                                 color: gain < 0 ? '#c2410c' : gain > 0 ? '#15803d' : undefined }}>
                      {gain === 0 ? '—' : `${gain > 0 ? '＋' : '−'}${yen(Math.abs(gain) / months)}`}
                    </td>
                    <td style={nums}>{rate == null ? '—' : `${rate > 0 ? '+' : ''}${rate}%`}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Card>

      <Card title="器具区分別の値上げ額">
        <AbTable head="器具区分" rows={data.abByEquip ?? []} total={t} months={months} m1={m1} m2={m2} m3={m3} />
      </Card>

      <Card title="支店別の値上げ額">
        <AbTable head="支店" rows={data.abByBranch ?? []} total={t} months={months} m1={m1} m2={m2} m3={m3} />
      </Card>

      <Card title="法人別の値上げ額（現状額の上位30）">
        <AbTable head="法人" rows={data.abByCorp ?? []} total={t} months={months} m1={m1} m2={m2} m3={m3} />
      </Card>
    </div>
  );
}

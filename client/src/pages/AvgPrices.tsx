import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import SearchBox from '../components/SearchBox';
import HScroll from '../components/HScroll';
import { api } from '../api';
import { Card, NoteFold, num, nums } from '../components/ui';
import { BASE_OPTIONS, FILTER_KEYS, RAISE_START_YM, narrowByParent } from '../filterOptions';
import type { Meta } from '../types';

/** 内訳のまとめ方。値上げ額の内訳と同じ3つ */
const TABS = [
  { key: 'equip' as const, label: '器具区分別', head: '器具区分' },
  { key: 'branch' as const, label: '支店別', head: '支店' },
  { key: 'corp' as const, label: '法人別', head: '法人' },
];
type Group = typeof TABS[number]['key'];

/** 平均単価の集計1件ぶん（全体の合計にも、内訳の1行にも同じ形を使う） */
interface AvgRow {
  name?: string | null;
  /** avg_cnt / avg_qty / avg_base / avg_plan_m0… の集計値 */
  [key: string]: string | number | null | undefined;
}

interface AvgRes {
  aMonths: AvgRow;
  rows: AvgRow[];
  aggMeta?: { m0?: string; m1?: string; m2?: string; m3?: string };
}

/**
 * 対象の件数・出荷数と、基準（比較のもと）の加重平均。
 * 単価×実績数の合計 ÷ 実績数の合計。どの月も同じ品目・同じ数量で比べる。
 */
function baseOf(r: AvgRow | null | undefined) {
  const qty = num(r?.avg_qty);
  if (!(qty > 0)) return null;
  return { cnt: num(r?.avg_cnt), qty, base: num(r?.avg_base) / qty };
}

/** その月の計画の加重平均と、基準からの上がり幅 */
function planOf(r: AvgRow | null | undefined, n: number) {
  const b = baseOf(r);
  if (!b) return null;
  const plan = num(r?.[`avg_plan_m${n}`]) / b.qty;
  return { ...b, plan, diff: plan - b.base };
}

const unitYen = (v: number) => `¥${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** 計画の1マス。計画の平均単価と、基準からの上がり幅を重ねて出す */
function AvgCell({ v }: { v: ReturnType<typeof planOf> }) {
  if (!v) return <td style={nums}>—</td>;
  const rate = v.base > 0 ? Math.round((v.diff / v.base) * 1000) / 10 : null;
  return (
    <td style={nums}>
      <div style={{ fontWeight: 700 }}>{unitYen(v.plan)}</div>
      <div className="sub" style={{ fontWeight: 700,
                                    color: v.diff < 0 ? '#c2410c' : v.diff > 0 ? '#15803d' : undefined }}>
        {Math.abs(v.diff) < 0.5 ? '±0'
          : `${v.diff > 0 ? '＋' : '−'}${unitYen(Math.abs(v.diff))}`}
        {rate != null && Math.abs(v.diff) >= 0.5 && `（${rate > 0 ? '+' : ''}${rate}%）`}
      </div>
    </td>
  );
}

/**
 * 平均単価の散布（ダンベル）図。
 *
 * 縦軸を単価にして、内訳（法人・支店・器具区分）ごとに
 * 「基準の平均単価 → その月の計画の平均単価」を1本ずつ並べる。
 * どこが高くてどこが安いか、どれだけ上がるかを一目で見比べるためのもの。
 *
 * 棒ではなく点で描く。単価は0から数える量ではないので、
 * 0を含めない目盛りにしても読み違えない形にしている。
 */
function AvgChart({ rows, monthIdx, monthLabel, baseName, total }: {
  rows: AvgRow[];
  monthIdx: number;
  monthLabel: string;
  baseName: string;
  /** 内訳の全件数（表示を上位に絞ったときに、隠した数を伝えるため） */
  total: number;
}) {
  // 描く点の値を先に取り出す。基準か計画のどちらかが無い内訳は描けない
  const pts = rows
    .map((r) => {
      const v = planOf(r, monthIdx);
      return v ? { name: String(r.name ?? '—'), base: v.base, plan: v.plan, qty: v.qty } : null;
    })
    .filter((v): v is NonNullable<typeof v> => v != null);

  if (pts.length === 0) {
    return <p className="pt-note" style={{ margin: 0 }}>グラフに出せる内訳がありません。</p>;
  }

  // 目盛り。単価は0から数える量ではないので、値の範囲に合わせて上下に少し余白を取る
  const vals = pts.flatMap((p) => [p.base, p.plan]);
  const lo0 = Math.min(...vals);
  const hi0 = Math.max(...vals);
  const pad = Math.max((hi0 - lo0) * 0.12, hi0 * 0.02, 1);
  const lo = Math.max(0, lo0 - pad);
  const hi = hi0 + pad;
  const TICKS = 5;
  const ticks = Array.from({ length: TICKS }, (_, i) => lo + ((hi - lo) * i) / (TICKS - 1));

  // 1件ぶんの幅と、図全体の大きさ。
  // 件数が少ないときは幅いっぱいに広げ、多いときは横スクロールにする
  const PAD_L = 78;
  const PAD_R = 18;
  const PAD_T = 14;
  const PLOT_H = 300;
  const PAD_B = 104;            // 斜めに倒した内訳名のぶん
  const SLOT_MIN = 52;
  const FIT_W = 1020;           // だいたいこの幅までは広げて使う
  const SLOT = Math.max(SLOT_MIN,
    Math.min(120, (FIT_W - PAD_L - PAD_R) / pts.length));
  const w = PAD_L + pts.length * SLOT + PAD_R;
  const h = PAD_T + PLOT_H + PAD_B;
  const y = (v: number) => PAD_T + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;
  const x = (i: number) => PAD_L + i * SLOT + SLOT / 2;

  // 値を書き添えるのは、いちばん高い所と安い所だけ（全部に付けると読めなくなる）
  const hiAt = pts.reduce((b, p, i) => (p.plan > pts[b].plan ? i : b), 0);
  const loAt0 = pts.reduce((b, p, i) => (p.plan < pts[b].plan ? i : b), 0);
  // 端の値が同じなら1つだけにする（同じ数字が2つ並ぶと読み手が迷う）
  const loAt = pts[loAt0].plan === pts[hiAt].plan ? hiAt : loAt0;

  const yen = (v: number) => `¥${Math.round(v).toLocaleString()}`;
  const short = (s: string) => (s.length > 11 ? `${s.slice(0, 10)}…` : s);

  return (
    <>
      {/* 2つの点が何を指すかは、色だけに頼らず必ず凡例で示す */}
      <div className="chart-legend">
        <span><i style={{ background: 'var(--viz-base)' }} />基準（{baseName}）</span>
        <span><i style={{ background: 'var(--viz-plan)' }} />{monthLabel} の計画</span>
        <span className="note">縦軸は単価。0から始まっていません</span>
      </div>
      <HScroll className="tbl-scroll">
        <svg className="avgchart" width={w} height={h} role="img"
             aria-label={`内訳ごとの平均単価（${baseName} と ${monthLabel} の計画）`}>
          {/* 目盛り。細い実線で、読み取りの邪魔にならない濃さにする */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L - 6} y1={y(t)} x2={w - PAD_R} y2={y(t)} className="grid" />
              <text x={PAD_L - 10} y={y(t) + 4} className="ytick">{yen(t)}</text>
            </g>
          ))}
          {pts.map((p, i) => {
            const up = p.plan >= p.base;
            return (
              <g key={`${p.name}-${i}`} className="mark">
                {/* 基準から計画への動き */}
                <line x1={x(i)} y1={y(p.base)} x2={x(i)} y2={y(p.plan)} className="conn" />
                <circle cx={x(i)} cy={y(p.base)} r="5" className="dot base" />
                <circle cx={x(i)} cy={y(p.plan)} r="5" className="dot plan" />
                {/* 高い所・安い所だけ値を書く */}
                {(i === hiAt || i === loAt) && (
                  <text x={x(i)} y={y(p.plan) - 12} className="vlabel">{yen(p.plan)}</text>
                )}
                {/* 内訳名。長いものは省略し、全体はカーソルを合わせると出す */}
                <text x={x(i)} y={PAD_T + PLOT_H + 12}
                      className="xlabel" transform={`rotate(-45 ${x(i)} ${PAD_T + PLOT_H + 12})`}>
                  {short(p.name)}
                </text>
                {/* 点より広い当たり判定。カーソルを合わせると中身が出る */}
                <rect x={x(i) - SLOT / 2} y={PAD_T} width={SLOT} height={PLOT_H} className="hit">
                  <title>
                    {`${p.name}\n基準（${baseName}）: ${yen(p.base)}\n`
                      + `${monthLabel} の計画: ${yen(p.plan)}\n`
                      + `差: ${up ? '＋' : '−'}${yen(Math.abs(p.plan - p.base))}\n`
                      + `出荷数: ${Math.round(p.qty).toLocaleString()}`}
                  </title>
                </rect>
              </g>
            );
          })}
        </svg>
      </HScroll>
      {total > pts.length && (
        <p className="pt-note" style={{ marginBottom: 0 }}>
          全 {total.toLocaleString()} 件のうち、並び替えの上位 {pts.length} 件を出しています
          （多すぎると読めないため）。絞り込みで対象を狭めると、残りも見られます。
        </p>
      )}
    </>
  );
}

/**
 * 平均単価の比較（基準 → 計画）。
 *
 * 「この器具区分は平均でいくら上がるのか」「この支店・法人はどうか」を見比べる画面。
 * 値上げ額の内訳と同じで、横軸に計画の月、縦軸に内訳（器具区分・支店・法人）を並べる。
 *
 * 絞り込みは案件一覧・ダッシュボードと同じ項目で、URLに残るので
 * 同じ条件のまま画面を行き来できる。
 */
export default function AvgPrices() {
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [data, setData] = useState<AvgRes | null>(null);
  const [group, setGroup] = useState<Group>('equip');
  // 表とグラフの切替。どちらも同じ並び順で出す
  const [view, setView] = useState<'table' | 'chart'>('table');
  // 並び替え。col は 'name' / 'cnt' / 'qty' / 'base' / 'm0'…'m3'
  const [sort, setSort] = useState<{ col: string; desc: boolean }>({ col: 'qty', desc: true });
  // グラフに出す月（基準と比べる相手）
  const [chartMonth, setChartMonth] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 「絞り込む」を押したときの取り直しの合図。条件が同じでも押せば取り直す
  const [reload, setReload] = useState(0);

  const get = (k: string) => params.get(k) || '';
  const qDraft = useRef(get('q'));

  const setMany = (updates: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  const setParam = (key: string, value: string) => setMany({ [key]: value });

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch(() => {});
    // 既定はダッシュボードと同じ「今回の取り組みが始まった月以降」。
    // 欄を空にすれば全期間になる
    if (!params.get('aDateYm')) {
      const next = new URLSearchParams(params);
      next.set('aDateYm', RAISE_START_YM);
      setParams(next, { replace: true });
    }
  }, []);

  const filterQs = FILTER_KEYS.map((k) => `${k}=${get(k)}`).join('&');
  const load = useCallback(() => {
    const qs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (get(k)) qs.set(k, get(k));
    qs.set('group', group);
    setBusy(true);
    setMsg('');
    api<AvgRes>(`/dashboard/avg-prices?${qs}`)
      .then(setData)
      .catch((e) => setMsg((e as Error).message))
      .finally(() => setBusy(false));
  }, [filterQs, group]);

  useEffect(load, [load, reload]);

  const hasFilters = FILTER_KEYS.some((k) => get(k));
  const applyFilters = () => {
    const q = qDraft.current.trim();
    if (q !== get('q')) setParam('q', q);
    else setReload((n) => n + 1);
  };
  const clearFilters = () => {
    const next = new URLSearchParams(params);
    for (const k of FILTER_KEYS) next.delete(k);
    qDraft.current = '';
    setParams(next, { replace: true });
  };

  const offices = meta?.offices.filter((o) => !get('branch') || o.branch === get('branch')) || [];
  const categories = narrowByParent(meta?.categories, [['equip', get('equip')]]);
  const models = narrowByParent(meta?.models,
    [['equip', get('equip')], ['category', get('category')]]);

  const actYm = meta?.actualMeta?.ym ?? '';
  const actLabel = actYm ? `${Number(actYm.slice(5, 7))}月` : '当月';
  const base = BASE_OPTIONS.find((o) => o.key === get('base'))?.key ?? 'master';
  const baseName = base === 'past' ? '過去最新単価'
    : base === 'actual' ? `${actLabel}の実単価` : `${actLabel}のマスタ単価`;
  const am = data?.aggMeta ?? meta?.aggMeta;
  const months = [am?.m0 || '当月', am?.m1 || '翌月', am?.m2 || '翌々月', am?.m3 || '3か月後'];
  const head = TABS.find((t) => t.key === group)?.head ?? '内訳';

  /** 並び替えに使う値。名前だけ文字、ほかは数（出せない行は末尾に寄せる） */
  const sortValue = (r: AvgRow, col: string): number | string => {
    if (col === 'name') return String(r.name ?? '');
    const b = baseOf(r);
    if (!b) return Number.NEGATIVE_INFINITY;
    if (col === 'cnt') return b.cnt;
    if (col === 'qty') return b.qty;
    if (col === 'base') return b.base;
    const m = /^m(\d)$/.exec(col);
    if (m) return planOf(r, Number(m[1]))?.plan ?? Number.NEGATIVE_INFINITY;
    return 0;
  };
  const rows = [...(data?.rows ?? [])].sort((a, b) => {
    const va = sortValue(a, sort.col);
    const vb = sortValue(b, sort.col);
    const d = typeof va === 'string' || typeof vb === 'string'
      ? String(va).localeCompare(String(vb), 'ja')
      : va - vb;
    return sort.desc ? -d : d;
  });
  /** 見出しを押したときの並び替え。もう一度押すと逆順になる */
  const toggleSort = (col: string) =>
    setSort((v) => ({ col, desc: v.col === col ? !v.desc : col !== 'name' }));
  /** 並び替えできる見出し。いまの向きを矢印で示す */
  const Th = ({ col, right, children, title }: {
    col: string; right?: boolean; children: React.ReactNode; title?: string;
  }) => (
    <th style={right ? nums : undefined}
        className={`sortable${sort.col === col ? ' sorted' : ''}`}
        title={title ? `${title}（押すと並び替えます）` : '押すと並び替えます'}
        onClick={() => toggleSort(col)}>
      {children}
      <span className="sort-mark">{sort.col === col ? (sort.desc ? '▼' : '▲') : ''}</span>
    </th>
  );
  // グラフは多すぎると読めないので、並び替えの上位だけを出す
  const CHART_MAX = 30;
  const chartRows = rows.slice(0, CHART_MAX);

  return (
    <div>
      <h1 className="page-title">平均単価</h1>
      <p className="page-sub">
        1台あたりの平均単価を、<strong>基準</strong>（いまは{baseName}）と各月の計画で比べます。
      </p>

      {/*
        絞り込み。案件一覧・ダッシュボードと同じ項目を、同じ段の並びで置く。
          1段目 だれの・どこの案件か  2段目 どの品目か  3段目 どう数えるか
      */}
      <div className="filters rows">
        <div className="frow">
          <label className="fld" style={{ minWidth: 240, flex: '1 1 240px' }}>
            検索（含む・空白区切りでAND）
            <SearchBox
              value={get('q')}
              onSearch={(q) => setParam('q', q)}
              onDraft={(q) => { qDraft.current = q; }}
              onPick={(filter, value) => {
                const next = new URLSearchParams(params);
                next.delete('q');
                if (value) next.set(filter, value); else next.delete(filter);
                setParams(next, { replace: true });
              }}
            />
          </label>
          <label className="fld">
            企業名
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
            担当者
            <select value={get('person')} onChange={(e) => setParam('person', e.target.value)}>
              <option value="">すべて</option>
              {meta?.persons.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
        </div>

        {/* 2段目。器具区分（大分類）→ カテゴリー名（大）→ 品目階層名 の順 */}
        <div className="frow">
          <label className="fld" title="品目の大分類。選ぶと右のカテゴリー名（大）・品目階層名がその中だけになります">
            器具区分<small style={{ fontWeight: 400 }}>（大分類）</small>
            <select value={get('equip')}
                    onChange={(e) => setMany({ equip: e.target.value, category: '', model: '' })}>
              <option value="">すべて</option>
              {meta?.equips.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </label>
          <label className="fld" title="器具区分の中の分類。選ぶと品目階層名がその中だけになります">
            カテゴリー名（大）
            <select value={get('category')}
                    onChange={(e) => setMany({ category: e.target.value, model: '' })}>
              <option value="">すべて</option>
              {categories.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </label>
          <label className="fld" title="カテゴリー名（大）の中の品目（器種名）">
            品目階層名
            <select value={get('model')} onChange={(e) => setParam('model', e.target.value)}>
              <option value="">すべて</option>
              {models.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </label>
        </div>

        {/* 3段目。何と比べ、どの範囲を数えるか */}
        <div className="frow">
          <label className="fld" title="各月の計画と比べる単価を選びます">
            基準<small style={{ fontWeight: 400 }}>（比較のもと）</small>
            <select value={base}
                    onChange={(e) => setParam('base', e.target.value === 'master' ? '' : e.target.value)}>
              {BASE_OPTIONS.map((o) => (
                <option key={o.key} value={o.key} title={o.note}>
                  {o.key === 'past' ? o.label : `${actLabel}の${o.label}`}
                </option>
              ))}
            </select>
          </label>
          <label className="fld" title="この承認日の条件に合う品目だけを平均に入れます">
            承認日<small style={{ fontWeight: 400 }}>（対象）</small>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="month" value={get('aDateYm')}
                     onChange={(e) => setParam('aDateYm', e.target.value)}
                     style={{ flex: '1 1 auto', minWidth: 0 }} />
              <select value={get('aDateOp') || 'from'}
                      onChange={(e) => setParam('aDateOp', e.target.value === 'from' ? '' : e.target.value)}
                      style={{ flex: '0 0 auto' }}>
                <option value="from">以降</option>
                <option value="before">より前</option>
              </select>
            </div>
          </label>
          <label className="fld">
            マスタ登録単価
            <select value={get('aState')} onChange={(e) => setParam('aState', e.target.value)}>
              <option value="">すべて</option>
              <option value="has">あり（値上げ対象）</option>
              <option value="none">なし</option>
            </select>
          </label>
          <div className="filter-actions">
            <button className="btn sm" onClick={applyFilters} disabled={busy}
                    title="いま選んでいる条件で集計し直します（検索欄に打った文字も反映します）">
              {busy ? '集計中...' : '絞り込む'}
            </button>
            <button className="btn secondary sm" onClick={clearFilters} disabled={busy || !hasFilters}
                    title="検索と絞り込みをすべて外します">
              解除
            </button>
          </div>
        </div>
      </div>

      {msg && <div className="alert error">{msg}</div>}

      <Card title={`平均単価の比較（${baseName} → 計画）`}>
        <NoteFold id="avg">
          <strong>1台あたりの平均単価</strong>を、<strong>基準</strong>で選んだ単価
          （いまは<strong>{baseName}</strong>）と各月の計画（マスタ登録単価）で比べます。
          基準の平均単価は<strong>出荷数の右の列</strong>に出し、各月はこの列と比べた差を出します。
          平均は<strong>出荷数（{actLabel}の実績数）で重みを付けた平均</strong>
          （単価×実績数の合計 ÷ 実績数の合計）です。
          マスの上段が<strong>計画単価の平均</strong>、下段が<strong>基準との差</strong>（1台あたり）です。
          対象は<strong>{baseName}と{actLabel}の実績数がある品目</strong>で、
          その月の計画が無い品目は<strong>変動なし</strong>（基準のまま）として数えます。
          どの月も同じ品目・同じ数量で比べるので、
          <strong>（計画の平均 − 基準の平均）× 出荷数 が、その月の値上げ額と一致します</strong>。
        </NoteFold>

        {/* 内訳のまとめ方・表とグラフの切替・並び替え。表とグラフは同じ並び順で出す */}
        <div className="chart-bar">
          <div className="seg">
            {TABS.map((t) => (
              <button key={t.key} type="button"
                      className={group === t.key ? 'on' : ''}
                      onClick={() => setGroup(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="seg">
            <button type="button" className={view === 'table' ? 'on' : ''}
                    onClick={() => setView('table')}>表</button>
            <button type="button" className={view === 'chart' ? 'on' : ''}
                    onClick={() => setView('chart')}>グラフ</button>
          </div>
          <div className="grow" />
          {view === 'chart' && (
            <label className="fld inline">
              比べる月
              <select value={chartMonth} onChange={(e) => setChartMonth(Number(e.target.value))}>
                {months.map((ym, i) => <option key={ym} value={i}>{ym} の計画</option>)}
              </select>
            </label>
          )}
          {/* 並び替えは表とグラフで共通。表は見出しを押しても変えられる */}
          <label className="fld inline">
            並び替え
            <select value={sort.col} onChange={(e) => setSort((v) => ({ ...v, col: e.target.value }))}>
              <option value="name">{head}の名前</option>
              <option value="cnt">対象件数</option>
              <option value="qty">出荷数</option>
              <option value="base">基準の単価</option>
              {months.map((ym, i) => <option key={ym} value={`m${i}`}>{ym} の計画単価</option>)}
            </select>
          </label>
          <div className="seg">
            <button type="button" className={!sort.desc ? 'on' : ''}
                    onClick={() => setSort((v) => ({ ...v, desc: false }))}>安い順</button>
            <button type="button" className={sort.desc ? 'on' : ''}
                    onClick={() => setSort((v) => ({ ...v, desc: true }))}>高い順</button>
          </div>
        </div>

        {view === 'chart' ? (
          <div style={busy ? { opacity: 0.45 } : undefined}>
            <AvgChart rows={chartRows} monthIdx={chartMonth} monthLabel={months[chartMonth]}
                      baseName={baseName} total={rows.length} />
          </div>
        ) : (
        <HScroll className="tbl-scroll">
          <table className="tbl" style={busy ? { opacity: 0.45 } : undefined}>
            <thead>
              <tr>
                <Th col="name">{head}</Th>
                <Th col="cnt" right>対象件数</Th>
                <Th col="qty" right title={`${actLabel}の実績数の合計（対象の品目ぶん）`}>
                  出荷数<br /><small>{actLabel}実績数</small>
                </Th>
                <Th col="base" right
                    title={`選んだ基準（${baseName}）の平均単価。右の各月はこれと比べています`}>
                  基準<br /><small>{baseName}</small>
                </Th>
                {months.map((ym, i) => (
                  <Th key={ym} col={`m${i}`} right>
                    {ym}<br /><small>計画平均 / 基準との差</small>
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !busy && (
                <tr><td colSpan={8} style={{ color: 'var(--muted)' }}>対象の品目がありません</td></tr>
              )}
              {/*
                合計の行は出さない。器具区分・支店・法人をまたいで単価を平均しても
                （給湯器とコンロを混ぜた1台あたりの単価）意味を持たないため。
                全体で見たいときは絞り込みを外して1つのまとまりとして見る。
              */}
              {rows.map((r, i) => {
                const b = baseOf(r);
                return (
                  <tr key={`${r.name ?? ''}-${i}`}>
                    <td style={{ maxWidth: 220, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                      {r.name || '—'}
                    </td>
                    <td style={nums}>{b ? b.cnt.toLocaleString() : '—'}</td>
                    <td style={nums}>{b ? Math.round(b.qty).toLocaleString() : '—'}</td>
                    <td style={{ ...nums, borderLeft: '1px solid var(--baseline)', fontWeight: 700 }}>
                      {b ? unitYen(b.base) : '—'}
                    </td>
                    {[0, 1, 2, 3].map((n) => <AvgCell key={n} v={planOf(r, n)} />)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </HScroll>
        )}
      </Card>
    </div>
  );
}

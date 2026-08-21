import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import SearchBox from '../components/SearchBox';
import HScroll from '../components/HScroll';
import { api } from '../api';
import { narrowByParent } from '../filterOptions';
import { Card } from '../components/ui';
import type { Meta } from '../types';
import { useIsMobile } from '../view';

/** 案件一覧と同じ絞り込みを受ける。集計と一覧を同じ条件で行き来できるようにするため */
/** 絞り込みの項目。案件一覧と同じものを受ける（サーバー側の判定も同じ） */
const FILTER_KEYS = ['q', 'equip', 'category', 'model', 'person', 'customer', 'corp',
  'branch', 'office', 'aState', 'act', 'aDateYm', 'aDateOp', 'gain', 'base'] as const;

/**
 * 値上げ幅の「基準」（比較のもと）。案件一覧と同じものを選ぶ。
 * マスタ登録単価（A基準）とこの単価との差が値上げ幅で、
 * それに当月の実績数を掛けたものが値上げ額になる。
 */
const BASE_OPTIONS = [
  { key: 'master', label: 'マスタ単価', note: '値決めの単価' },
  { key: 'actual', label: '実単価', note: '金額÷数量。見積ぶんが混ざる' },
  { key: 'past', label: '過去最新単価', note: '値上げ前の単価' },
] as const;

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
  /** マスタ分（値決めどおりに出た分）の金額。A基準の比較のもと。合計との差が見積ぶん */
  mp_amt: number;
  /** マスタ分の数量 */
  plan_qty: number;
  /** 実単価がマスタ単価と同じ件数 / 下回った件数 */
  mp_same: number;
  mp_below: number;
  a0_amt: number;
  /**
   * 実績（価格調査の月ごと）。act_amt_1 が4月ぶん…という並び。未取込なら入らない。
   * amt=実績額、base=同じ品目ぶんの現状額、cnt=実単価のあった件数、
   * up=現状より上がった件数、same=単価が変わっていない件数
   */
  [key: `act_amt_${number}`]: number | undefined;
  [key: `act_base_${number}`]: number | undefined;
  [key: `act_cnt_${number}`]: number | undefined;
  [key: `act_up_${number}`]: number | undefined;
  [key: `act_same_${number}`]: number | undefined;
  [key: `act_down_${number}`]: number | undefined;
  /** 売上改善額。上がった品目ぶん / 下がった品目ぶん */
  [key: `gain_plus_${number}`]: number | undefined;
  [key: `gain_minus_${number}`]: number | undefined;
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
    /**
     * 平均単価の比較（過去最新単価 → 計画）。
     * 過去最新単価・その月の計画・7月の実績数が揃う行だけで、
     * qty=7月実績数の合計、plan/past=単価×実績数の合計（÷qtyで加重平均になる）
     */
    avg_cnt_m0?: number; avg_cnt_m1?: number; avg_cnt_m2?: number; avg_cnt_m3?: number;
    avg_qty_m0?: number | null; avg_qty_m1?: number | null; avg_qty_m2?: number | null; avg_qty_m3?: number | null;
    avg_plan_m0?: number | null; avg_plan_m1?: number | null; avg_plan_m2?: number | null; avg_plan_m3?: number | null;
    avg_past_m0?: number | null; avg_past_m1?: number | null; avg_past_m2?: number | null; avg_past_m3?: number | null;
  };
  /**
   * 実績（過去最新単価 → 当月）。過去最新単価のある品目だけで集計する。
   * amount=その品目ぶんの金額（合計）、base=過去最新単価×数量（合計）。
   * mstAmount/mstBase=値決め分だけで見た場合（金額（マスタ）とマスタ分の数量）、
   * mpAmount=同じ品目をマスタ単価×数量で戻した金額（単価どうしの比較）
   */
  actuals?: {
    ym: string; amount: number; base: number; deals: number;
    mstAmount?: number; mstBase?: number; mpAmount?: number;
    /** 売上改善額の内訳。上がった品目ぶん / 下がった品目ぶん */
    gainPlus?: number; gainMinus?: number;
    /** 内訳。up=上がった件数、same=単価が変わっていない件数、down=下がった件数 */
    up?: number; same?: number; down?: number;
  }[];
  /** 集計表に出している実績の月の並び（実単価が未取込なら空） */
  abActYms?: string[];
  abTotals?: AbRow;
  abByEquip?: AbRow[];
  abByBranch?: AbRow[];
  abByCorp?: AbRow[];
  months?: number;
  aggMeta?: { m0?: string; m1: string; m2: string; m3: string; basePeriod: string } | null;
}

/**
 * 集計表に出す内容の切り替え。実績と計画を全部並べると横に長くなり、
 * スクロールしないと端まで見えないため、タブで出し分けて1画面に収める。
 */
const VIEWS = [
  { key: 'act' as const, label: '実績（売上改善額）' },
  { key: 'plan' as const, label: '計画（マスタ登録単価）' },
];

/** 値上げ額の内訳。器具区分別・支店別・法人別をそれぞれ別のカードで出す */
const TABS = [
  { key: 'equip' as const, label: '器具区分別', head: '器具区分', title: '器具区分別の値上げ額' },
  { key: 'branch' as const, label: '支店別', head: '支店', title: '支店別の値上げ額' },
  { key: 'corp' as const, label: '法人別', head: '法人', title: '法人別の値上げ額（現状額の大きい順）' },
];

const num = (n: unknown) => Number(n ?? 0);
/*
  金額の出し方。スマホでは桁が多いと表が読めないため、万円でまとめて出す。
  ダッシュボードを描くたびに Dashboard が下の目印を更新し、
  この中で使う金額の表示（表・タイル・まとめ）がまとめて切り替わる。
*/
let MONEY_MAN = false;
const yen = (v: number) => (MONEY_MAN
  ? `${Math.round(v / 1e4).toLocaleString()}万`
  : `¥${Math.round(v).toLocaleString()}`);

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

/** 滝チャートの1本ぶん */
interface FlowBar {
  label: string;                        // 下に出す名前
  sub?: string;                         // 件数など、名前の下に添える一行
  kind: '当初' | '実績' | '計画' | 'プラス' | 'マイナス';
  /** 全体の本（0から立てる）。step と どちらか片方だけ入れる */
  total?: number;
  /** 途中の増減（宙に浮く本）。実績→当初 の向きに足し引きする */
  step?: number;
  /** 上に出す文字。省略すると total を億で出す */
  show?: string;
  /** 値上げ前当初との差（計画の本に出す） */
  gain?: number | null;
}

/**
 * まとめの表と同じ数字を滝チャートで出す。
 * 7月実績 → プラスを除き → マイナスを戻し → 値上げ前当初 の流れ。
 * 計画（A基準）はグラフには出さず、下の表で見る。
 * 途中の増減は宙に浮く本で、全体の本（実績・当初）だけ0から立てる。
 */
function FlowChart({ bars }: { bars: FlowBar[] }) {
  const COLOR = {
    当初: '#9ca3af', 実績: '#15803d', 計画: '#2563eb',
    プラス: '#15803d', マイナス: '#c2410c',
  } as const;
  const W = 900;
  const H = 260;
  const top = 44;
  const bottom = 40;
  const max = Math.max(...bars.map((b) => b.total ?? 0), 1);
  const scale = (H - top - bottom) / max;
  const step = (W - 40) / bars.length;
  const bw = Math.min(88, step - 24);
  const oku = (v: number) =>
    Math.abs(v) >= 1e8 ? `${(v / 1e8).toLocaleString(undefined, { maximumFractionDigits: 1 })}億`
      : `${Math.round(v / 1e4).toLocaleString()}万`;

  // 位置を先に計算する。running は「いまの高さ」（実績から当初へ下る途中の水位）
  let running = 0;
  const placed = bars.map((b, i) => {
    const x = 20 + step * i + (step - bw) / 2;
    let y0: number;                     // 本の下端（金額）
    let y1: number;                     // 本の上端（金額）
    if (b.total != null) {
      y0 = 0; y1 = b.total; running = b.total;
    } else {
      const next = running + (b.step ?? 0);
      y0 = Math.min(running, next); y1 = Math.max(running, next); running = next;
    }
    return { ...b, x, y0, y1, level: running };
  });
  const yOf = (v: number) => H - bottom - v * scale;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label="7月実績から値上げ前当初、計画までの金額の流れ"
         style={{ width: '100%', height: 'auto', display: 'block' }}>
      {placed.map((b, i) => {
        // 途中の増減は小さくて見えなくなるため、最低4pxは描く
        const h = Math.max(b.total != null ? 2 : 4, (b.y1 - b.y0) * scale);
        const y = b.total != null ? yOf(b.y1) : Math.min(yOf(b.y0) - 4, yOf(b.y1));
        const show = b.show ?? oku(b.total ?? 0);
        return (
          <g key={`${b.label}-${i}`}>
            <title>
              {`${b.label}: ${b.total != null
                ? `¥${Math.round(b.total).toLocaleString()}`
                : `${(b.step ?? 0) >= 0 ? '＋' : '−'}¥${Math.round(Math.abs(b.step ?? 0)).toLocaleString()}`}`
                + (b.gain == null ? '' : `\n値上げ前当初との差 ${b.gain >= 0 ? '＋' : '−'}¥${Math.round(Math.abs(b.gain)).toLocaleString()}`)}
            </title>
            {/* 前の本からの水位のつなぎ線 */}
            {i > 0 && (
              <line x1={placed[i - 1].x + bw} x2={b.x}
                    y1={yOf(placed[i - 1].level)} y2={yOf(placed[i - 1].level)}
                    stroke="#9ca3af" strokeWidth={1} strokeDasharray="3 3" />
            )}
            <rect x={b.x} y={y} width={bw} height={h} rx={b.total != null ? 4 : 2}
                  fill={COLOR[b.kind]} />
            {b.total != null && (
              <rect x={b.x} y={Math.max(y, H - bottom - 4)} width={bw}
                    height={Math.min(4, h)} fill={COLOR[b.kind]} />
            )}
            <text x={b.x + bw / 2} y={y - (b.gain != null ? 24 : 8)} textAnchor="middle"
                  style={{ font: b.total != null ? '700 15px sans-serif' : '700 12px sans-serif',
                           fill: b.total != null ? 'var(--fg, #111827)' : COLOR[b.kind] }}>
              {show}
            </text>
            {b.gain != null && (
              <text x={b.x + bw / 2} y={y - 8} textAnchor="middle"
                    style={{ font: '600 11px sans-serif',
                             fill: b.gain < 0 ? '#c2410c' : b.gain > 0 ? '#15803d' : '#6b7280' }}>
                当初比 {b.gain === 0 ? '±0' : `${b.gain > 0 ? '＋' : '−'}${oku(Math.abs(b.gain))}`}
              </text>
            )}
            <text x={b.x + bw / 2} y={H - bottom + 16} textAnchor="middle"
                  style={{ font: '600 12px sans-serif', fill: 'var(--fg, #111827)' }}>
              {b.label}
            </text>
            {b.sub && (
              <text x={b.x + bw / 2} y={H - bottom + 31} textAnchor="middle"
                    style={{ font: '11px sans-serif', fill: '#6b7280' }}>
                {b.sub}
              </text>
            )}
          </g>
        );
      })}
      <line x1={16} x2={W - 16} y1={H - bottom} y2={H - bottom} stroke="#d1d5db" strokeWidth={1} />
    </svg>
  );
}

/**
 * 金額のマス。すべて1か月あたりで出す（期間合計は出さない）。
 * base を渡すと、その月の値上げ額と、現状額に対する値上げ率も添える。
 */
function AmtCell({ amt, base, months, note, noteTitle }: {
  amt: number; base?: number; months: number; note?: string; noteTitle?: string;
}) {
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
      {note && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }} title={noteTitle}>
          {note}
        </div>
      )}
    </td>
  );
}

// 集計表の並び替えの対象。月の列は「その月の値上げ額（A基準額−現状額）」で並べる
// （A基準額そのものだと規模の大きい区分が常に上に来て、値上げの大小が見えないため）
type SortCol = 'name' | 'deals' | 'qty' | 'base' | 'mp' | 'a0' | 'a1' | 'a2' | 'a3'
  | `act${number}` | `gp${number}` | `gm${number}`;

function sortValue(r: AbRow, col: SortCol): number | string {
  // 実績（月ごと）。その月に実単価のあった品目だけで見るため、現状額もその分だけを引く
  const act = /^act(\d+)$/.exec(col);
  if (act) {
    const n = Number(act[1]) + 1;
    return num(r[`gain_plus_${n}`]) + num(r[`gain_minus_${n}`]);
  }
  // 売上改善額のプラス側・マイナス側。マイナスは絶対値の大きい順で見たい
  const gp = /^gp(\d+)$/.exec(col);
  if (gp) return num(r[`gain_plus_${Number(gp[1]) + 1}`]);
  const gm = /^gm(\d+)$/.exec(col);
  if (gm) return -num(r[`gain_minus_${Number(gm[1]) + 1}`]);
  // 値上げ額の大きい順に並べるため、A基準の列は現状額との差で比べる（案件一覧と同じ）
  const pre = num(r.base_amt);
  switch (col) {
    case 'name': return r.name ?? '';
    case 'deals': return num(r.deals);
    case 'qty': return num(r.qty);
    case 'base': return num(r.base_amt);
    case 'mp': return num(r.mp_amt);
    case 'a0': return num(r.a0_amt) - pre;
    case 'a1': return num(r.a1_amt) - pre;
    case 'a2': return num(r.a2_amt) - pre;
    case 'a3': return num(r.a3_amt) - pre;
    default: return 0;
  }
}

/**
 * 集計表。器具区分別・支店別・法人別で同じ形を使う。
 * 金額はすべて1か月あたり。各月は「A基準額 / 値上げ額（値上げ率）」の順に出す。
 * 見出しを押すとその列で並び替える（合計の行は常に一番下に置く）。
 */
function AbTable({ head, rows, total, months, actYms = [], m0, m1, m2, m3, link, view }: {
  head: string; rows: AbRow[]; total?: AbRow;
  months: number; actYms?: string[]; m0: string; m1: string; m2: string; m3: string;
  /** その行の品目を、売上改善額の向きで絞った案件一覧のURL（合計行は渡らない） */
  link?: (name: string | null | undefined, kind: 'plus' | 'minus') => string;
  /** 出す内容。act=実績（売上改善額）、plan=計画（A基準） */
  view: 'act' | 'plan';
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
            <Th col="qty" right title="1か月あたりの数量">
              数量<br /><small>月平均</small>
            </Th>
            <Th col="base" right
                title="当月の金額（合計）そのもの。マスタ登録単価の値上げ幅はここへ足します（1か月あたり）">
              現状額（合計）<br /><small>月あたり</small>
            </Th>
            {view === 'act' && (
              <Th col="mp" right
                  title="当月の金額（マスタ）。値決めどおりに出た分（1か月あたり）">
                うちマスタ<br /><small>月あたり</small>
              </Th>
            )}
            {view === 'act' && actYms.flatMap((ym, i) => [
              <Th key={ym} col={`act${i}`} right
                  title={`${ym}の金額（合計）と、値上げ前当初との差（売上改善額）`}>
                {ym} 実績<br /><small>金額 / 売上改善額（率）</small>
              </Th>,
              <Th key={`${ym}-gp`} col={`gp${i}`} right
                  title={`${ym}に単価が上がった品目ぶんの売上改善額。押すとその品目を案件一覧で見られます`}>
                {ym} プラス<br /><small>上がった品目</small>
              </Th>,
              <Th key={`${ym}-gm`} col={`gm${i}`} right
                  title={`${ym}に単価が下がった品目ぶんの売上改善額。押すとその品目を案件一覧で見られます`}>
                {ym} マイナス<br /><small>下がった品目</small>
              </Th>,
            ])}
            {view === 'plan' && (
              <>
                <Th col="a0" right title={`${m0}（当月）の値上げ額（値上げ前当初との差）で並びます`}>{m0}<br /><small>マスタ登録単価額 / 値上げ額</small></Th>
                <Th col="a1" right title={`${m1}の値上げ額で並びます`}>{m1}<br /><small>マスタ登録単価額 / 値上げ額</small></Th>
                <Th col="a2" right title={`${m2}の値上げ額で並びます`}>{m2}<br /><small>マスタ登録単価額 / 値上げ額</small></Th>
                <Th col="a3" right title={`${m3}の値上げ額で並びます`}>{m3}<br /><small>マスタ登録単価額 / 値上げ額</small></Th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {[...sorted, ...(total ? [{ ...total, name: '合計' }] : [])].map((r, i) => {
            const last = i === sorted.length;
            // 現状額は当月の金額（合計）。A基準（計画）もここと比べる。
            // 案件一覧の「値上げ額（月）合計」と同じ数字になる
            const base = num(r.base_amt);
            const pre = base;
            return (
              <tr key={i} style={last ? { fontWeight: 700, borderTop: '2px solid var(--grid)' } : undefined}>
                {/* 法人名は長いものがあるため、幅を決めて折り返す（表が横に伸びないように） */}
                <td style={{ maxWidth: 220, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                  {r.name || '—'}
                </td>
                <td style={nums}>{num(r.deals).toLocaleString()}</td>
                <td style={nums}>
                  {(num(r.qty) / months).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </td>
                <AmtCell amt={base} months={months} />
                {view === 'act' && <AmtCell amt={num(r.mp_amt)} months={months} />}
                {view === 'act' && actYms.flatMap((ym, i) => {
                  // 実績は「値上げ前当初 → 当月の金額（合計）」。差が売上改善額になる
                  const gp = num(r[`gain_plus_${i + 1}`]);
                  const gm = num(r[`gain_minus_${i + 1}`]);
                  if (r[`act_amt_${i + 1}`] == null) {
                    return [<td key={ym} style={nums}>—</td>,
                      <td key={`${ym}-gp`} style={nums}>—</td>,
                      <td key={`${ym}-gm`} style={nums}>—</td>];
                  }
                  // プラス側・マイナス側は、その中身を案件一覧で開けるようにする
                  const cell = (kind: 'plus' | 'minus', amt: number, cnt: number) => {
                    const body = (
                      <>
                        {amt === 0 ? '—' : `${kind === 'plus' ? '＋' : '−'}${yen(Math.abs(amt) / months)}`}
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                          {cnt.toLocaleString()}件
                        </div>
                      </>
                    );
                    const to = last || !link ? null : link(r.name, kind);
                    return (
                      <td key={`${ym}-${kind === 'plus' ? 'gp' : 'gm'}`}
                          style={{ ...nums, fontWeight: 700,
                                   color: amt === 0 ? 'var(--muted)' : kind === 'plus' ? '#15803d' : '#c2410c' }}>
                        {to ? <Link to={to} style={{ color: 'inherit' }}>{body}</Link> : body}
                      </td>
                    );
                  };
                  return [
                    <AmtCell key={ym} amt={base} base={base - (gp + gm)} months={months}
                             note={`↑${num(r[`act_up_${i + 1}`]).toLocaleString()}`
                               + ` / ↓${num(r[`act_down_${i + 1}`]).toLocaleString()}`}
                             noteTitle={`${ym}: 単価が変わっていない `
                               + `${num(r[`act_same_${i + 1}`]).toLocaleString()}件`} />,
                    cell('plus', gp, num(r[`act_up_${i + 1}`])),
                    cell('minus', gm, num(r[`act_down_${i + 1}`])),
                  ];
                })}
                {/* A基準（計画）は現状額（当月のマスタ単価）と比べる＝案件一覧と同じ */}
                {view === 'plan' && (
                  <>
                    <AmtCell amt={num(r.a0_amt)} base={pre} months={months} />
                    <AmtCell amt={num(r.a1_amt)} base={pre} months={months} />
                    <AmtCell amt={num(r.a2_amt)} base={pre} months={months} />
                    <AmtCell amt={num(r.a3_amt)} base={pre} months={months} />
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 値上げ額の内訳カード。器具区分別・支店別・法人別で1枚ずつ使い、
 * カードの中の切り替えで実績（売上改善額）と計画（マスタ登録単価）を出し分ける。
 */
function AbCard({ title, head, rows, total, months, actYms, m0, m1, m2, m3, link }: {
  title: string; head: string; rows: AbRow[]; total?: AbRow;
  months: number; actYms?: string[]; m0: string; m1: string; m2: string; m3: string;
  link: (name: string | null | undefined, kind: 'plus' | 'minus') => string;
}) {
  const [view, setView] = useState<'act' | 'plan'>('act');
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>
          {title}
          <span style={{ marginLeft: 8, fontSize: 12.5, fontWeight: 400, color: 'var(--muted)' }}>
            {rows.length.toLocaleString()}件
          </span>
        </h3>
        {/* 実績と計画の切り替え。両方並べると横に長くなるため、カードの中で出し分ける */}
        <div className="seg" style={{ marginLeft: 'auto' }}>
          {VIEWS.map((v) => (
            <button key={v.key} className={view === v.key ? 'on' : ''}
                    onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <AbTable head={head} rows={rows} total={total} months={months} actYms={actYms}
               m0={m0} m1={m1} m2={m2} m3={m3} view={view} link={link} />
    </div>
  );
}

export default function Dashboard() {
  const mobile = useIsMobile();
  // スマホでは金額を万円で出す（この画面の中の表・タイル・まとめが揃う）
  MONEY_MAN = mobile;
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<DashboardRes | null>(null);
  // 集計中かどうか（絞り込みを変えたあと、前の内容を出したまま取り直す）
  const [busy, setBusy] = useState(false);
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

  // 検索欄に打っている途中の文字。「絞り込む」で反映する（案件一覧と同じ）
  const qDraft = useRef(get('q'));
  /** いま絞り込みが掛かっているか（「解除」を出すかの判断） */
  const hasFilters = FILTER_KEYS.some((k) => get(k));
  /** 「絞り込む」。検索欄に打った文字を取り込んだうえで集計を取り直す */
  const applyFilters = () => {
    const q = qDraft.current.trim();
    if (q !== get('q')) setParam('q', q);
    else load();
  };
  /** 「解除」。検索・絞り込みをすべて外す */
  const clearFilters = () => {
    const next = new URLSearchParams(params);
    for (const k of FILTER_KEYS) next.delete(k);
    qDraft.current = '';
    setParams(next, { replace: true });
  };

  /**
   * いまの絞り込みを引き継いで、案件一覧の「売上改善額」で絞ったURLを作る。
   * extra を渡すと、その器具区分・支店・法人にも絞る（集計表のマスから開くとき）。
   */
  const dealsLink = (
    gainKind: 'plus' | 'minus' | 'same',
    extra?: Record<string, string>
  ) => {
    const q = new URLSearchParams();
    for (const k of FILTER_KEYS) if (get(k)) q.set(k, get(k));
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (v) q.set(k, v); else q.delete(k);
    }
    q.set('gain', gainKind);
    return `/deals?${q.toString()}`;
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
        // 既定の絞り込みと同じ回で集計を始める。
        // 先に集計を始めると、絞り込み前の重い集計（10万件）を1回捨てることになる
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  // 集計を取り直すのは絞り込みが変わったときだけ。
  // 表の切り替え（tab）は手元の値を出し分けるだけなので、10万件の集計は走らせない
  const filterQs = FILTER_KEYS.map((k) => `${k}=${get(k)}`).join('&');

  /**
   * 集計を取り直す。取り直している間も前の内容を出しておく
   * （消してしまうと絞り込みの欄ごと画面が入れ替わり、続けて操作できない）。
   */
  const load = useCallback(() => {
    const qs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (get(k)) qs.set(k, get(k));
    setBusy(true);
    setMsg('');
    api<DashboardRes>(`/dashboard?${qs}`)
      .then(setData)
      .catch((e) => setMsg(e.message))
      .finally(() => setBusy(false));
  }, [filterQs]);

  useEffect(() => {
    if (ready) load();
  }, [load, ready]);

  if (msg && !data) return <div className="alert error">{msg}</div>;
  if (!data) return <p style={{ color: 'var(--muted)' }}>読み込み中...</p>;

  const t = data.abTotals;
  // 実績（過去最新単価 → 当月）と、その売上改善額（プラス・マイナスの合計）。
  // 7月金額（合計）からこの改善額を引いたものが「値上げ前当初」になる
  const act = data.actuals?.[0];
  const gainPlus = num(act?.gainPlus);
  const gainMinus = num(act?.gainMinus);
  const gain = act ? gainPlus + gainMinus : null;
  const m0 = data.aggMeta?.m0 || '当月';
  const m1 = data.aggMeta?.m1 || '翌月';
  const m2 = data.aggMeta?.m2 || '翌々月';
  const m3 = data.aggMeta?.m3 || '3か月後';
  const months = data.months || 1;
  const actYm = data.actuals?.[0]?.ym ?? '';
  const actLabel = actYm ? `${Number(actYm.slice(5, 7))}月` : '当月';
  // 値上げ幅の基準（比較のもと）。案件一覧と同じ選び方
  const base = BASE_OPTIONS.find((o) => o.key === get('base'))?.key ?? 'master';
  const baseName = base === 'past' ? '過去最新単価'
    : base === 'actual' ? `${actLabel}の実単価` : `${actLabel}のマスタ単価`;
  const rowsOf = (key: 'equip' | 'branch' | 'corp') =>
    (key === 'equip' ? data.abByEquip : key === 'branch' ? data.abByBranch : data.abByCorp) ?? [];
  const offices = meta?.offices.filter((o) => !get('branch') || o.branch === get('branch')) || [];
  // 品目は 器具区分（大分類）→ カテゴリー名（大）→ 品目階層名 の順（案件一覧と同じ）
  const categories = narrowByParent(meta?.categories, [['equip', get('equip')]]);
  const models = narrowByParent(meta?.models,
    [['equip', get('equip')], ['category', get('category')]]);

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
        売上高（{actLabel}）の<strong>品目件数</strong>を母数に、
        ベース（価格調査（毎日更新））との突合件数と、
        <strong>値上げ額</strong>（(マスタ登録単価−<strong>{baseName}</strong>)×{actLabel}の実績数）を出します
        （比較のもとは<strong>基準</strong>で選べます）。
        <strong>値上げ前当初</strong>は、{actLabel}の金額（合計）から売上改善額を引いた額です。
        <strong>承認日</strong>は既定で<strong>当月以降に承認された単価だけ</strong>を見ています
        （それより前は値上げ前の古い単価が多いため）。欄を空にすると全期間になります。
        絞り込みで件数と値上げ額が変わります。
        下の表の<strong>現状額</strong>は{actLabel}の金額（合計）そのものです。
        各月の<strong>マスタ登録単価額</strong>は、そこへ「マスタ登録単価 − {baseName}」×{actLabel}の実績数を
        足した金額で、その差が値上げ額、現状額に対する割合が<strong>値上げ率</strong>です。
        {baseName}が無い品目・{actLabel}の実績数が無い品目は<strong>変動なし</strong>として扱います。
        金額はすべて<strong>1か月あたり</strong>です。
        表示範囲: <strong>{data.scope.label}</strong>
      </p>

      <div className="filters">
        {/* 絞り込みの項目は案件一覧とそろえる（同じ条件で見比べられるように） */}
        <label className="fld" style={{ minWidth: 240, flex: '1 1 240px' }}>
          検索（含む・空白区切りでAND）
          <SearchBox
            value={get('q')}
            onSearch={(q) => setParam('q', q)}
            onDraft={(q) => { qDraft.current = q; }}
            onPick={(filter, value) => {
              // 候補で絞り込むときは、文字検索は消して条件を入れ替える
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
        {/* 品目の絞り込みは 器具区分（大分類）→ カテゴリー名（大）→ 品目階層名 の順 */}
        <label className="fld" title="品目の大分類。選ぶと下のカテゴリー名（大）・品目階層名がその中だけになります">
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
        <label className="fld">
          カテゴリー名（大）
          <select value={get('category')} onChange={(e) => setParam('category', e.target.value)}>
            <option value="">すべて</option>
            {meta?.categories?.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
        </label>
        <label className="fld">
          品目階層名（器種名）
          <select value={get('model')} onChange={(e) => setParam('model', e.target.value)}>
            <option value="">すべて</option>
            {meta?.models?.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
        </label>
        <label className="fld">
          担当者
          <select value={get('person')} onChange={(e) => setParam('person', e.target.value)}>
            <option value="">すべて</option>
            {meta?.persons.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
        {/* 値上げ幅の「基準」（比較のもと）。案件一覧と同じ選択肢 */}
        <label className="fld"
               title={`マスタ登録単価（A基準）と比べる単価を選びます。差が値上げ幅、`
                 + `それに${actLabel}の実績数を掛けたものが値上げ額です。`
                 + `選んだ単価が無い品目と、${actLabel}の実績数が無い品目は変動なしになります`}>
          基準<small style={{ fontWeight: 400 }}>（比較のもと）</small>
          <select value={base} onChange={(e) => setParam('base', e.target.value === 'master' ? '' : e.target.value)}>
            {BASE_OPTIONS.map((o) => (
              <option key={o.key} value={o.key} title={o.note}>
                {o.key === 'past' ? o.label : `${actLabel}の${o.label}`}
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          マスタ登録単価
          <select value={get('aState')} onChange={(e) => setParam('aState', e.target.value)}>
            <option value="">すべて</option>
            <option value="has">あり（値上げ対象）</option>
            <option value="none">なし</option>
          </select>
        </label>
        {/* 売上高（月次）との突合。ベースにだけあって当たらない品目は実績無し */}
        <label className="fld"
               title={`ベース（価格調査（毎日更新））へ売上高（${actLabel}）を突合しています。当たらない品目は${actLabel}実績無しです`}>
          売上高（{actLabel}）
          <select value={get('act')} onChange={(e) => setParam('act', e.target.value)}>
            <option value="">すべて</option>
            <option value="has">あり（突合済）</option>
            <option value="none">なし（{actLabel}実績無し）</option>
          </select>
        </label>
        {/* 承認日での絞り込み（案件一覧と同じ。3か月後のA基準の承認日が基準） */}
        <label className="fld" title={`${m3}のマスタ登録単価の承認日で絞り込みます`}>
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
        <label className="fld">
          売上改善額
          <select value={get('gain')} onChange={(e) => setParam('gain', e.target.value)}
                  title={`過去最新単価と${actLabel}のマスタ単価を比べた向きで絞り込みます`}>
            <option value="">すべて</option>
            <option value="plus">プラス（上がった）</option>
            <option value="minus">マイナス（下がった）</option>
            <option value="same">変わらず</option>
            <option value="none">比較なし（過去単価なし）</option>
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

      {/*
        集計し直している間は、下の数字が「前の条件のまま」であることが分かるように
        全体を薄くして目印を出す。10万件の集計は数秒かかるため、これが無いと
        絞り込みを変えても数字が変わらないように見えてしまう。
      */}
      {busy && (
        <div className="alert" style={{ marginTop: 10 }}>
          集計し直しています…（下の数字はまだ前の条件のものです）
        </div>
      )}
      <div style={busy ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>

      {/*
        出荷実績（土台）→ マスタ登録の件数（品目ベースの件数が母数）→
        月ごとの値上げ額（月あたり）の並び。
        承認日の絞り込みを変えると、ここもその条件で数え直される。
      */}
      <div className="tiles">
        {/* 出荷実績（1~3月）の品目全数と、マスタ登録に載っている品目の突合 */}
        <Kpi label={`実績（${actLabel}）`}
             value={`${num(data.histTotals?.deals).toLocaleString()}件`}
             sub={`数量 月平均 ${Math.round(num(data.histTotals?.qty) / months).toLocaleString()}`} />
        {/* 金額の流れはタイルではなく、まとめのグラフと表で出す */}
        {gain != null && (
          <div className="tile">
            <div className="label">売上改善額（過去→当月）</div>
            <div className="value">{gain >= 0 ? '＋' : '−'}{yen(Math.abs(gain) / months)}</div>
            {/* プラス・マイナスそれぞれの中身を、案件一覧の絞り込みで開けるようにする */}
            <div className="delta">
              <Link to={dealsLink('plus')} title="上がった品目を案件一覧で見る">
                上がった ＋{yen(gainPlus / months)}（{num(act?.up).toLocaleString()}件）
              </Link>
              {' / '}
              <Link to={dealsLink('minus')} title="下がった品目を案件一覧で見る">
                下がった −{yen(Math.abs(gainMinus) / months)}（{num(act?.down).toLocaleString()}件）
              </Link>
              {' / '}
              <Link to={dealsLink('same')} title="単価が変わっていない品目を案件一覧で見る">
                変わらず {num(act?.same).toLocaleString()}件
              </Link>
            </div>
          </div>
        )}
        <Kpi label="マスタ登録単価あり"
             value={`${num(data.aMonths?.covered).toLocaleString()} / ${num(data.histTotals?.deals).toLocaleString()}件`}
             sub={num(data.histTotals?.deals) > 0
               ? `出荷実績の品目の ${(Math.round((num(data.aMonths?.covered) / num(data.histTotals?.deals)) * 1000) / 10).toLocaleString()}%`
               : undefined} />
      </div>

      {/* まとめ（実績と計画）を値上げ額の内訳より先（上）に置く */}
      <Card title={`まとめ（実績と計画）${get('aDateYm') ? `　承認日 ${get('aDateYm')} ${get('aDateOp') === 'before' ? 'より前' : '以降'}` : ''}`}>
        <p className="pt-note" style={{ marginTop: 0 }}>
          <strong>当初</strong>は値上げ前の金額で、{actLabel}の金額（合計）から
          <strong>売上改善額</strong>（＝（{actLabel}のマスタ単価 − 過去最新単価）× マスタ分の数量）を
          引いたものです。上がった品目のプラスと、下がった品目のマイナスを合わせた額を引いています。
          <strong>実績</strong>は{actLabel}の金額（合計）そのもので、当初との差が売上改善額になります。
          <strong>計画</strong>は、この{actLabel}の金額（合計）へ
          「マスタ登録単価 − {baseName}」×{actLabel}の実績数を足したもので、
          <strong>実績（{actLabel}の金額）と比べます</strong>
          （案件一覧の「値上げ額（月）合計」と同じ数字になります）。
          <strong>参考</strong>の行は、そのうち値決めどおりに出た分（金額（マスタ））で、
          実績との差が見積ぶんなどにあたります。
          どの行も「<strong>比較のもと</strong>」と「<strong>金額</strong>」を比べ、その差が値上げ額です。
          実績の行は<strong>過去最新単価のある品目だけ</strong>が対象のため、件数と金額がマスタ分より小さくなります
          （比べる相手の無い品目は値上げ額を出せないため）。
          計画の行は全品目が対象で、承認のある品目だけ
          「マスタ登録単価 − {baseName}」×{actLabel}の実績数 を足しています
          （{baseName}が無い品目・{actLabel}の実績数が無い品目は変動なしです）。
        </p>
        {/*
          同じ数字を、当初 → 実績 → 計画 の棒グラフでも出す。
          値上げ額のラベルは、どの本も値上げ前当初との差
        */}
        {(() => {
          const pre = gain == null ? null : num(t?.base_amt) - gain;
          const oku = (v: number) =>
            Math.abs(v) >= 1e8
              ? `${(v / 1e8).toLocaleString(undefined, { maximumFractionDigits: 1 })}億`
              : `${Math.round(v / 1e4).toLocaleString()}万`;
          // 7月実績 → プラスを除く → マイナスを戻す → 値上げ前当初
          const bars: FlowBar[] = [
            {
              label: `${actLabel} 実績`, kind: '実績', total: num(t?.base_amt) / months,
              sub: `${num(t?.deals).toLocaleString()}件`,
            },
            ...(pre != null ? [
              {
                label: '改善額 プラス', kind: 'プラス' as const, step: -gainPlus / months,
                show: `＋${oku(gainPlus / months)}`,
                sub: `上がった ${num(act?.up).toLocaleString()}件`,
              },
              {
                label: '改善額 マイナス', kind: 'マイナス' as const, step: -gainMinus / months,
                show: `−${oku(Math.abs(gainMinus) / months)}`,
                sub: `下がった ${num(act?.down).toLocaleString()}件`,
              },
              {
                label: `${actLabel} 当初`, kind: '当初' as const, total: pre / months,
                sub: `${num(t?.deals).toLocaleString()}件`,
              },
            ] : []),
          ];
          return <FlowChart bars={bars} />;
        })()}
        <table className="tbl">
          <thead>
            <tr>
              <th>月</th>
              <th>区分</th>
              <th style={nums}>件数</th>
              <th style={nums} title="実績の行だけ。過去最新単価より上がった件数と、変わっていない件数">
                内訳<br /><small>上がった / 同じ</small>
              </th>
              <th style={nums}
                  title="実績は値上げ前当初と、計画は実績（当月の金額）と比べます">
                比較のもと<br /><small>月あたり</small>
              </th>
              <th style={nums}>金額<br /><small>月あたり</small></th>
              <th style={nums}>値上げ額<br /><small>月あたり</small></th>
              <th style={nums} title="値上げ額 ÷ 現状額">値上げ率</th>
            </tr>
          </thead>
          <tbody>
            {/*
              土台（合計）→ マスタ分 → 実績（過去→当月）→ 計画（A基準）の順に並べる。
              8月のように実績と計画の両方がある月は2行になり、
              計画どおりに上がっているかをその場で見比べられる。
            */}
            {[
              // 値上げ前当初。7月金額（合計）から売上改善額を引いたもの。
              // ここが値上げのスタート地点になる
              ...(gain != null ? [{
                key: 'pre', ym: `${actYm || '当月'} 値上げ前当初`, kind: '当初' as const,
                deals: num(t?.deals), base: null as number | null,
                amt: num(t?.base_amt) - gain,
                up: null as number | null, same: null as number | null,
              }] : []),
              // 実績。取り込んだ当月の金額そのもの（全品目）。
              // 値上げ前当初との差が売上改善額
              {
                key: 'base', ym: actYm || '当月', kind: '実績' as const,
                deals: num(t?.deals),
                base: (gain == null ? null : num(t?.base_amt) - gain) as number | null,
                amt: num(t?.base_amt),
                up: gain == null ? null : num(act?.up), same: gain == null ? null : num(act?.same),
              },
              // マスタ分。値決めどおりに出た分（土台との差が見積ぶんなど）
              ...(num(t?.mp_amt) > 0 ? [{
                key: 'mp', ym: `${actYm || '当月'}（マスタ）`, kind: '参考' as const,
                deals: num(t?.deals), base: num(t?.base_amt) as number | null, amt: num(t?.mp_amt),
                up: null as number | null, same: num(t?.mp_same) as number | null,
              }] : []),
              ...([[m0, num(t?.a0_amt)], [m1, num(t?.a1_amt)], [m2, num(t?.a2_amt)], [m3, num(t?.a3_amt)]] as [string, number][])
                .map(([label, amt]) => ({
                  key: `plan-${label}`, ym: label, kind: '計画' as const,
                  deals: num(t?.deals),
                  // 比較のもとは実績（当月の金額）。ここからA基準までの上がり幅が値上げ額で、
                  // 案件一覧の「値上げ額（月）合計」と同じ数字になる
                  base: num(t?.base_amt) as number | null,
                  amt, up: null, same: null,
                })),
            ]
              .map((row) => {
                const gain = row.base == null ? null : row.amt - row.base;
                const rate = row.base != null && row.base > 0
                  ? Math.round((gain! / row.base) * 1000) / 10 : null;
                return (
                  <tr key={row.key}>
                    <td><strong>{row.ym}</strong></td>
                    <td>
                      <span className={`badge ${row.kind === '当初' || row.kind === '参考' ? 'gray'
                        : row.kind === '実績' ? 'green' : 'blue'}`}>
                        {row.kind}
                      </span>
                    </td>
                    <td style={nums}>{row.deals.toLocaleString()}</td>
                    <td style={nums}>
                      {row.kind === '参考' ? (
                        <span title={`実単価が${actLabel}のマスタ単価と同じ品目の件数`}>
                          <span style={{ color: 'var(--muted)' }}>—</span>
                          {' / '}{row.same?.toLocaleString()}
                        </span>
                      ) : row.up == null ? '—' : (
                        <span title={`上がった ${row.up.toLocaleString()}件 / 単価が変わっていない ${row.same?.toLocaleString()}件`}>
                          <span style={{ fontWeight: 700, color: row.up > 0 ? '#15803d' : 'var(--muted)' }}>
                            {row.up.toLocaleString()}
                          </span>
                          {' / '}{row.same?.toLocaleString()}
                        </span>
                      )}
                    </td>
                    <td style={nums}>{row.base == null ? '—' : yen(row.base / months)}</td>
                    <td style={nums}>{yen(row.amt / months)}</td>
                    <td style={{ ...nums, fontWeight: 700,
                                 color: gain == null ? undefined
                                   : gain < 0 ? '#c2410c' : gain > 0 ? '#15803d' : undefined }}>
                      {gain == null ? '—'
                        : gain === 0 ? '—'
                          : `${gain > 0 ? '＋' : '−'}${yen(Math.abs(gain) / months)}`}
                    </td>
                    <td style={nums}>{rate == null ? '—' : `${rate > 0 ? '+' : ''}${rate}%`}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Card>

      {/*
        平均単価の比較（過去最新単価 → 計画）。
        器具区分・カテゴリー名（大）・品目階層名などで絞り込むと、
        そのまとまりの平均単価が過去からいくら上がる計画かを1台あたりで見られる。
        平均は出荷数（7月の実績数）で重みを付ける。単価なので万円にはまとめない。
      */}
      {(() => {
        const a = data.aMonths;
        const unit = (v: number) =>
          `¥${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
        const rows = ([[0, m0], [1, m1], [2, m2], [3, m3]] as const).map(([n, ym]) => {
          const cnt = num(a?.[`avg_cnt_m${n}`]);
          const qty = num(a?.[`avg_qty_m${n}`]);
          const plan = num(a?.[`avg_plan_m${n}`]);
          const past = num(a?.[`avg_past_m${n}`]);
          if (!(qty > 0)) return { ym, cnt, qty, past: null, plan: null, diff: null, rate: null };
          const pastAvg = past / qty;
          const planAvg = plan / qty;
          const diff = planAvg - pastAvg;
          return {
            ym, cnt, qty, past: pastAvg, plan: planAvg, diff,
            rate: pastAvg > 0 ? Math.round((diff / pastAvg) * 1000) / 10 : null,
          };
        });
        return (
          <Card title={`平均単価の比較（過去最新単価 → 計画）${get('aDateYm') ? `　承認日 ${get('aDateYm')} ${get('aDateOp') === 'before' ? 'より前' : '以降'}` : ''}`}>
            <p className="pt-note" style={{ marginTop: 0 }}>
              いまの絞り込み（器具区分・カテゴリー名（大）・品目階層名など）のまとまりで、
              <strong>1台あたりの平均単価</strong>を過去最新単価と各月の計画（マスタ登録単価）で比べます。
              平均は<strong>出荷数（{actLabel}の実績数）で重みを付けた平均</strong>
              （単価×実績数の合計 ÷ 実績数の合計）です。
              過去最新単価・その月の計画・{actLabel}の実績数の<strong>3つが揃う品目だけ</strong>が対象で、
              同じ品目どうしで比べるため、差がそのまま1台あたりの上がり幅になります
              （実績や単価の無い品目は含めません。値上げ額の合計とは対象の数が異なります）。
            </p>
            <HScroll className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>計画の月</th>
                    <th style={nums}>対象件数</th>
                    <th style={nums} title={`${actLabel}の実績数の合計（対象の品目ぶん）`}>出荷数<br /><small>{actLabel}実績数</small></th>
                    <th style={nums}>過去最新単価<br /><small>平均</small></th>
                    <th style={nums}>計画単価<br /><small>平均</small></th>
                    <th style={nums} title="計画単価（平均） − 過去最新単価（平均）">上がり幅<br /><small>1台あたり</small></th>
                    <th style={nums} title="上がり幅 ÷ 過去最新単価（平均）">上がり率</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.ym}>
                      <td>{r.ym}</td>
                      <td style={nums}>{r.cnt.toLocaleString()}</td>
                      <td style={nums}>{r.qty > 0 ? Math.round(r.qty).toLocaleString() : '—'}</td>
                      <td style={nums}>{r.past == null ? '—' : unit(r.past)}</td>
                      <td style={nums}>{r.plan == null ? '—' : unit(r.plan)}</td>
                      <td style={{ ...nums, fontWeight: 700,
                                   color: r.diff == null ? undefined
                                     : r.diff < 0 ? '#c2410c' : r.diff > 0 ? '#15803d' : undefined }}>
                        {r.diff == null ? '—'
                          : Math.abs(r.diff) < 0.05 ? '±0'
                            : `${r.diff > 0 ? '＋' : '−'}${unit(Math.abs(r.diff))}`}
                      </td>
                      <td style={nums}>{r.rate == null ? '—' : `${r.rate > 0 ? '+' : ''}${r.rate}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </HScroll>
          </Card>
        );
      })()}

      {/*
        値上げ額の内訳。器具区分別・支店別・法人別をそれぞれ別のカードで縦に並べ、
        カードの中の切り替えで実績（売上改善額）と計画（マスタ登録単価）を見る。
      */}
      {TABS.map((x) => (
        <AbCard key={x.key} title={x.title} head={x.head} rows={rowsOf(x.key)}
                total={t} months={months} actYms={data.abActYms}
                m0={m0} m1={m1} m2={m2} m3={m3}
                link={(name, kind) => dealsLink(kind, { [x.key]: name ?? '' })} />
      ))}
      </div>

    </div>
  );
}

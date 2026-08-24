import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import SearchBox from '../components/SearchBox';
import { api } from '../api';
import { BASE_OPTIONS, FILTER_KEYS, RAISE_START_YM, narrowByParent } from '../filterOptions';
import { Card, NoteFold, num, nums } from '../components/ui';
import { dayLabel } from '../components/RaiseTrend';
import type { RaiseDay } from '../components/RaiseTrend';
import type { Meta } from '../types';
import { useIsMobile } from '../view';

/** 案件一覧と同じ絞り込みを受ける。集計と一覧を同じ条件で行き来できるようにするため */


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
     * 平均単価の比較（基準 → 計画）。
     * 基準の単価と7月の実績数がある行だけで、
     * qty=7月実績数の合計、base/plan=単価×実績数の合計（÷qtyで加重平均になる）
     */
    avg_cnt?: number; avg_qty?: number | null; avg_base?: number | null;
    avg_plan_m0?: number | null; avg_plan_m1?: number | null; avg_plan_m2?: number | null; avg_plan_m3?: number | null;
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
  /**
   * 計画の日量換算に使った稼働日。
   * 実績の月（baseYm）の稼働日を1日あたりに直し、計画の月の稼働日を掛けている。
   * rate は実績の月に対する倍率（稼働日が分からない月は1＝換算なし）。
   */
  workdays?: {
    baseYm: string; baseDays: number | null;
    months: { ym: string; days: number | null; rate: number }[];
  };
  /**
   * 承認日の前後で分けた値上げ額の内訳（計画の月ごと）。
   * ym が境目の年月で、after=それ以降に承認された分、before=それより前の分。
   * 画面のほかの絞り込みは効いている（承認日の絞り込みだけ外して両側を出す）。
   */
  raiseSplit?: {
    ym: string;
    months: { ym: string; days: number | null; after: number; before: number;
      cntAfter: number; cntBefore: number }[];
  };
  /** 値上げ額の推移（取込ごと・全社の合計）。新しい取込が先頭 */
  raiseHistory?: RaiseDay[];
}

/**
 * 集計表に出す内容の切り替え。実績と計画を全部並べると横に長くなり、
 * スクロールしないと端まで見えないため、タブで出し分けて1画面に収める。
 */
const VIEWS = [
  { key: 'act' as const, label: '実績（売上改善額）' },
  { key: 'plan' as const, label: '計画（マスタ登録単価）' },
];

/**
 * 計画の月ひとつぶん。稼働日と、実績の月（売上高の月）に対する倍率。
 * 金額はサーバーで倍率を掛けたうえで返ってくるので、画面では
 * 比較のもと（現状額）に同じ倍率を掛けて同じ土俵に揃える。
 */
interface PlanMonth { ym: string; days: number | null; rate: number; baseYm: string; baseDays: number | null }

/** 稼働日の説明（見出し・マスに添える吹き出し） */
const planNote = (p?: PlanMonth) => (p?.days && p.baseDays
  ? `。${p.ym} は ${p.days}稼働日。`
    + `${p.baseYm}（${p.baseDays}稼働日）の日量へ直して ${p.days}日ぶんに換算しています`
  : '');

/** 値上げ額の内訳。器具区分別・支店別・法人別をそれぞれ別のカードで出す */
const TABS = [
  { key: 'equip' as const, label: '器具区分別', head: '器具区分', title: '器具区分別の値上げ額' },
  { key: 'branch' as const, label: '支店別', head: '支店', title: '支店別の値上げ額' },
  { key: 'corp' as const, label: '法人別', head: '法人', title: '法人別の値上げ額（現状額の大きい順）' },
];

/*
  金額の出し方。スマホでは桁が多いと表が読めないため、万円でまとめて出す。
  ダッシュボードを描くたびに Dashboard が下の目印を更新し、
  この中で使う金額の表示（表・タイル・まとめ）がまとめて切り替わる。
*/
let MONEY_MAN = false;
const yen = (v: number) => (MONEY_MAN
  ? `${Math.round(v / 1e4).toLocaleString()}万`
  : `¥${Math.round(v).toLocaleString()}`);



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

function sortValue(r: AbRow, col: SortCol, rates: number[] = []): number | string {
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
  // 値上げ額の大きい順に並べるため、A基準の列は現状額との差で比べる（案件一覧と同じ）。
  // 計画の金額は稼働日で日量換算してあるので、比べる現状額も同じ倍率に揃える
  const pre = num(r.base_amt);
  const at = (i: number) => (rates[i] > 0 ? rates[i] : 1);
  switch (col) {
    case 'name': return r.name ?? '';
    case 'deals': return num(r.deals);
    case 'qty': return num(r.qty);
    case 'base': return num(r.base_amt);
    case 'mp': return num(r.mp_amt);
    case 'a0': return num(r.a0_amt) - pre * at(0);
    case 'a1': return num(r.a1_amt) - pre * at(1);
    case 'a2': return num(r.a2_amt) - pre * at(2);
    case 'a3': return num(r.a3_amt) - pre * at(3);
    default: return 0;
  }
}

/**
 * 集計表。器具区分別・支店別・法人別で同じ形を使う。
 * 金額はすべて1か月あたり。各月は「A基準額 / 値上げ額（値上げ率）」の順に出す。
 * 見出しを押すとその列で並び替える（合計の行は常に一番下に置く）。
 */
function AbTable({ head, rows, total, months, actYms = [], m0, m1, m2, m3, plan, link, view }: {
  head: string; rows: AbRow[]; total?: AbRow;
  months: number; actYms?: string[]; m0: string; m1: string; m2: string; m3: string;
  /** 計画の月の稼働日と、実績の月に対する倍率（日量換算） */
  plan: PlanMonth[];
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
      const va = sortValue(a, sort.col, plan.map((x) => x.rate));
      const vb = sortValue(b, sort.col, plan.map((x) => x.rate));
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
            {view === 'plan' && ([[0, m0], [1, m1], [2, m2], [3, m3]] as [number, string][])
              .map(([i, label]) => (
                <Th key={label} col={`a${i}` as SortCol} right
                    title={`${label}の値上げ額（比較のもととの差）で並びます`
                      + `${planNote(plan[i])}`}>
                  {label}
                  {/* 日量換算に使った稼働日。何日ぶんの計画かをその場で分かるようにする */}
                  {plan[i]?.days ? <small>{` ${plan[i].days}日`}</small> : null}
                  <br /><small>マスタ登録単価額 / 値上げ額</small>
                </Th>
              ))}
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
                {/*
                  A基準（計画）は現状額と比べる。計画の金額は稼働日で日量換算して
                  あるため、比べる現状額も同じ倍率に揃える（同じ稼働日ぶんで比べる）
                */}
                {view === 'plan' && ([num(r.a0_amt), num(r.a1_amt), num(r.a2_amt), num(r.a3_amt)])
                  .map((amt, i) => (
                    <AmtCell key={i} amt={amt} base={pre * (plan[i]?.rate ?? 1)} months={months}
                             note={plan[i]?.days ? `${plan[i].days}稼働日ぶん` : undefined}
                             noteTitle={planNote(plan[i])} />
                  ))}
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
function AbCard({ title, head, rows, total, months, actYms, m0, m1, m2, m3, plan, link }: {
  title: string; head: string; rows: AbRow[]; total?: AbRow;
  months: number; actYms?: string[]; m0: string; m1: string; m2: string; m3: string;
  plan: PlanMonth[];
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
               m0={m0} m1={m1} m2={m2} m3={m3} plan={plan} view={view} link={link} />
    </div>
  );
}


/** 実績（過去最新単価 → 当月）の1件ぶん */
type ActualRow = NonNullable<DashboardRes['actuals']>[number];

/**
 * まとめ（実績と計画）の表。同じ中身を2通りの見方で出す。
 *
 *   byDays=true  … 計画の月を稼働日で日量換算した数字（その月に実際いくらになる見込みか）
 *   byDays=false … 実績の月の実績数そのままで計算した数字（換算前。月どうしを同じ土俵で見る）
 *
 * 金額はサーバーが換算後で返すため、換算なしの側は稼働日の倍率で割り戻す
 * （換算は掛け算だけなので、割り戻すと換算前の数字にきちんと戻る）。
 */
function SummaryCard({
  title, noteId, byDays, plan, t, act, gain, months, actYm, actLabel, baseName,
  split, trend, trendCount, trendNote, trendLabel, children,
}: {
  title: string;
  /** 説明の開閉を覚えるための目印。カードごとに変える */
  noteId: string;
  byDays: boolean;
  plan: PlanMonth[];
  t?: AbRow;
  act?: ActualRow;
  /** 売上改善額（プラスとマイナスの合計）。実績が無ければ null */
  gain: number | null;
  months: number;
  actYm: string;
  actLabel: string;
  baseName: string;
  split?: DashboardRes['raiseSplit'];
  /**
   * 計画の月ごとの前日比（取込の記録どうしの差）。出せないときは null。
   * 日付が変わっただけでは動かず、Excelを取り込んだときだけ変わる。
   */
  trend: (i: number) => number | null;
  /** 計画の月ごとの件数の前日比（新しく増えた案件・新しく承認された品目） */
  trendCount: (i: number) => number | null;
  /** 前日比の説明（見出しの吹き出しに出す。出せないときは理由） */
  trendNote: string;
  /** 見出しに添える比較先の日付（「8/21」）。比べられないときは空 */
  trendLabel: string;
  children?: React.ReactNode;
}) {
  // 換算なしの側は倍率で割り戻す。倍率の分からない月は1（そのまま）
  const rateOf = (i: number) => (plan[i]?.rate > 0 ? plan[i].rate : 1);
  const adj = (i: number) => (byDays ? 1 : 1 / rateOf(i));
  const splitYm = split?.ym ?? '';
  const hasTrend = Boolean(trendLabel);

  const rows = [
    // 値上げ前当初。当月の金額（合計）から売上改善額を引いたもの。値上げのスタート地点
    ...(gain != null ? [{
      key: 'pre', ym: `${actYm || '当月'} 値上げ前当初`, kind: '当初' as const,
      deals: num(t?.deals), base: null as number | null,
      amt: num(t?.base_amt) - gain, plan: -1,
      up: null as number | null, same: null as number | null,
    }] : []),
    // 実績。取り込んだ当月の金額そのもの（全品目）。値上げ前当初との差が売上改善額
    {
      key: 'base', ym: actYm || '当月', kind: '実績' as const,
      deals: num(t?.deals),
      base: (gain == null ? null : num(t?.base_amt) - gain) as number | null,
      amt: num(t?.base_amt), plan: -1,
      up: gain == null ? null : num(act?.up), same: gain == null ? null : num(act?.same),
    },
    // マスタ分。値決めどおりに出た分（土台との差が見積ぶんなど）
    ...(num(t?.mp_amt) > 0 ? [{
      key: 'mp', ym: `${actYm || '当月'}（マスタ）`, kind: '参考' as const,
      deals: num(t?.deals), base: num(t?.base_amt) as number | null, amt: num(t?.mp_amt),
      plan: -1, up: null as number | null, same: num(t?.mp_same) as number | null,
    }] : []),
    // 計画（マスタ登録単価）。月ごとに1行
    ...([[0, num(t?.a0_amt)], [1, num(t?.a1_amt)],
      [2, num(t?.a2_amt)], [3, num(t?.a3_amt)]] as [number, number][])
      .map(([i, amt]) => ({
        key: `plan-${i}`,
        // 換算した側だけ、何稼働日ぶんの計画かを月の横に出す
        ym: `${plan[i]?.ym || ''}${byDays && plan[i]?.days ? `（${plan[i].days}稼働日）` : ''}`,
        kind: '計画' as const,
        deals: num(t?.deals),
        // 比較のもとは実績（当月の金額）。換算した側は同じ倍率を掛けて土俵を揃える
        base: num(t?.base_amt) * (byDays ? rateOf(i) : 1) as number | null,
        amt: amt * adj(i), plan: i, up: null, same: null,
      })),
  ];

  return (
    <Card title={title}>
      <NoteFold id={noteId}>
        <strong>当初</strong>は値上げ前の金額で、{actLabel}の金額（合計）から
        <strong>売上改善額</strong>（＝（{actLabel}のマスタ単価 − 過去最新単価）× マスタ分の数量）を
        引いたものです。上がった品目のプラスと、下がった品目のマイナスを合わせた額を引いています。
        <strong>実績</strong>は{actLabel}の金額（合計）そのもので、当初との差が売上改善額になります。
        <strong>計画</strong>は、この{actLabel}の金額（合計）へ
        「マスタ登録単価 − {baseName}」×{actLabel}の実績数を足したものです。
        {byDays
          ? <>　この表は月ごとの<strong>稼働日で日量換算</strong>してあり、
              比較のもとにも同じ倍率を掛けています（値上げ率は換算の前後で変わりません）。</>
          : <>　この表は<strong>換算をしていません</strong>。どの月も{actLabel}の実績数のままなので、
              月どうしを同じ土俵で見比べられます
              （案件一覧の「値上げ額（月）合計」と同じ数字です）。</>}
        <strong>参考</strong>の行は、そのうち値決めどおりに出た分（金額（マスタ））で、
        実績との差が見積ぶんなどにあたります。
        {splitYm && <>　<strong>うち承認日</strong>の2列は、計画の値上げ額を
          マスタ承認日で分けたものです（{splitYm}以降が今回の取り組みで承認された分）。
          承認日の入っていないものはどちらにも入れていません。</>}
        {hasTrend && <>　<strong>{trendLabel} 前日比</strong>は、
          <strong>いちばん新しい取込</strong>と<strong>その1つ前の取込（{trendLabel}）</strong>の
          値上げ額の差です。<strong>次にExcelを取り込むまで変わりません</strong>
          （日付が変わっただけでは動きません）。取込日が飛んでいても1つ前の取込と比べます。
          毎日の取込で変わるのは<strong>マスタ登録単価（当月・翌月・翌々月・3か月後）</strong>だけなので、
          この差はその動きを表します（過去最新単価や数量は売上高の取込で入るため、
          毎日の取込では変わりません）。金額の下の<strong>件数</strong>は、
          承認日以降の品目が何件増えたか（新しく増えた案件・新しく承認された分）です。</>}
      </NoteFold>
      {children}
      <div className="tbl-scroll">
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
              <th style={nums} title={trendNote}>
                {trendLabel ? `${trendLabel} 前日比` : '前日比'}
                <br /><small>前回の取込から</small>
              </th>
              {splitYm && (
                <>
                  <th style={nums} title={`値上げ額のうち、${splitYm}以降に承認された分`}>
                    うち承認日<br /><small>{splitYm} 以降</small>
                  </th>
                  <th style={nums} title={`値上げ額のうち、${splitYm}より前に承認されていた分`}>
                    うち承認日<br /><small>{splitYm} より前</small>
                  </th>
                </>
              )}
              <th style={nums} title="値上げ額 ÷ 現状額">値上げ率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const up = row.base == null ? null : row.amt - row.base;
              const pct = row.base != null && row.base > 0
                ? Math.round((up! / row.base) * 1000) / 10 : null;
              // 承認日の前後の内訳と前日比は、計画の行にだけ出す
              const sp = row.plan >= 0 ? split?.months?.[row.plan] : undefined;
              const rawDiff = row.plan >= 0 ? trend(row.plan) : null;
              // 1円に満たない差は計算上の端数なので「変わっていない」として扱う
              const diff = rawDiff != null && Math.abs(rawDiff) < 0.5 ? 0 : rawDiff;
              // 件数の増減（新しく増えた案件・新しく承認された品目）
              const cntDiff = row.plan >= 0 ? trendCount(row.plan) : null;
              const money = (v: number | null | undefined, sign = true) => (v == null ? '—'
                : v === 0 ? '—'
                  : `${sign ? (v > 0 ? '＋' : '−') : ''}${yen(Math.abs(v) / months)}`);
              const color = (v: number | null | undefined) => (v == null || v === 0 ? undefined
                : v < 0 ? '#c2410c' : '#15803d');
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
                  <td style={{ ...nums, fontWeight: 700, color: color(up) }}>{money(up)}</td>
                  {/* 前日比。記録と同じ条件（全社・絞り込みなし）のときだけ出す */}
                  <td style={{ ...nums, fontWeight: 700, color: color(diff) }}
                      title={diff == null && row.plan >= 0 ? trendNote
                        : cntDiff != null
                          ? `承認日 ${splitYm}以降の品目が ${cntDiff >= 0 ? '＋' : '−'}`
                            + `${Math.abs(cntDiff).toLocaleString()}件（新しく増えた案件・新しく承認された分）`
                          : undefined}>
                    {row.plan < 0 ? '—' : diff == null ? '—' : diff === 0 ? '±0' : money(diff)}
                    {/* 金額だけでは「案件が増えたのか単価が動いたのか」が分からないため、
                        承認済みの件数の増減も添える */}
                    {diff != null && cntDiff != null && cntDiff !== 0 && (
                      <div style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginTop: 2 }}>
                        {cntDiff > 0 ? '＋' : '−'}{Math.abs(cntDiff).toLocaleString()}件
                      </div>
                    )}
                  </td>
                  {splitYm && (
                    <>
                      <td style={{ ...nums, fontWeight: 700, color: color(sp ? sp.after : null) }}
                          title={sp ? `${sp.cntAfter.toLocaleString()}件` : undefined}>
                        {sp ? money(sp.after * adj(row.plan)) : '—'}
                      </td>
                      <td style={{ ...nums, color: 'var(--muted)' }}
                          title={sp ? `${sp.cntBefore.toLocaleString()}件` : undefined}>
                        {sp ? money(sp.before * adj(row.plan)) : '—'}
                      </td>
                    </>
                  )}
                  <td style={nums}>{pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
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
        // 既定は「今回の取り組みが始まった月（RAISE_START_YM）以降に承認された単価だけ」。
        // それより前の承認は前回までの古い単価が多く、値上げ額として見ると実態と合わない。
        // 全期間を見たいときは承認日の欄を空にする。
        if (!params.get('aDateYm')) {
          const next = new URLSearchParams(params);
          next.set('aDateYm', RAISE_START_YM);
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
  // 計画の月の稼働日（日量換算）。サーバーが金額に倍率を掛けたうえで返すので、
  // 画面では比較のもと（現状額）へ同じ倍率を掛けて同じ土俵に揃える
  const wd = data.workdays;
  const plan: PlanMonth[] = [0, 1, 2, 3].map((i) => ({
    ym: wd?.months?.[i]?.ym || [m0, m1, m2, m3][i],
    days: wd?.months?.[i]?.days ?? null,
    rate: Number(wd?.months?.[i]?.rate) > 0 ? Number(wd!.months[i].rate) : 1,
    baseYm: wd?.baseYm || '',
    baseDays: wd?.baseDays ?? null,
  }));
  /** 稼働日での換算が効いているか（実績の月と計画の月の日数が分かっているか） */
  const hasWorkdays = Boolean(wd?.baseDays) && plan.some((x) => x.days);

  const actYm = data.actuals?.[0]?.ym ?? '';
  const actLabel = actYm ? `${Number(actYm.slice(5, 7))}月` : '当月';
  // 値上げ幅の基準（比較のもと）。案件一覧と同じ選び方
  const base = BASE_OPTIONS.find((o) => o.key === get('base'))?.key ?? 'master';
  const baseName = base === 'past' ? '過去最新単価'
    : base === 'actual' ? `${actLabel}の実単価` : `${actLabel}のマスタ単価`;

  /*
    前日比（前回の取込との差）。

    取込のたびに残している記録どうし、つまり
    「いちばん新しい取込」と「その1つ前の取込」を比べる。
    こうすると日付が変わっただけでは動かず、Excelを取り込んだときだけ変わる。
    取込日が飛んでいても（8/24 の次が 8/21 でも）1つ前の取込と比べる。

    記録は「全社・絞り込みなし・承認日は既定」で取ったものなので、
    画面がその条件と違うときは出さない（違う条件の数字と引き算しても意味が無いため）。
    値上げ幅の基準は3つとも記録しているので、画面で選んだ基準と同じものを使う。
  */
  const trendDays = data.raiseHistory ?? [];
  /** いちばん新しい取込と、その1つ前の取込 */
  const trendCur = trendDays[0];
  const trendPrev = trendDays[1];
  /** 記録は基準ごとに残している。画面で選んでいる基準が両方の記録にあるか */
  const hasBase = (d?: RaiseDay) => (d?.months.some((m) => m.byBase?.[base]?.after != null) ?? false);
  const trendHasBase = hasBase(trendCur) && hasBase(trendPrev);
  const trendSame = data.scope?.level === 'all'
    && !FILTER_KEYS.some((k) => k !== 'aDateYm' && k !== 'aDateOp' && k !== 'base' && get(k))
    && (get('aDateYm') || '') === (trendPrev?.aDateYm ?? '')
    && (get('aDateOp') || 'from') === 'from'
    && trendHasBase;
  const baseLabel = BASE_OPTIONS.find((o) => o.key === base)?.label ?? '';
  const trendNote = !trendPrev
    ? '前回の取込の記録がまだありません（次の取込から出ます）'
    : trendSame
      ? `いちばん新しい取込（${dayLabel(trendCur.takenOn)}）と`
        + `その1つ前の取込（${dayLabel(trendPrev.takenOn)}）の差です`
        + `（基準は${baseLabel}）。次にExcelを取り込むまで変わりません`
      : !trendHasBase
        ? `${dayLabel(trendPrev.takenOn)}の記録に「${baseLabel}」を基準にした値がありません`
          + '（この基準を残すようになる前の記録です。次の取込から出ます）'
        : '絞り込み中は出せません（記録は全社・絞り込みなしの合計のため、「解除」で出ます）';
  /** 見出しに添える比較先の日付（「8/21」）。比べられないときは空 */
  const trendLabel = trendPrev && trendSame ? dayLabel(trendPrev.takenOn) : '';
  /**
   * 計画の月ぶんの前日比。取込の記録どうしの差なので、画面を開き直しても
   * 日付が変わっても動かない（次にExcelを取り込んだときだけ変わる）。
   * byDays=false の表では稼働日の倍率で割り戻し、その表と同じ土俵に揃える。
   */
  const trendOf = (i: number, byDays: boolean): number | null => {
    if (!trendSame || !trendCur || !trendPrev) return null;
    const ym = plan[i]?.ym;
    const now = trendCur.months.find((x) => x.ym === ym)?.byBase?.[base]?.after;
    const was = trendPrev.months.find((x) => x.ym === ym)?.byBase?.[base]?.after;
    if (now == null || was == null) return null;
    const rate = plan[i]?.rate > 0 ? plan[i].rate : 1;
    return (now - was) * (byDays ? 1 : 1 / rate);
  };
  /**
   * 件数の前日比。承認日以降の計画が入っている品目の増減で、
   * 新しく増えた案件や、新しく承認された品目のぶんが出る。
   * 金額と同じく、取込の記録どうしで比べる。
   */
  const trendCountOf = (i: number): number | null => {
    if (!trendSame || !trendCur || !trendPrev) return null;
    const ym = plan[i]?.ym;
    const now = trendCur.months.find((x) => x.ym === ym);
    const was = trendPrev.months.find((x) => x.ym === ym);
    if (!now || !was) return null;
    return now.cntAfter - was.cntAfter;
  };
  // 過去最新単価は「いつまでの受注か」を添える（取込のたびに動くのでデータから取る）
  const pastMax = meta?.pastMax ?? '';
  const pastUntil = base === 'past' && /^\d{4}-\d{2}/.test(pastMax)
    ? `（${Number(pastMax.slice(0, 4))}年${Number(pastMax.slice(5, 7))}月まで）` : '';
  // 承認日の条件。絞り込みで変わる
  const aDateText = get('aDateYm')
    ? `${Number(get('aDateYm').slice(0, 4))}年${Number(get('aDateYm').slice(5, 7))}月${get('aDateOp') === 'before' ? 'より前' : '以降'}`
    : '全期間';
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
        <strong>値上げ額</strong>は、<strong>{baseName}{pastUntil}</strong>から、
        マスタ承認日 <strong>{aDateText}</strong>のアップ額を、計画の月ごとに示します。
        実績数は<strong>{actLabel}</strong>（価格調査の取込月）。
        金額はすべて<strong>1か月あたり</strong>です。
        {hasWorkdays && (
          <>
            {' '}計画の月は<strong>稼働日で日量換算</strong>しています
            （{actLabel}の{wd?.baseDays}稼働日を1日あたりに直し、
            {plan.filter((x) => x.days).map((x) => `${Number(x.ym.slice(5, 7))}月${x.days}日`).join('・')}
            を掛けています）。
          </>
        )}
        　表示範囲: <strong>{data.scope.label}</strong>
      </p>
      <NoteFold id="page">
        <strong>値上げ額</strong>は「マスタ登録単価 − <strong>{baseName}</strong>」×{actLabel}の実績数です
        （比較のもとは<strong>基準</strong>で選べます）。
        {baseName}が無い品目・{actLabel}の実績数が無い品目は<strong>変動なし</strong>として扱います。
        <strong>承認日</strong>は既定で<strong>当月以降に承認された単価だけ</strong>を見ています
        （それより前は値上げ前の古い単価が多いため）。欄を空にすると全期間になります。
        <strong>値上げ前当初</strong>は、{actLabel}の金額（合計）から売上改善額を引いた額です。
        下の表の<strong>現状額</strong>は{actLabel}の金額（合計）そのもので、
        各月の<strong>マスタ登録単価額</strong>はそこへ値上げ額を足した金額。
        その差が値上げ額、現状額に対する割合が<strong>値上げ率</strong>です。
        {hasWorkdays && (
          <>
            {' '}数量は{actLabel}の実績数をそのまま使うため、計画の各月は
            <strong>稼働日で日量に直して換算</strong>しています
            （{actLabel} {wd?.baseDays}稼働日 ＝ 1か月ぶん）。
            比べる相手の<strong>現状額も同じ稼働日ぶん</strong>に揃えているので、
            値上げ率は換算の前後で変わりません
            （案件一覧の「値上げ額（月）合計」は換算前の{actLabel}ぶんです）。
          </>
        )}
      </NoteFold>

      {/*
        絞り込み。項目が多いので段を決めて並べる（画面の幅で並びが変わらないように）。
          1段目 だれの・どこの案件か（検索・企業・支店・営業所・担当者）
          2段目 どの品目か（器具区分 → カテゴリー名（大）→ 品目階層名）
          3段目 どう数えるか（基準・マスタ登録単価・売上高・承認日・売上改善額）
        絞り込みの項目は案件一覧とそろえる（同じ条件で見比べられるように）。
      */}
      <div className="filters rows">
        <div className="frow">
        <label className="fld" title="得意先の業種（プロパン会社・都市ガス会社など）。選ぶと、業種の入っていない品目は対象から外れます">
          業種
          <select value={get('industry')} onChange={(e) => setParam('industry', e.target.value)}>
            <option value="">すべて</option>
            {meta?.industries?.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
        </label>
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
        <label className="fld">
          担当者
          <select value={get('person')} onChange={(e) => setParam('person', e.target.value)}>
            <option value="">すべて</option>
            {meta?.persons.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
        </div>

        {/* 2段目。品目の絞り込みは 器具区分（大分類）→ カテゴリー名（大）→ 品目階層名 の順 */}
        <div className="frow">
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
        </div>

        {/* 3段目。値上げ額をどう数えるか（基準・対象の条件） */}
        <div className="frow">
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
        まとめ（実績と計画）。稼働日で日量換算した表と、換算前（実績の月の実績数の
        まま）の表を並べて出す。前者はその月にいくらになる見込みか、
        後者は月どうしを同じ土俵で見比べるためのもの。
      */}
      <SummaryCard
        title={`まとめ（実績と計画）　稼働日で日量換算${get('aDateYm') ? `　承認日 ${get('aDateYm')} ${get('aDateOp') === 'before' ? 'より前' : '以降'}` : ''}`}
        noteId="summary" byDays plan={plan} t={t} act={act} gain={gain} months={months}
        actYm={actYm} actLabel={actLabel} baseName={baseName}
        split={data.raiseSplit} trend={(i) => trendOf(i, true)}
        trendCount={trendCountOf} trendNote={trendNote} trendLabel={trendLabel}
      >
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
      </SummaryCard>

      {/* 稼働日で換算する前（どの月も実績の月の実績数のまま）。
          換算のある月がある場合だけ出す（無ければ上の表と同じ数字になるため） */}
      {hasWorkdays && (
        <SummaryCard
          title={`まとめ（${actLabel}の実績数ベース）　稼働日の換算なし`}
          noteId="summary-raw" byDays={false} plan={plan} t={t} act={act} gain={gain}
          months={months} actYm={actYm} actLabel={actLabel} baseName={baseName}
          split={data.raiseSplit} trend={(i) => trendOf(i, false)}
          trendCount={trendCountOf} trendNote={trendNote} trendLabel={trendLabel}
        />
      )}

      {/*
        承認日の前後の内訳は、まとめの表の「うち承認日」の列に出している。
        取込ごとの推移（取込履歴）は Excel取込の画面に置いてある。
      */}

      {/*
        値上げ額の内訳。器具区分別・支店別・法人別をそれぞれ別のカードで縦に並べ、
        カードの中の切り替えで実績（売上改善額）と計画（マスタ登録単価）を見る。
      */}
      {TABS.map((x) => (
        <AbCard key={x.key} title={x.title} head={x.head} rows={rowsOf(x.key)}
                total={t} months={months} actYms={data.abActYms}
                m0={m0} m1={m1} m2={m2} m3={m3} plan={plan}
                link={(name, kind) => dealsLink(kind, { [x.key]: name ?? '' })} />
      ))}
      </div>

    </div>
  );
}

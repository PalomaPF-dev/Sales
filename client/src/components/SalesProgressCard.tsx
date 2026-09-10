import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, NoteFold, nums } from './ui';
import { useIsMobile } from '../view';
import { dayLabel, ymLabel } from './RaiseTrend';

/** 売上高の取込1回ぶんの合計（サーバーが取込のたびに残す） */
interface ProgressRow {
  ym: string;
  asOf: string;             // データの日付（月次のときは月の末日）
  final: boolean;           // 月次（確定）の取込
  elapsedDays: number | null;
  workDays: number | null;
  deals: number;
  qty: number;
  amount: number;
  planQty: number;
  planAmount: number;
  /** 売上改善額（マスタ）の合計。ファイルに列があった取込だけ（無い取込は null） */
  gainAmount: number | null;
  filename: string | null;
  takenAt: string;
}

interface ProgressRes {
  current: {
    ym: string | null; mode: 'monthly' | 'daily'; asOf: string | null;
    elapsedDays: number | null; workDays: number | null; filename: string | null;
  } | null;
  rows: ProgressRow[];
  /** 月ごとの総額（月別の実績の合計）。日次の記録が無い月も総額はここから分かる */
  totals: { ym: string; deals: number; qty: number; amount: number; gainAmount: number | null;
    workDays: number | null }[];
}

/** 「2026-09」の1つ前の月 */
const prevYm = (ym: string) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/**
 * 売上高（当月）の進捗。日次（当月の累計）の取込のたびに残している合計を、
 * データの日付ごとに並べる。
 *
 * 月の中でいくら積み上がってきたか（前回比）と、その日までの稼働日から見た
 * 日量・月末の見込み、前の月の総額に対してどこまで来たかを出す。
 * 月末に月次（確定）を取り込むと、その月の末日の行として同じ表に並ぶので、
 * 日次の累計が確定の総額へ積み上がったかをそのまま確かめられる。
 *
 * 取込の記録（値上げ額の推移）と同じく、全社・絞り込みなしの合計。
 * reloadKey が変わると取り直す（取込のあとに最新を出すため）。
 */
export default function SalesProgressCard({ reloadKey = 0, showEmpty = false, title = '売上高（当月）の進捗（日次取込）' }: {
  reloadKey?: number; showEmpty?: boolean; title?: string;
}) {
  const mobile = useIsMobile();
  const [data, setData] = useState<ProgressRes | null>(null);
  const [ym, setYm] = useState('');

  useEffect(() => {
    api<ProgressRes>('/sales-progress')
      .then((r) => {
        setData(r);
        // 既定は案件に入っている月（最後に取り込んだ月）。記録が無ければ記録のある一番新しい月
        const yms = [...new Set(r.rows.map((x) => x.ym))];
        const cur = r.current?.ym && yms.includes(r.current.ym) ? r.current.ym : (yms[0] ?? '');
        setYm((v) => (v && yms.includes(v) ? v : cur));
      })
      .catch(() => setData(null));
  }, [reloadKey]);

  if (!data) return null;
  const yms = [...new Set(data.rows.map((x) => x.ym))];
  if (!yms.length) {
    if (!showEmpty) return null;
    return (
      <Card title={title}>
        <p className="pt-note" style={{ marginTop: 0 }}>
          まだ記録がありません。③の日次取込で当月の累計を取り込むと、ここに日ごとの積み上がりが残ります
          （②の月次取込もその月の末日の行として残ります）。
        </p>
      </Card>
    );
  }
  const rows = data.rows.filter((x) => x.ym === ym);   // 新しい日付が先頭
  const latest = rows[0];
  // 売上改善額の列は、その月の記録に1つでも値があるときだけ出す
  const hasGain = rows.some((x) => x.gainAmount != null);
  // 比べる相手は前の月の総額。前の月が無いときは、それより前で一番新しい月
  const prev = data.totals.find((t) => t.ym === prevYm(ym))
    ?? data.totals.find((t) => t.ym < ym);
  // スマホでは桁が多いと表が読めないため、万円でまとめて出す（値上げ額の推移と同じ）
  const yen = (v: number) => (mobile
    ? `${Math.round(v / 1e4).toLocaleString()}万`
    : `¥${Math.round(v).toLocaleString()}`);
  const int = (v: number) => Math.round(v).toLocaleString();
  const pct = (v: number, base?: number) => (base && base > 0
    ? `${(v / base * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '—');
  /** 1稼働日あたりの金額と、そのペースで月末まで行ったときの見込み */
  const perDay = (r: ProgressRow) => (r.elapsedDays && r.elapsedDays > 0 ? r.amount / r.elapsedDays : null);
  const forecast = (r: ProgressRow) => {
    const d = perDay(r);
    return d != null && r.workDays ? d * r.workDays : null;
  };
  const diffCell = (v: number | null, fmt: (x: number) => string) => (
    <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2,
                  color: v == null ? 'var(--muted)' : v < 0 ? '#c2410c' : v > 0 ? '#15803d' : 'var(--muted)' }}>
      {v == null ? '—' : v === 0 ? '±0' : `${v > 0 ? '＋' : '−'}${fmt(Math.abs(v))}`}
    </div>
  );

  return (
    <Card title={title}>
      <NoteFold id="sales-progress">
        <strong>③日次（当月の累計）</strong>の取込のたびに、その時点の<strong>当月の合計</strong>
        （件数・数量・金額）をデータの日付ごとに残しています。
        <strong>前回比</strong>は1つ前の日付の記録との差（＝その間に積み上がった分）。
        <strong>売上改善額</strong>はファイルの「売上改善額（マスタ）」の合計です
        （列の無い取込では出ません）。
        <strong>日量</strong>は金額をその日までの稼働日で割ったもの、
        <strong>月末見込</strong>はその日量でその月の稼働日ぶん行ったときの金額です。
        <strong>前月比</strong>は前の月の総額（月別の実績の合計）に対する割合で、
        月末に近づくほど100%前後へ寄っていくのが目安です。
        ②月次（確定）を取り込むと、その月の末日の行（<span className="badge green">確定</span>）として並びます。
        金額は<strong>全社・絞り込みなし</strong>で、画面の絞り込みでは変わりません。
      </NoteFold>

      {/* 月の切り替えと、いちばん新しい記録のまとめ */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        {yms.length > 1 && (
          <label className="fld" style={{ maxWidth: 160 }}>
            <span style={{ fontSize: 12.5 }}>実績の月</span>
            <select value={ym} onChange={(e) => setYm(e.target.value)}>
              {yms.map((y) => <option key={y} value={y}>{ymLabel(y)}</option>)}
            </select>
          </label>
        )}
        {latest && (
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <strong>{ymLabel(ym)}</strong>
            {latest.final ? ' 総額（確定）' : ` ${dayLabel(latest.asOf)}時点の累計`}：
            金額 <strong>{yen(latest.amount)}</strong>
            ・数量 {int(latest.qty)}・{int(latest.deals)}件
            {latest.gainAmount != null && (
              <>・売上改善額 <strong style={{ color: latest.gainAmount < 0 ? '#c2410c' : '#15803d' }}>
                {latest.gainAmount < 0 ? '−' : '＋'}{yen(Math.abs(latest.gainAmount))}</strong></>
            )}
            {!latest.final && latest.elapsedDays != null && (
              <>
                ・稼働日 {latest.elapsedDays}{latest.workDays ? ` / ${latest.workDays}` : ''}日
                {perDay(latest) != null && <>・日量 {yen(perDay(latest)!)}</>}
                {forecast(latest) != null && <>・月末見込 <strong>{yen(forecast(latest)!)}</strong></>}
              </>
            )}
            {prev && (
              <>
                ・{ymLabel(prev.ym)}総額 {yen(prev.amount)} に対して <strong>{pct(latest.amount, prev.amount)}</strong>
              </>
            )}
          </div>
        )}
      </div>

      <div className="tbl-scroll" style={{ maxHeight: 420 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>日付</th>
              <th>取込</th>
              <th style={nums} title="その日までの稼働日 / その月の稼働日">稼働日</th>
              <th style={nums}>件数<br /><small>/ 前回比</small></th>
              <th style={nums}>数量<br /><small>/ 前回比</small></th>
              <th style={nums}>金額（合計）<br /><small>/ 前回比</small></th>
              {hasGain && (
                <th style={nums} title="ファイルの「売上改善額（マスタ）」の合計">
                  売上改善額<br /><small>/ 前回比</small>
                </th>
              )}
              <th style={nums} title="金額 ÷ その日までの稼働日">日量</th>
              <th style={nums} title="日量 × その月の稼働日">月末見込</th>
              {prev && <th style={nums} title={`${ymLabel(prev.ym)}の総額 ${yen(prev.amount)} に対する割合`}>
                {ymLabel(prev.ym)}比
              </th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const before = rows[i + 1];   // 1つ前の日付の記録
              const d = perDay(r);
              const fc = forecast(r);
              return (
                <tr key={r.asOf}>
                  <td title={`${r.asOf}${r.filename ? ` / ${r.filename}` : ''}`}>
                    <strong>{r.final ? `${ymLabel(r.ym)}末` : dayLabel(r.asOf)}</strong>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      {before ? `${before.final ? `${ymLabel(before.ym)}末` : dayLabel(before.asOf)}比` : '比較なし'}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${r.final ? 'green' : 'blue'}`}>
                      {r.final ? '確定' : '日次'}
                    </span>
                  </td>
                  <td style={nums}>
                    {r.elapsedDays == null ? '—' : `${r.elapsedDays}${r.workDays ? ` / ${r.workDays}` : ''}`}
                  </td>
                  <td style={nums}>
                    {int(r.deals)}
                    {diffCell(before ? r.deals - before.deals : null, int)}
                  </td>
                  <td style={nums}>
                    {int(r.qty)}
                    {diffCell(before ? r.qty - before.qty : null, int)}
                  </td>
                  <td style={nums}>
                    {yen(r.amount)}
                    {diffCell(before ? r.amount - before.amount : null, yen)}
                  </td>
                  {hasGain && (
                    <td style={nums}>
                      {r.gainAmount == null ? '—'
                        : <span style={{ color: r.gainAmount < 0 ? '#c2410c' : undefined }}>
                            {r.gainAmount < 0 ? '−' : ''}{yen(Math.abs(r.gainAmount))}
                          </span>}
                      {diffCell(before && r.gainAmount != null && before.gainAmount != null
                        ? r.gainAmount - before.gainAmount : null, yen)}
                    </td>
                  )}
                  <td style={nums}>{d == null ? '—' : yen(d)}</td>
                  <td style={nums}>{fc == null ? '—' : yen(fc)}</td>
                  {prev && <td style={nums}>{pct(r.amount, prev.amount)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

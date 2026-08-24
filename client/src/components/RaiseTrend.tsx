import { Card, NoteFold, nums } from './ui';
import { useIsMobile } from '../view';

/**
 * 値上げ額の履歴1日ぶん。取込のたびにサーバーが1件残す。
 * 計画の月は取込のたびにずれるため、月ごとの行を持つ形にしてある。
 */
export interface RaiseDay {
  takenOn: string;
  takenAt: string;
  source: string | null;
  filename: string | null;
  actYm: string | null;
  deals: number;
  baseAmt: number;
  aDateYm: string | null;
  months: {
    ym: string; days: number | null; baseDays: number | null; planAmt: number;
    after: number; before: number; cntAfter: number; cntBefore: number;
  }[];
}

/** 「2026-08-24」→「8/24」。年は吹き出しで見せる */
export const dayLabel = (d: string) =>
  (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : d);
/** 「2025-08」→「8月」 */
export const ymLabel = (ym: string) => (/^\d{4}-\d{2}$/.test(ym) ? `${Number(ym.slice(5, 7))}月` : ym);

/**
 * 値上げ額の推移。取込のたびに残している合計を、取込日ごとに並べる。
 *
 * 毎日取り込み直すとマスタ登録単価が入れ替わって値上げ額も動くため、
 * 前回の取込からいくら動いたか（前日比）を各マスに添える。
 * ここだけは絞り込みの効かない全社の合計（記録した時点の値）を出す。
 *
 * ダッシュボードとExcel取込の両方から同じ形で出す。
 */
export default function RaiseTrendCard({ days, title = '値上げ額の推移（取込日ごと）' }: {
  days: RaiseDay[]; title?: string;
}) {
  const mobile = useIsMobile();
  // スマホでは桁が多いと表が読めないため、万円でまとめて出す（ダッシュボードと同じ）
  const yen = (v: number) => (mobile
    ? `${Math.round(v / 1e4).toLocaleString()}万`
    : `¥${Math.round(v).toLocaleString()}`);
  // 計画の月は取込のたびにずれることがあるので、出てきた月をすべて集めて並べる
  const yms = [...new Set(days.flatMap((d) => d.months.map((m) => m.ym)))].sort();
  if (!days.length || !yms.length) return null;
  const at = (d: RaiseDay, ym: string) => d.months.find((m) => m.ym === ym);
  const prev = days[1];
  return (
    <Card title={title}>
      <NoteFold id="trend">
        取込のたびに、そのときの<strong>値上げ額の合計</strong>を計画の月ごとに残しています。
        マスの下の数字は<strong>1つ前の取込との差</strong>
        {prev ? `（${dayLabel(days[0].takenOn)} は ${dayLabel(prev.takenOn)} 比）` : ''}です。
        取込日が飛んでいても、その行のすぐ下（1つ前の取込）と比べます。
        金額は<strong>全社・絞り込みなし</strong>、基準は<strong>マスタ単価</strong>、
        承認日は<strong>{days[0].aDateYm ?? ''}以降</strong>の分で、
        稼働日での日量換算をしたあとの1か月あたりの額です
        （画面の絞り込みでは変わりません）。
        マスにカーソルを当てると、承認日より前の分と合計も出ます。
      </NoteFold>
      <div className="tbl-scroll" style={{ maxHeight: 420 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>取込日</th>
              <th>取込</th>
              <th style={nums}>件数</th>
              {yms.map((ym) => (
                <th key={ym} style={nums}>
                  {ymLabel(ym)} 計画<br />
                <small>値上げ額 / {prev ? `${dayLabel(prev.takenOn)}比` : '前回比'}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => {
              // 1つ前（＝1回前の取込）と比べる。一番古い行は比べる相手が無い
              const before = days[i + 1];
              return (
                <tr key={d.takenOn}>
                  <td title={`${d.takenOn}${d.filename ? ` / ${d.filename}` : ''}`}>
                    <strong>{dayLabel(d.takenOn)}</strong>
                  </td>
                  <td>
                    <span className={`badge ${d.source === 'survey' ? 'gray'
                      : d.source === 'manual' ? 'violet' : 'blue'}`}>
                      {d.source === 'survey' ? '売上高'
                        : d.source === 'manual' ? '記録のみ' : '価格調査'}
                    </span>
                  </td>
                  <td style={nums}>{d.deals.toLocaleString()}</td>
                  {yms.map((ym) => {
                    const cur = at(d, ym);
                    if (!cur) return <td key={ym} style={nums}>—</td>;
                    const old = before ? at(before, ym) : undefined;
                    const diff = old ? cur.after - old.after : null;
                    return (
                      <td key={ym} style={nums}
                          title={`承認日 ${d.aDateYm ?? ''}以降 ${Math.round(cur.after).toLocaleString()}円`
                            + ` / より前 ${Math.round(cur.before).toLocaleString()}円`
                            + ` / 合計 ${Math.round(cur.after + cur.before).toLocaleString()}円`
                            + `（${cur.cntAfter.toLocaleString()}件 / ${cur.cntBefore.toLocaleString()}件）`
                            + (before ? `\n前回比は ${dayLabel(before.takenOn)} との差です` : '')}>
                        {yen(cur.after)}
                        <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2,
                                      color: diff == null ? 'var(--muted)'
                                        : diff < 0 ? '#c2410c' : diff > 0 ? '#15803d' : 'var(--muted)' }}>
                          {diff == null ? '—'
                            : diff === 0 ? '±0'
                              : `${diff > 0 ? '＋' : '−'}${yen(Math.abs(diff))}`}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

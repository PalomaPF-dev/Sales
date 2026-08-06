import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card } from '../components/ui';
import type { Meta } from '../types';

/** 案件一覧と同じ絞り込みを受ける。集計と一覧を同じ条件で行き来できるようにするため */
const FILTER_KEYS = ['q', 'equip', 'person', 'corp', 'branch', 'office', 'r2State', 'below'] as const;

/** 進捗の数え方はサーバーと揃える（件数と割合。金額は扱わない） */
interface Progress {
  deals: number;
  r2_done: number;
  r2_agreed: number;
  r2_open: number;
  /** 合意単価が目標に届かなかった件数 */
  r2_below: number;
}

interface Row extends Progress {
  name?: string | null;
  branch?: string | null;
  office?: string | null;
}

/** 支店別の値上げ額（目標と実績）。達成率はここから計算する */
interface BranchAmount {
  branch: string | null;
  deals: number;
  r2_target_amount: number;
  r2_agreed_amount: number;
}

/** A基準とB基準の妥結進捗（マスタ登録の行の集計） */
interface AbRow {
  name?: string | null;
  deals: number;
  qty: number;
  a_amt: number;
  b_rows: number;
  b_qty: number;
  b_amt: number;
  settle_diff: number;
}

interface DashboardRes {
  scope: { level: string; label: string; missing?: string; note?: string };
  totals: Progress;
  abTotals?: AbRow;
  abByEquip?: AbRow[];
  abByCorp?: AbRow[];
  byBranchAmount: BranchAmount[];
  amountTotals: BranchAmount;
  byOffice: Row[];
  byPerson: Row[];
  byEquip: Row[];
  corpStatus: { status: string; corps: number }[];
  applied: { ym: string; r2: number }[];
  corpStatuses: { code: string; name: string }[];
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const num = (n: unknown) => Number(n ?? 0);

/** 進捗の帯。完了・合意済・未入力の3段階を並べて、量と割合を同時に見せる */
function Bar({ done, agreed, total }: { done: number; agreed: number; total: number }) {
  const d = pct(done, total);
  const a = pct(agreed, total);
  return (
    <div className="pbar" title={`完了 ${done.toLocaleString()} / 合意済 ${agreed.toLocaleString()} / 全${total.toLocaleString()}`}>
      <span className="seg done" style={{ width: `${d}%` }} />
      <span className="seg agreed" style={{ width: `${a}%` }} />
    </div>
  );
}

const yen = (v: number) => `¥${Math.round(v).toLocaleString()}`;

/** 達成率。目標が無い場合は「—」 */
function Rate({ agreed, target }: { agreed: number; target: number }) {
  if (!(target > 0)) return <span style={{ color: 'var(--muted)' }}>—</span>;
  const r = Math.round((agreed / target) * 1000) / 10;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                   color: r >= 100 ? 'var(--ok, #047857)' : undefined }}>
      {r.toLocaleString()}%
    </span>
  );
}

/** 達成率の帯（100%を上限に塗る） */
function RateBar({ agreed, target }: { agreed: number; target: number }) {
  if (!(target > 0)) return null;
  const w = Math.max(0, Math.min(100, (agreed / target) * 100));
  return (
    <div className="pbar" title={`実績 ${yen(agreed)} / 目標 ${yen(target)}`}>
      <span className="seg done" style={{ width: `${w}%` }} />
    </div>
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

/** 集計表。行の見出しだけ差し替えて使い回す */
function ProgressTable({ rows, head, onPick }: {
  rows: Row[];
  head: string;
  onPick?: (r: Row) => void;
}) {
  if (!rows.length) return <p className="pt-note">対象がありません。</p>;
  return (
    <div className="tbl-scroll" style={{ maxHeight: 420 }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>{head}</th>
            <th style={{ textAlign: 'right' }}>案件</th>
            <th style={{ width: 220 }}>進捗</th>
            <th style={{ textAlign: 'right' }}>完了率</th>
            <th style={{ textAlign: 'right' }}>目標未達</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const total = num(r.deals);
            const label = r.name ?? [r.branch, r.office].filter(Boolean).join(' / ') ?? '—';
            return (
              <tr key={`${label}-${i}`}>
                <td>
                  {onPick ? (
                    <a href="#" onClick={(e) => { e.preventDefault(); onPick(r); }}>{label || '—'}</a>
                  ) : (label || '—')}
                  {r.name && (r.branch || r.office) && (
                    <div className="sub">{[r.branch, r.office].filter(Boolean).join(' / ')}</div>
                  )}
                </td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{total.toLocaleString()}</td>
                <td><Bar done={num(r.r2_done)} agreed={num(r.r2_agreed)} total={total} /></td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct(num(r.r2_done), total)}%</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {num(r.r2_below) > 0
                    ? <span className="badge orange">{num(r.r2_below).toLocaleString()}</span> : '—'}
                </td>
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
  const navigate = useNavigate();

  const get = (k: string) => params.get(k) || '';
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  /** いまの絞り込みを引き継いで案件一覧へ移る */
  const toDeals = (extra: Record<string, string> = {}) => {
    const qs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (get(k)) qs.set(k, get(k));
    for (const [k, v] of Object.entries(extra)) if (v) qs.set(k, v);
    navigate(`/deals?${qs}`);
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

  const filtered = FILTER_KEYS.some((k) => get(k));

  if (msg) return <div className="alert error">{msg}</div>;
  if (!data) return <p style={{ color: 'var(--muted)' }}>読み込み中...</p>;

  const t = data.totals;
  const total = num(t.deals);
  const statusName = (code: string) =>
    data.corpStatuses.find((s) => s.code === code)?.name ?? code;

  return (
    <div>
      <h1 className="page-title">ダッシュボード</h1>
      <p className="page-sub">
        値上げの進み具合です。表示範囲: <strong>{data.scope.label}</strong>
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
            <option value="">すべて</option>
            {meta?.branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </label>
        <label className="fld">
          営業所
          <select value={get('office')} onChange={(e) => setParam('office', e.target.value)}>
            <option value="">すべて</option>
            {meta?.offices
              .filter((o) => !get('branch') || o.branch === get('branch'))
              .map((o) => <option key={`${o.branch}-${o.name}`} value={o.name}>{o.name}</option>)}
          </select>
        </label>
        <label className="fld">
          担当者
          <select value={get('person')} onChange={(e) => setParam('person', e.target.value)}>
            <option value="">すべて</option>
            {meta?.persons.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
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
          状態
          <select value={get('r2State')} onChange={(e) => setParam('r2State', e.target.value)}>
            <option value="">すべて</option>
            {meta?.states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label className="fld">
          目標との差
          <select value={get('below')} onChange={(e) => setParam('below', e.target.value)}>
            <option value="">すべて</option>
            <option value="r2">目標未達</option>
          </select>
        </label>
        {filtered && (
          <label className="fld" style={{ justifyContent: 'flex-end' }}>
            <span style={{ visibility: 'hidden' }}>操作</span>
            <button className="btn secondary" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              絞り込みを解除
            </button>
          </label>
        )}
      </div>

      <div className="toolbar">
        <span className="count">
          {filtered ? '絞り込んだ結果を集計しています' : '全体を集計しています'}
        </span>
        <div className="grow" />
        <button className="btn dark sm" onClick={() => toDeals()}>この条件で案件一覧を見る</button>
      </div>

      {data.scope.note && <div className="alert error">{data.scope.note}</div>}

      {total === 0 && !data.scope.note && (
        <div className="alert info">
          {data.scope.level === 'all'
            ? '対象の案件がありません。Excel取込が済んでいるかご確認ください。'
            : `「${data.scope.label}」に該当する案件がありません。`
              + 'Excel取込が済んでいないか、登録されている支店・営業所の表記が'
              + '案件データと一致していない可能性があります。営業企画部にご確認ください。'}
        </div>
      )}

      <div className="tiles">
        <Kpi label="対象案件" value={total.toLocaleString()} sub="件" />
        <Kpi label="完了" value={`${pct(num(t.r2_done), total)}%`}
          sub={`${num(t.r2_done).toLocaleString()} / ${total.toLocaleString()} 件`} />
        <Kpi label="合意済（未完了）" value={num(t.r2_agreed).toLocaleString()} sub="件" />
        <Kpi label="未入力" value={num(t.r2_open).toLocaleString()} sub="件" />
        <Kpi label="目標未達" value={num(t.r2_below).toLocaleString()} sub="件" />
      </div>

      {num(t.r2_below) > 0 && (
        <div className="alert warn">
          合意単価が目標に届かなかった案件が
          <strong> {num(t.r2_below).toLocaleString()}件 </strong>
          あります。
          <a href="#" onClick={(e) => { e.preventDefault(); toDeals({ below: 'r2' }); }}>
            一覧で確認する
          </a>
        </div>
      )}

      {num(data.abTotals?.deals) > 0 && (
        <Card title="A基準とB基準の妥結進捗（マスタ登録）">
          <p className="pt-note" style={{ marginTop: 0 }}>
            A基準は3か月後の申請単価、B基準は実際の決定単価です。
            加重平均売価 = 単価×数量の合計 ÷ 数量の合計。
            妥結差額は、B基準を入れた行の（B − A）× 数量の合計です。
          </p>
          {([
            { title: '器具区分ごと', rows: data.abByEquip ?? [] },
            { title: '法人ごと（数量上位20）', rows: data.abByCorp ?? [] },
          ] as { title: string; rows: AbRow[] }[]).map((sec) => (
            <div key={sec.title} style={{ marginBottom: 14 }}>
              <div className="section-title">{sec.title}</div>
              <div className="tbl-scroll" style={{ maxHeight: 320 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{sec.title.startsWith('法人') ? '法人' : '器具区分'}</th>
                      <th style={{ textAlign: 'right' }}>件数</th>
                      <th style={{ textAlign: 'right' }}>数量</th>
                      <th style={{ textAlign: 'right' }}>A加重平均</th>
                      <th style={{ textAlign: 'right' }}>B加重平均</th>
                      <th style={{ textAlign: 'right' }}>B入力</th>
                      <th style={{ textAlign: 'right' }}>妥結差額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...sec.rows, { ...data.abTotals!, name: '合計' }].map((r, i) => {
                      const last = i === sec.rows.length;
                      const diff = num(r.settle_diff);
                      return (
                        <tr key={i} style={last ? { fontWeight: 700, borderTop: '2px solid var(--grid)' } : undefined}>
                          <td>{r.name || '—'}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(r.deals).toLocaleString()}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(r.qty).toLocaleString()}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {num(r.qty) > 0 ? `¥${yen(num(r.a_amt) / num(r.qty))}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {num(r.b_qty) > 0 ? `¥${yen(num(r.b_amt) / num(r.b_qty))}` : '未入力'}
                          </td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {pct(num(r.b_rows), num(r.deals))}%
                          </td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                       color: diff < 0 ? '#c2410c' : diff > 0 ? '#15803d' : undefined }}>
                            {diff === 0 ? '—' : `${diff > 0 ? '＋' : '−'}¥${yen(Math.abs(diff))}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Card title="支店別の値上げ額と達成率">
        {data.byBranchAmount.length === 0 ? (
          <p className="pt-note" style={{ margin: 0 }}>対象がありません。</p>
        ) : (
          <div className="tbl-scroll" style={{ maxHeight: 480 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>支店</th>
                  <th style={{ textAlign: 'right' }}>案件</th>
                  <th style={{ textAlign: 'right' }}>目標額</th>
                  <th style={{ textAlign: 'right' }}>実績額</th>
                  <th style={{ width: 180 }}></th>
                  <th style={{ textAlign: 'right' }}>達成率</th>
                </tr>
              </thead>
              <tbody>
                {data.byBranchAmount.map((b, i) => (
                  <tr key={`${b.branch}-${i}`}>
                    <td>
                      <a href="#" onClick={(e) => { e.preventDefault(); toDeals({ branch: b.branch ?? '' }); }}>
                        {b.branch || '（支店なし）'}
                      </a>
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(b.deals).toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{yen(num(b.r2_target_amount))}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{yen(num(b.r2_agreed_amount))}</td>
                    <td><RateBar agreed={num(b.r2_agreed_amount)} target={num(b.r2_target_amount)} /></td>
                    <td style={{ textAlign: 'right' }}><Rate agreed={num(b.r2_agreed_amount)} target={num(b.r2_target_amount)} /></td>
                  </tr>
                ))}
              </tbody>
              {data.byBranchAmount.length > 1 && (
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--line, #e2e8f0)' }}>
                    <td>合計</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(data.amountTotals.deals).toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{yen(num(data.amountTotals.r2_target_amount))}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{yen(num(data.amountTotals.r2_agreed_amount))}</td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}><Rate agreed={num(data.amountTotals.r2_agreed_amount)} target={num(data.amountTotals.r2_target_amount)} /></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        <p className="pt-note" style={{ marginTop: 10 }}>
          目標額 = 目標単価と現行単価の差の合計。実績額 = 実際に上がった単価幅の合計（合意済・完了の案件）。
          達成率 = 実績額 ÷ 目標額。支店は都道府県順です。支店名を押すとその支店の案件一覧へ移れます。
        </p>
      </Card>

      <Card title="法人ごとの交渉状況">
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {data.corpStatus.length === 0 && <p className="pt-note" style={{ margin: 0 }}>対象がありません。</p>}
          {data.corpStatus.map((s) => (
            <div key={s.status}>
              <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>{statusName(s.status)}</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{num(s.corps).toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400 }}> 法人</span></div>
            </div>
          ))}
        </div>
      </Card>

      {data.byOffice.length > 1 && (
        <Card title="営業所別の進捗">
          <ProgressTable rows={data.byOffice} head="支店 / 営業所"
            onPick={(r) => navigate(`/deals?branch=${encodeURIComponent(r.branch ?? '')}&office=${encodeURIComponent(r.office ?? '')}`)} />
        </Card>
      )}

      <Card title="担当者別の進捗">
        <ProgressTable rows={data.byPerson} head="担当者"
          onPick={(r) => navigate(`/deals?person=${encodeURIComponent(r.name ?? '')}`)} />
      </Card>

      <Card title="器具区分別の進捗">
        <ProgressTable rows={data.byEquip} head="器具区分"
          onPick={(r) => navigate(`/deals?equip=${encodeURIComponent(r.name ?? '')}`)} />
      </Card>

      {data.applied.length > 0 && (
        <Card title="値上げの適用年月">
          <div className="tbl-scroll" style={{ maxHeight: 300 }}>
            <table className="tbl">
              <thead><tr><th>適用年月</th><th style={{ textAlign: 'right' }}>件数</th></tr></thead>
              <tbody>
                {data.applied.map((a) => (
                  <tr key={a.ym}>
                    <td>{a.ym}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(a.r2).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pt-note" style={{ marginTop: 10 }}>
            完了にした案件のうち、適用年月が入っているものを数えています。
          </p>
        </Card>
      )}
    </div>
  );
}

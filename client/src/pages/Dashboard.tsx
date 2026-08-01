import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Card } from '../components/ui';

/** 進捗の数え方はサーバーと揃える（件数と割合。金額は扱わない） */
interface Progress {
  deals: number;
  r1_done: number;
  r2_done: number;
  r1_agreed: number;
  r2_agreed: number;
  r1_open: number;
  r2_open: number;
}

interface Row extends Progress {
  name?: string | null;
  branch?: string | null;
  office?: string | null;
}

interface DashboardRes {
  scope: { level: string; label: string; missing?: string; note?: string };
  totals: Progress;
  byOffice: Row[];
  byPerson: Row[];
  byEquip: Row[];
  corpStatus: { status: string; corps: number }[];
  applied: { ym: string; r1: number; r2: number }[];
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
            <th style={{ width: 150 }}>第1弾</th>
            <th style={{ textAlign: 'right' }}>完了率</th>
            <th style={{ width: 150 }}>第2弾</th>
            <th style={{ textAlign: 'right' }}>完了率</th>
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
                <td><Bar done={num(r.r1_done)} agreed={num(r.r1_agreed)} total={total} /></td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct(num(r.r1_done), total)}%</td>
                <td><Bar done={num(r.r2_done)} agreed={num(r.r2_agreed)} total={total} /></td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct(num(r.r2_done), total)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardRes | null>(null);
  const [msg, setMsg] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api<DashboardRes>('/dashboard').then(setData).catch((e) => setMsg(e.message));
  }, []);

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
        <Kpi label="第1弾 完了" value={`${pct(num(t.r1_done), total)}%`}
          sub={`${num(t.r1_done).toLocaleString()} / ${total.toLocaleString()} 件`} />
        <Kpi label="第2弾 完了" value={`${pct(num(t.r2_done), total)}%`}
          sub={`${num(t.r2_done).toLocaleString()} / ${total.toLocaleString()} 件`} />
        <Kpi label="第1弾 未入力" value={num(t.r1_open).toLocaleString()} sub="件" />
        <Kpi label="第2弾 未入力" value={num(t.r2_open).toLocaleString()} sub="件" />
      </div>

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
              <thead><tr><th>適用年月</th><th style={{ textAlign: 'right' }}>第1弾</th><th style={{ textAlign: 'right' }}>第2弾</th></tr></thead>
              <tbody>
                {data.applied.map((a) => (
                  <tr key={a.ym}>
                    <td>{a.ym}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(a.r1).toLocaleString()}</td>
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

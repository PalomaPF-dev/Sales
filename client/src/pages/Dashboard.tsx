import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, yen } from '../api';
import { Card, Meter } from '../components/ui';
import { STATUS_NAMES, APP_STATUS_NAMES } from '../types';

interface Row {
  equip_name?: string;
  sales_person?: string;
  deals: number;
  r1_amount: number;
  r2_amount: number;
  total_amount: number;
}

interface Dash {
  targets: { r1: number; r2: number };
  progress: { r1: number; r2: number; deals: number };
  byEquip: Row[];
  byPerson: Row[];
  statusCounts: { status: string; count: number }[];
  appCounts: { status: string; count: number }[];
}

function BarRows({ rows, nameKey }: { rows: Row[]; nameKey: 'equip_name' | 'sales_person' }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(0, r.r1_amount) + Math.max(0, r.r2_amount)));
  return (
    <div>
      <div className="legend">
        <span><i style={{ background: 'var(--series-1)' }} />第1弾 値上金額（❺）</span>
        <span><i style={{ background: 'var(--series-2)' }} />第2弾 値上金額（❾）</span>
      </div>
      {rows.slice(0, 12).map((r) => {
        const v1 = Math.max(0, r.r1_amount);
        const v2 = Math.max(0, r.r2_amount);
        return (
          <div className="barrow" key={r[nameKey]}>
            <div className="name" title={r[nameKey]}>{r[nameKey]}</div>
            <div className="track">
              {v1 > 0 && <span style={{ width: `${(v1 / max) * 100}%`, background: 'var(--series-1)' }} title={`第1弾 ¥${yen(v1)}`} />}
              {v2 > 0 && <span style={{ width: `${(v2 / max) * 100}%`, background: 'var(--series-2)' }} title={`第2弾 ¥${yen(v2)}`} />}
            </div>
            <div className="nums">¥{yen(v1 + v2)}（{r.deals}件）</div>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const [d, setD] = useState<Dash | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Dash>('/dashboard').then(setD).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="alert error">{error}</div>;
  if (!d) return <p>読み込み中...</p>;

  const total = d.progress.r1 + d.progress.r2;
  const totalTarget = d.targets.r1 + d.targets.r2;
  const rate = (v: number, t: number) => (t > 0 ? (v / t) * 100 : 0);
  const appCount = (s: string) => d.appCounts.find((a) => a.status === s)?.count || 0;

  return (
    <div>
      <h1 className="page-title">ダッシュボード</h1>
      <p className="page-sub">東京中央支店 値上げ活動の進捗（第1弾 ❺ ＋ 第2弾 ❾ ＝ 値上げ金額総数）</p>

      <div className="tiles">
        <div className="tile">
          <div className="label">値上げ金額総数（❺＋❾）</div>
          <div className="value">¥{yen(total)}</div>
          <div className="delta">
            目標 ¥{yen(totalTarget)} に対し <span className="up">{rate(total, totalTarget).toFixed(1)}%</span>
          </div>
          <Meter value={total} max={totalTarget} color="var(--good)" />
        </div>
        <div className="tile">
          <div className="label">第1弾 値上がり金額（❺）</div>
          <div className="value">¥{yen(d.progress.r1)}</div>
          <div className="delta">
            目標 ¥{yen(d.targets.r1)} ・ 達成率 <span className="up">{rate(d.progress.r1, d.targets.r1).toFixed(1)}%</span>
          </div>
          <Meter value={d.progress.r1} max={d.targets.r1} color="var(--series-1)" />
        </div>
        <div className="tile">
          <div className="label">第2弾 値上がり金額（❾）</div>
          <div className="value">¥{yen(d.progress.r2)}</div>
          <div className="delta">
            目標 ¥{yen(d.targets.r2)} ・ 達成率 <span className="up">{rate(d.progress.r2, d.targets.r2).toFixed(1)}%</span>
          </div>
          <Meter value={d.progress.r2} max={d.targets.r2} color="var(--series-2)" />
        </div>
        <div className="tile">
          <div className="label">申請の状況</div>
          <div className="value">
            {appCount('pending_branch') + appCount('pending_planning')} <small>件 承認待ち</small>
          </div>
          <div className="delta">
            {APP_STATUS_NAMES.approved} {appCount('approved')}件 ・ {APP_STATUS_NAMES.rejected} {appCount('rejected')}件
          </div>
        </div>
      </div>

      <Card title="器具区分別の値上げ進捗">
        <BarRows rows={d.byEquip} nameKey="equip_name" />
      </Card>

      <Card title="担当者別の値上げ進捗">
        <BarRows rows={d.byPerson} nameKey="sales_person" />
      </Card>

      <Card title="交渉ステータス（明細ベース）">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {d.statusCounts.map((s) => (
            <Link key={s.status} to={`/deals?status=${s.status}`} className="badge gray" style={{ fontSize: 12, padding: '6px 12px' }}>
              {STATUS_NAMES[s.status] || s.status}: {s.count.toLocaleString()}件
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}

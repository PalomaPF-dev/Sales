import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, yen } from '../api';
import { Card, Meter } from '../components/ui';
import { STATUS_NAMES, APP_STATUS_NAMES } from '../types';
import type { Meta } from '../types';
import { useUser } from '../user';

interface Row {
  equip_name?: string;
  sales_person?: string;
  branch?: string;
  office?: string;
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
  byOffice: Row[];
  scope: { branch: string | null; office: string | null };
  statusCounts: { status: string; count: number }[];
  appCounts: { status: string; count: number }[];
}

function BarRows({ rows, nameKey }: { rows: Row[]; nameKey: 'equip_name' | 'sales_person' | 'office' }) {
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
  const [params, setParams] = useSearchParams();
  const me = useUser();
  const [d, setD] = useState<Dash | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState('');

  const branch = params.get('branch') || '';
  const office = params.get('office') || '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'branch') next.delete('office');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    api<Meta>('/meta').then((m) => {
      setMeta(m);
      // 営業担当者・支店長は自分の支店を初期表示にする
      if (!params.get('branch') && me.branch && me.role !== 'planning' && me.role !== 'admin'
          && m.branches.some((b) => b.name === me.branch)) {
        setParam('branch', me.branch);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (branch) qs.set('branch', branch);
    if (office) qs.set('office', office);
    api<Dash>(`/dashboard?${qs}`).then(setD).catch((e) => setError(e.message));
  }, [branch, office]);

  if (error) return <div className="alert error">{error}</div>;
  if (!d) return <p>読み込み中...</p>;

  const total = d.progress.r1 + d.progress.r2;
  const totalTarget = d.targets.r1 + d.targets.r2;
  const rate = (v: number, t: number) => (t > 0 ? (v / t) * 100 : 0);
  const appCount = (s: string) => d.appCounts.find((a) => a.status === s)?.count || 0;

  return (
    <div>
      <h1 className="page-title">ダッシュボード</h1>
      <p className="page-sub">
        {office || branch || '全社'} の値上げ活動の進捗（第1弾 ❺ ＋ 第2弾 ❾ ＝ 値上げ金額総数）
      </p>

      <div className="filters">
        <label className="fld">
          支店
          <select value={branch} onChange={(e) => setParam('branch', e.target.value)}>
            <option value="">全社</option>
            {meta?.branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </label>
        <label className="fld">
          営業所
          <select value={office} onChange={(e) => setParam('office', e.target.value)}>
            <option value="">すべて</option>
            {meta?.offices.filter((o) => !branch || o.branch === branch)
              .map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
        </label>
      </div>

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

      {d.byOffice.length > 1 && (
        <Card title="支店・営業所別の値上げ進捗">
          <BarRows rows={d.byOffice} nameKey="office" />
        </Card>
      )}

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

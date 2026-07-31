import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, yen, pct } from '../api';
import type { Application } from '../types';
import { useUser } from '../user';
import { AppStatusBadge, RouteBadge } from '../components/ui';

export default function Applications({ mode }: { mode: 'all' | 'inbox' }) {
  const [rows, setRows] = useState<Application[]>([]);
  const [filter, setFilter] = useState('');
  const [mine, setMine] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const user = useUser();

  useEffect(() => {
    const qs = new URLSearchParams();
    if (mode === 'inbox') qs.set('inbox', '1');
    if (filter) qs.set('status', filter);
    if (mine) qs.set('mine', '1');
    api<Application[]>(`/applications?${qs}`).then(setRows).catch((e) => setError(e.message));
  }, [mode, filter, mine]);

  return (
    <div>
      <h1 className="page-title">{mode === 'inbox' ? '承認箱' : '申請一覧'}</h1>
      <p className="page-sub">
        {mode === 'inbox'
          ? 'あなたの承認待ちの申請です。内容を確認して承認・差戻しを行ってください。'
          : '合意価格申請の一覧です。'}
      </p>
      {error && <div className="alert error">{error}</div>}

      {mode === 'all' && (
        <div className="filters">
          <label className="fld">
            状態
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">すべて</option>
              <option value="draft">下書き</option>
              <option value="pending_branch">支店長承認待ち</option>
              <option value="pending_planning">営業企画部承認待ち</option>
              <option value="approved">承認済み</option>
              <option value="rejected">差戻し</option>
              <option value="withdrawn">取下げ</option>
            </select>
          </label>
          {user?.role === 'sales' && (
            <label className="fld" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              自分の申請のみ
            </label>
          )}
        </div>
      )}

      <div className="card tbl-scroll" style={{ padding: 0 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>件名</th>
              <th>弾</th>
              <th>申請者</th>
              <th className="num">明細数</th>
              <th className="num">目標値上金額</th>
              <th className="num">申請値上金額</th>
              <th className="num">達成率</th>
              <th>承認ルート</th>
              <th>単価種別</th>
              <th>状態</th>
              <th>作成日</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => navigate(`/applications/${a.id}`)}>
                <td>{a.id}</td>
                <td>{a.title}</td>
                <td>第{a.round}弾</td>
                <td>{a.applicant_name}</td>
                <td className="num">{a.item_count}</td>
                <td className="num">¥{yen(a.target_amount)}</td>
                <td className="num">¥{yen(a.agreed_amount)}</td>
                <td className="num">{a.achievement_rate != null ? pct(a.achievement_rate) : '—'}</td>
                <td><RouteBadge route={a.route} /></td>
                <td>{a.price_type_name ? `${a.price_type_code}. ${a.price_type_name}` : '—'}</td>
                <td><AppStatusBadge status={a.status} /></td>
                <td>{a.created_at?.slice(0, 16)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={12} style={{ color: 'var(--muted)', textAlign: 'center', padding: 24 }}>該当する申請はありません</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

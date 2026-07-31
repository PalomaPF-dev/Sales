import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Card } from '../components/ui';

interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

const KIND_BADGE: Record<string, { cls: string; label: string }> = {
  submitted: { cls: 'yellow', label: '承認依頼' },
  forwarded: { cls: 'orange', label: '承認依頼' },
  approved: { cls: 'green', label: '承認' },
  rejected: { cls: 'red', label: '差戻し' },
};

export default function Notifications({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<Notification[]>([]);
  const navigate = useNavigate();

  const load = () => {
    api<{ rows: Notification[] }>('/notifications').then((r) => setRows(r.rows)).catch(() => {});
  };
  useEffect(load, []);

  const markAll = async () => {
    await api('/notifications/read', { method: 'POST', body: JSON.stringify({}) });
    load();
    onChanged?.();
  };

  const open = async (n: Notification) => {
    if (!n.read_at) {
      await api('/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [n.id] }) });
      onChanged?.();
    }
    if (n.link) navigate(n.link);
    else load();
  };

  const unread = rows.filter((r) => !r.read_at).length;

  return (
    <div>
      <h1 className="page-title">通知</h1>
      <p className="page-sub">申請の提出・承認・差戻しがあるとここに届きます。</p>

      <div className="toolbar">
        <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>未読 {unread}件 / 全{rows.length}件</span>
        <div className="grow" />
        <button className="btn secondary sm" onClick={markAll} disabled={unread === 0}>すべて既読にする</button>
      </div>

      <Card>
        {rows.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>通知はありません。</p>
        ) : (
          <ul className="notif-list">
            {rows.map((n) => {
              const b = KIND_BADGE[n.kind] || { cls: 'gray', label: n.kind };
              return (
                <li key={n.id} className={n.read_at ? '' : 'unread'} onClick={() => open(n)}>
                  <div className="notif-head">
                    <span className={`badge ${b.cls}`}>{b.label}</span>
                    <strong>{n.title}</strong>
                    <span style={{ flex: 1 }} />
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {n.created_at?.slice(0, 16).replace('T', ' ')}
                    </span>
                  </div>
                  {n.body && <div className="notif-body">{n.body}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

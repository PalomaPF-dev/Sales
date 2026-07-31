import { useEffect, useState } from 'react';
import { api } from '../api';
import { ROLE_NAMES } from '../types';
import { Card } from '../components/ui';
import { useUser } from '../user';

interface AdminUser {
  id: number;
  name: string;
  role: string;
  branch: string | null;
  office: string | null;
  active: number;
  login_id: string | null;
  last_login_at: string | null;
  must_change_password?: number;
  locked_until?: string | null;
  has_password: number;
}

const EMPTY = { name: '', role: 'sales', branch: '東京中央', office: '東京中央営業所', loginId: '' };

export default function Users() {
  const me = useUser();
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [issued, setIssued] = useState<{ loginId: string; tempPassword: string; name?: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<AdminUser[]>('/admin/users').then(setRows).catch((e) => setMsg({ kind: 'error', text: e.message }));
  };
  useEffect(load, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ loginId: string; tempPassword: string }>('/admin/users', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setIssued({ ...res, name: form.name });
      setForm({ ...EMPTY });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (u: AdminUser) => {
    if (!confirm(`${u.name} のパスワードを初期化します。現在のログインは切断されます。よろしいですか？`)) return;
    try {
      const res = await api<{ loginId: string; tempPassword: string }>(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
      setIssued({ ...res, name: u.name });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  const toggleActive = async (u: AdminUser) => {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ active: !u.active }) });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <div>
      <h1 className="page-title">ユーザー管理</h1>
      <p className="page-sub">担当者のログインIDを発行し、パスワードの初期化や利用停止を行います。</p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      {issued && (
        <div className="alert ok">
          <strong>{issued.name} の仮パスワードを発行しました。</strong>
          <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 15 }}>
            ログインID: <strong>{issued.loginId}</strong> ／ 仮パスワード: <strong>{issued.tempPassword}</strong>
          </div>
          <div style={{ marginTop: 8, fontSize: 12 }}>
            この画面を閉じると再表示できません。本人に安全な手段で伝えてください。
            初回ログイン時にパスワードの変更が求められます。
          </div>
          <button className="btn secondary sm" style={{ marginTop: 10 }} onClick={() => setIssued(null)}>
            確認しました
          </button>
        </div>
      )}

      <Card title="ユーザーの追加">
        <form onSubmit={create} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="fld">
            氏名
            <input type="text" value={form.name} required
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="fld">
            ログインID
            <input type="text" value={form.loginId} required placeholder="半角英数字"
              onChange={(e) => setForm({ ...form, loginId: e.target.value })} />
          </label>
          <label className="fld">
            役割
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {Object.entries(ROLE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="fld">
            支店
            <input type="text" value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })} />
          </label>
          <label className="fld">
            営業所
            <input type="text" value={form.office}
              onChange={(e) => setForm({ ...form, office: e.target.value })} />
          </label>
          <button className="btn" type="submit" disabled={busy}>追加して仮パスワードを発行</button>
        </form>
      </Card>

      <div className="card tbl-scroll" style={{ padding: 0 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>ID</th><th>ログインID</th><th>氏名</th><th>役割</th><th>支店 / 営業所</th>
              <th>パスワード</th><th>最終ログイン</th><th>状態</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td><code>{u.login_id || '—'}</code></td>
                <td>{u.name}{u.id === me.id && <span className="badge blue" style={{ marginLeft: 6 }}>自分</span>}</td>
                <td>{ROLE_NAMES[u.role] || u.role}</td>
                <td>{[u.branch, u.office].filter(Boolean).join(' / ') || '—'}</td>
                <td>
                  {!u.has_password ? <span className="badge red">未設定</span>
                    : u.must_change_password ? <span className="badge yellow">仮</span>
                    : <span className="badge green">設定済</span>}
                  {u.locked_until && new Date(u.locked_until) > new Date() && (
                    <span className="badge red" style={{ marginLeft: 4 }}>ロック中</span>
                  )}
                </td>
                <td>{u.last_login_at ? u.last_login_at.slice(0, 16).replace('T', ' ') : '—'}</td>
                <td>{u.active ? <span className="badge green">有効</span> : <span className="badge gray">停止</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn secondary sm" onClick={() => resetPassword(u)}>PW初期化</button>
                  {u.id !== me.id && (
                    <button className="btn secondary sm" style={{ marginLeft: 6 }} onClick={() => toggleActive(u)}>
                      {u.active ? '停止' : '再開'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

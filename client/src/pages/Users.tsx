import { useEffect, useRef, useState } from 'react';
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

interface Issued { loginId: string; tempPassword: string; name?: string }

/** 編集中の行。行ごとに入力してから「保存」でまとめて反映する */
interface EditRow {
  id: number;
  name: string;
  loginId: string;
  role: string;
  branch: string;
  office: string;
}

interface ImportResult {
  created: Issued[];
  updated: { id: number; loginId: string; name: string }[];
  skipped: { loginId: string; message: string }[];
  errors: { line?: number; loginId?: string; message: string }[];
}

const EMPTY = { name: '', role: 'sales', branch: '東京中央', office: '東京中央営業所', loginId: '' };

export default function Users() {
  const me = useUser();
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [issued, setIssued] = useState<Issued | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [editing, setEditing] = useState<EditRow | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    api<AdminUser[]>('/admin/users').then(setRows).catch((e) => setMsg({ kind: 'error', text: e.message }));
  };
  useEffect(load, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<Issued>('/admin/users', { method: 'POST', body: JSON.stringify(form) });
      setIssued({ ...res, name: form.name });
      setForm({ ...EMPTY });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const importUsers = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) { setMsg({ kind: 'error', text: 'ファイルを選択してください' }); return; }
    setBusy(true);
    setMsg(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (updateExisting) fd.append('updateExisting', 'true');
      const res = await api<ImportResult>('/admin/users/import', { method: 'POST', body: fd });
      setResult(res);
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const patch = async (u: AdminUser, body: Record<string, unknown>) => {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  const startEdit = (u: AdminUser) => {
    setMsg(null);
    setEditing({
      id: u.id,
      name: u.name,
      loginId: u.login_id ?? '',
      role: u.role,
      branch: u.branch ?? '',
      office: u.office ?? '',
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    setMsg(null);
    try {
      await api(`/admin/users/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editing.name,
          loginId: editing.loginId,
          role: editing.role,
          branch: editing.branch || null,
          office: editing.office || null,
        }),
      });
      setEditing(null);
      setMsg({ kind: 'ok', text: '変更を保存しました' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: AdminUser) => {
    if (!confirm(`${u.name}（${u.login_id ?? 'IDなし'}）を削除します。元に戻せません。よろしいですか？`)) return;
    setMsg(null);
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      setMsg({ kind: 'ok', text: `${u.name} を削除しました` });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  const resetPassword = async (u: AdminUser) => {
    if (!confirm(`${u.name} のパスワードを初期化します。現在のログインは切断されます。よろしいですか？`)) return;
    try {
      const res = await api<Issued>(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
      setIssued({ ...res, name: u.name });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <div>
      <h1 className="page-title">管理者画面（ユーザー）</h1>
      <p className="page-sub">
        管理者のみが利用できます。ログインIDの発行・名簿の一括取込・登録内容の編集・利用停止・削除を行います。
        交渉履歴などの記録が残っている方は削除できません（「停止」にすればログインできなくなり、記録は残ります）。
      </p>
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

      <Card title="名簿の一括取込">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" ref={fileRef} accept=".xlsx,.xlsm,.csv" />
          <button className="btn" onClick={importUsers} disabled={busy}>
            {busy ? '取込中...' : '取り込む'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-2)' }}>
            <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
            既に登録済みのログインIDは内容を更新する
          </label>
          <div className="grow" style={{ flex: 1 }} />
          <a className="btn secondary sm" href="/api/admin/users/template">記入例をダウンロード</a>
        </div>
        <p className="pt-note" style={{ marginTop: 10 }}>
          列: <code>ログインID</code> / <code>氏名</code> / <code>役割</code> / <code>支店</code> / <code>営業所</code> / <code>有効</code>。
          ログインIDと氏名以外は省略できます（役割を省くと営業担当者）。
        </p>
        <p className="pt-note">
        </p>
        <p className="pt-note">
          仮パスワードは取込結果の一覧にのみ表示されます。画面を離れると再表示できないため、控えてから閉じてください。
        </p>
      </Card>

      {result && (
        <Card title={`取込結果: 追加 ${result.created.length}件 / 更新 ${result.updated.length}件 / 見送り ${result.skipped.length}件 / エラー ${result.errors.length}件`}>
          {result.created.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 0 }}>発行した仮パスワード</div>
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead><tr><th>ログインID</th><th>氏名</th><th>仮パスワード</th></tr></thead>
                  <tbody>
                    {result.created.map((c) => (
                      <tr key={c.loginId}>
                        <td><code>{c.loginId}</code></td>
                        <td>{c.name}</td>
                        <td style={{ fontFamily: 'monospace' }}><strong>{c.tempPassword}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {result.updated.length > 0 && (
            <p className="pt-note" style={{ marginTop: 12 }}>
              更新: {result.updated.map((u) => u.loginId).join(', ')}
            </p>
          )}
          {result.skipped.length > 0 && (
            <p className="pt-note">
              見送り: {result.skipped.map((s) => `${s.loginId}（${s.message}）`).join(' / ')}
            </p>
          )}
          {result.errors.length > 0 && (
            <div className="alert error" style={{ marginTop: 12 }}>
              {result.errors.map((e, i) => (
                <div key={i}>{e.line ? `${e.line}行目: ` : ''}{e.loginId ? `${e.loginId} … ` : ''}{e.message}</div>
              ))}
            </div>
          )}
          <button className="btn secondary sm" style={{ marginTop: 12 }} onClick={() => setResult(null)}>閉じる</button>
        </Card>
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

      <div className="card tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>ID</th><th>ログインID</th><th>氏名</th><th>役割</th><th>支店 / 営業所</th>
              <th>パスワード</th><th>最終ログイン</th><th>状態</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              editing?.id === u.id ? (
                <tr key={u.id} className="editing">
                  <td>{u.id}</td>
                  <td>
                    <input type="text" value={editing.loginId} style={{ width: 110 }}
                      onChange={(e) => setEditing({ ...editing, loginId: e.target.value })} />
                  </td>
                  <td>
                    <input type="text" value={editing.name} style={{ width: 120 }}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  </td>
                  <td>
                    <select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                      {Object.entries(ROLE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <input type="text" value={editing.branch} placeholder="支店" style={{ width: 90 }}
                      onChange={(e) => setEditing({ ...editing, branch: e.target.value })} />
                    <input type="text" value={editing.office} placeholder="営業所" style={{ width: 110, marginLeft: 4 }}
                      onChange={(e) => setEditing({ ...editing, office: e.target.value })} />
                  </td>
                  <td colSpan={3} style={{ color: 'var(--muted)', fontSize: 12 }}>編集中</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={saveEdit} disabled={busy}>保存</button>
                    <button className="btn secondary sm" style={{ marginLeft: 6 }}
                      onClick={() => setEditing(null)} disabled={busy}>取消</button>
                  </td>
                </tr>
              ) : (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td><code>{u.login_id || '—'}</code></td>
                  <td>{u.name}{u.id === me.id && <span className="badge blue" style={{ marginLeft: 6 }}>自分</span>}</td>
                  <td>{ROLE_NAMES[u.role as keyof typeof ROLE_NAMES] ?? u.role}</td>
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
                    <button className="btn secondary sm" onClick={() => startEdit(u)}>編集</button>
                    <button className="btn secondary sm" style={{ marginLeft: 6 }}
                      onClick={() => resetPassword(u)}>PW初期化</button>
                    {u.id !== me.id && (
                      <>
                        <button className="btn secondary sm" style={{ marginLeft: 6 }}
                          onClick={() => patch(u, { active: !u.active })}>
                          {u.active ? '停止' : '再開'}
                        </button>
                        <button className="btn danger sm" style={{ marginLeft: 6 }}
                          onClick={() => remove(u)}>削除</button>
                      </>
                    )}
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

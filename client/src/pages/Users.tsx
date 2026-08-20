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
  title: string | null;
  active: number;
  login_id: string | null;
  last_login_at: string | null;
  must_change_password?: number;
  locked_until?: string | null;
  has_password: number;
  /** その人に見える案件数。0なら支店（管轄）の設定が案件データと合っていない */
  visible_deals?: number;
  /** 氏名が案件データの担当者名と一致した件数（担当者としての紐付き） */
  person_deals?: number;
}

/** 管理者向けの問い合わせ一覧の1件（Contactページと同じ形） */
interface AdminInquiry {
  id: number;
  login_id: string | null;
  name: string;
  category: string;
  message: string;
  status: 'open' | 'resolved';
  reply: string | null;
  replied_by: string | null;
  replied_at: string | null;
  created_at: string;
}

/** 編集中の行。行ごとに入力してから「保存」でまとめて反映する */
interface EditRow {
  id: number;
  name: string;
  loginId: string;
  role: string;
  branch: string;
  office: string;
  title: string;
}

interface ImportResult {
  created: { loginId: string; name?: string }[];
  updated?: { id: number; loginId: string; name: string }[];
  // 名簿の取込はログインID、担当者の登録は氏名で識別するため、どちらも受ける
  skipped: { loginId?: string; name?: string; message: string }[];
  errors: { line?: number; loginId?: string; name?: string; message: string }[];
}

const EMPTY = { name: '', role: 'sales', branch: '東京中央', office: '東京中央営業所', title: '', loginId: '' };

export default function Users() {
  const me = useUser();
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // ユーザーの一括削除（チェックで選んでまとめて消す）
  const [sel, setSel] = useState<Set<number>>(new Set());
  // 問い合わせ（管理者が回答する）
  const [inquiries, setInquiries] = useState<AdminInquiry[]>([]);
  const [replyDraft, setReplyDraft] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [editing, setEditing] = useState<EditRow | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    api<AdminUser[]>('/admin/users')
      .then((r) => { setRows(r); setSel(new Set()); })
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
    api<AdminInquiry[]>('/inquiries').then(setInquiries).catch(() => {});
  };
  useEffect(load, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ loginId: string }>('/admin/users', { method: 'POST', body: JSON.stringify(form) });
      setMsg({
        kind: 'ok',
        text: `${form.name}（${res.loginId}）を追加しました。`
          + '本人は初回ログイン時に「パスワード設定」から自分でパスワードを決めます',
      });
      setForm({ ...EMPTY });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const toggleSel = (id: number) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /** 選んだユーザーをまとめて削除する。消せない人は理由つきで報告される */
  const removeSelected = async () => {
    if (!sel.size) return;
    const names = rows.filter((u) => sel.has(u.id)).map((u) => u.name);
    if (!confirm(`${sel.size}名を削除します。元に戻せません。よろしいですか？\n\n${names.join(' / ')}`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ deleted: { name: string }[]; skipped: { name: string; message: string }[] }>(
        '/admin/users/bulk-delete',
        { method: 'POST', body: JSON.stringify({ ids: [...sel] }) });
      const text = `${res.deleted.length}名を削除しました`
        + (res.skipped.length
          ? `。削除できなかった人: ${res.skipped.map((s) => `${s.name}（${s.message}）`).join(' / ')}`
          : '');
      setMsg({ kind: res.skipped.length ? 'error' : 'ok', text });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  /** 問い合わせへの回答・状態変更 */
  const patchInquiry = async (id: number, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api(`/inquiries/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setReplyDraft((prev) => ({ ...prev, [id]: '' }));
      api<AdminInquiry[]>('/inquiries').then(setInquiries).catch(() => {});
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
      title: u.title ?? '',
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
          title: editing.title || null,
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
    if (!confirm(`${u.name} のパスワードを未設定に戻します。現在のログインは切断され、`
      + '本人は次回ログイン時に「パスワード設定」からもう一度パスワードを決めます。よろしいですか？')) return;
    try {
      await api(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
      setMsg({
        kind: 'ok',
        text: `${u.name} のパスワードを未設定に戻しました。`
          + '本人にログイン画面の「初めてログインする方はこちら（パスワード設定）」から設定し直すよう伝えてください',
      });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  // 設定は管理者だけが開ける（メニューにも出さないが、URL直打ちも防ぐ）
  if (!['admin', 'developer'].includes(me.role)) {
    return (
      <div>
        <h1 className="page-title">設定</h1>
        <div className="alert error">この画面を開けるのは管理者のみです</div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">設定</h1>
      <p className="page-sub">
        管理者のみが利用できます。名簿の一括取込・登録内容の編集・利用停止・削除（選択して一括も可）と、
        お問い合わせへの回答を行います。パスワードは発行しません（本人が初回ログイン時に自分で設定します）。
        交渉履歴などの記録が残っている方は削除できません（「停止」にすればログインできなくなり、記録は残ります）。
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

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
          列: <code>ログインID（社員番号）</code> / <code>支店（管轄）</code> / <code>営業所（部署）</code> /
          <code>役職</code> / <code>氏名</code> / <code>権限</code>（任意で <code>有効</code>）。
          ログインIDと氏名以外は省略できます（権限を省くと営業担当者）。
          権限は <strong>営業担当者</strong>（自分の支店のみ閲覧・値上げ交渉の入力のみ）／
          <strong>支店長</strong>・<strong>広域担当</strong>（全支店を閲覧）／
          <strong>本社</strong>（全て閲覧＋目標値の設定）／<strong>管理者</strong> のいずれかで記入します。
        </p>
        <p className="pt-note">
          パスワードの発行はありません。追加された人は、初回ログイン時にログイン画面の
          「初めてログインする方はこちら（パスワード設定）」から自分でパスワードを決めます。
        </p>
      </Card>

      {result && (
        <Card title={`取込結果: 追加 ${result.created.length}件 / 更新 ${result.updated?.length ?? 0}件 / 見送り ${result.skipped.length}件 / エラー ${result.errors.length}件`}>
          {result.created.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 0 }}>追加した人</div>
              <p className="pt-note" style={{ marginTop: 0 }}>
                {result.created.map((c) => `${c.name ?? ''}（${c.loginId}）`).join(' / ')}
              </p>
              <p className="pt-note">
                パスワードの発行はありません。各自が初回ログイン時に
                「パスワード設定」から自分でパスワードを決めます。
              </p>
            </>
          )}
          {(result.updated?.length ?? 0) > 0 && (
            <p className="pt-note" style={{ marginTop: 12 }}>
              更新: {result.updated!.map((u) => u.loginId).join(', ')}
            </p>
          )}
          {result.skipped.length > 0 && (
            <p className="pt-note">
              見送り: {result.skipped.map((s) => `${s.name ?? s.loginId}（${s.message}）`).join(' / ')}
            </p>
          )}
          {result.errors.length > 0 && (
            <div className="alert error" style={{ marginTop: 12 }}>
              {result.errors.map((e, i) => (
                <div key={i}>
                  {e.line ? `${e.line}行目: ` : ''}
                  {(e.name ?? e.loginId) ? `${e.name ?? e.loginId} … ` : ''}{e.message}
                </div>
              ))}
            </div>
          )}
          <button className="btn secondary sm" style={{ marginTop: 12 }} onClick={() => setResult(null)}>閉じる</button>
        </Card>
      )}

      <Card title="ユーザーの追加">
        <form onSubmit={create} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="fld">
            ログインID（社員番号）
            <input type="text" value={form.loginId} required placeholder="半角英数字"
              onChange={(e) => setForm({ ...form, loginId: e.target.value })} />
          </label>
          <label className="fld">
            支店（管轄）
            <input type="text" value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })} />
          </label>
          <label className="fld">
            営業所（部署）
            <input type="text" value={form.office}
              onChange={(e) => setForm({ ...form, office: e.target.value })} />
          </label>
          <label className="fld">
            役職
            <input type="text" value={form.title} placeholder="主任 / 課長 など"
              onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <label className="fld">
            氏名
            <input type="text" value={form.name} required
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="fld">
            権限
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {Object.entries(ROLE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button className="btn" type="submit" disabled={busy}>追加する</button>
        </form>
      </Card>

      {/* 一括削除。行頭のチェックで選び、まとめて消す（消せない人は理由つきで残る） */}
      <div className="toolbar">
        <span className="count">選択 <b>{sel.size.toLocaleString()}</b>名</span>
        <button className="btn danger sm" disabled={busy || !sel.size} onClick={removeSelected}>
          選択したユーザーを削除
        </button>
        <span className="pt-note" style={{ margin: 0 }}>
          交渉履歴などの記録が残っている人は削除できません（「停止」をお使いください）
        </span>
      </div>

      <div className="card tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th title="表示中の全員を選ぶ／外す（自分自身は除く）">
                <input type="checkbox"
                  checked={rows.length > 0 && rows.filter((u) => u.id !== me.id).every((u) => sel.has(u.id))}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setSel(on ? new Set(rows.filter((u) => u.id !== me.id).map((u) => u.id)) : new Set());
                  }} />
              </th>
              <th>ID</th><th>ログインID<br /><small>（社員番号）</small></th><th>氏名</th><th>役職</th><th>権限</th>
              <th>支店（管轄） / 営業所（部署）</th>
              <th title="案件データとの紐付け。閲覧＝その人に見える案件数（支店の一致）／担当＝氏名が案件の担当者名と一致した件数">
                案件との紐付け
              </th>
              <th>パスワード</th><th>最終ログイン</th><th>状態</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              editing?.id === u.id ? (
                <tr key={u.id} className="editing">
                  <td></td>
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
                    <input type="text" value={editing.title} placeholder="役職" style={{ width: 90 }}
                      onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                  </td>
                  <td>
                    <select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                      {Object.entries(ROLE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <input type="text" value={editing.branch} placeholder="支店（管轄）" style={{ width: 100 }}
                      onChange={(e) => setEditing({ ...editing, branch: e.target.value })} />
                    <input type="text" value={editing.office} placeholder="営業所（部署）" style={{ width: 120, marginLeft: 4 }}
                      onChange={(e) => setEditing({ ...editing, office: e.target.value })} />
                  </td>
                  <td colSpan={4} style={{ color: 'var(--muted)', fontSize: 12 }}>編集中</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={saveEdit} disabled={busy}>保存</button>
                    <button className="btn secondary sm" style={{ marginLeft: 6 }}
                      onClick={() => setEditing(null)} disabled={busy}>取消</button>
                  </td>
                </tr>
              ) : (
                <tr key={u.id}>
                  <td>
                    {u.id !== me.id && (
                      <input type="checkbox" checked={sel.has(u.id)} onChange={() => toggleSel(u.id)} />
                    )}
                  </td>
                  <td>{u.id}</td>
                  <td><code>{u.login_id || '—'}</code></td>
                  <td>{u.name}{u.id === me.id && <span className="badge blue" style={{ marginLeft: 6 }}>自分</span>}</td>
                  <td>{u.title || '—'}</td>
                  <td>{ROLE_NAMES[u.role as keyof typeof ROLE_NAMES] ?? u.role}</td>
                  <td>{[u.branch, u.office].filter(Boolean).join(' / ') || '—'}</td>
                  {/* 案件データとの紐付け。支店の一致（閲覧範囲）と担当者名の一致をここで確かめる */}
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    閲覧 {Number(u.visible_deals ?? 0).toLocaleString()}件
                    <br />担当 {Number(u.person_deals ?? 0).toLocaleString()}件
                    {u.active === 1 && u.visible_deals === 0 && (
                      <div>
                        <span className="badge red" title="支店（管轄）の表記が案件データと一致していないため、本人には案件が表示されません">
                          案件が見えません
                        </span>
                      </div>
                    )}
                    {u.active === 1 && u.role === 'sales' && Number(u.person_deals ?? 0) === 0 && (
                      <div>
                        <span className="badge yellow" title="氏名が案件データの担当者名と一致していません。案件一覧の担当者の絞り込みに出ない可能性があります">
                          担当者名の一致なし
                        </span>
                      </div>
                    )}
                  </td>
                  <td>
                    {!u.has_password
                      ? <span className="badge yellow" title="本人が初回ログイン時に「パスワード設定」から設定します">未設定（本人待ち）</span>
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
                      title="パスワードを未設定に戻します。本人がログイン画面の「パスワード設定」から決め直します"
                      onClick={() => resetPassword(u)}>PW再設定</button>
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

      {/* お問い合わせ（ポータルと同じ仕様）。利用者・ログイン画面から届いた問い合わせに回答する */}
      <Card title={`お問い合わせ（未対応 ${inquiries.filter((q) => q.status === 'open').length}件）`}>
        {inquiries.length === 0 ? (
          <p className="pt-note" style={{ margin: 0 }}>お問い合わせはありません。</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {inquiries.map((q) => (
              <div key={q.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
                  {q.status === 'open'
                    ? <span className="badge yellow">未対応</span>
                    : <span className="badge green">対応済み</span>}
                  <span className="badge blue">{q.category}</span>
                  <strong>{q.name}</strong>
                  {q.login_id && <code>{q.login_id}</code>}
                  <span style={{ color: 'var(--muted)' }}>{String(q.created_at).slice(0, 16).replace('T', ' ')}</span>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{q.message}</p>
                {q.reply && (
                  <p className="pt-note" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    回答（{q.replied_by}）: {q.reply}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <textarea rows={2} value={replyDraft[q.id] ?? ''} maxLength={2000}
                    placeholder={q.reply ? '回答を書き直す（本人には未読として届きます）' : '回答を入力（送信すると対応済みになり、本人に届きます）'}
                    style={{ flex: '1 1 320px', border: '1px solid var(--baseline)', borderRadius: 8,
                             padding: '8px 10px', font: 'inherit', resize: 'vertical' }}
                    onChange={(e) => setReplyDraft((prev) => ({ ...prev, [q.id]: e.target.value }))} />
                  <button className="btn sm" disabled={busy || !(replyDraft[q.id] ?? '').trim()}
                    onClick={() => patchInquiry(q.id, { reply: (replyDraft[q.id] ?? '').trim() })}>
                    回答を送る
                  </button>
                  {q.status === 'open' ? (
                    <button className="btn secondary sm" disabled={busy}
                      onClick={() => patchInquiry(q.id, { status: 'resolved' })}>回答せず対応済みにする</button>
                  ) : (
                    <button className="btn secondary sm" disabled={busy}
                      onClick={() => patchInquiry(q.id, { status: 'open' })}>未対応に戻す</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="pt-note" style={{ marginTop: 12 }}>
          ログイン画面の「管理者への問い合わせ」（パスワードを忘れた等）もここに届きます。
          パスワードを忘れた人には、上の一覧の「PW再設定」でパスワードを未設定に戻し、
          本人に「パスワード設定」から決め直すよう回答してください。
        </p>
      </Card>
    </div>
  );
}

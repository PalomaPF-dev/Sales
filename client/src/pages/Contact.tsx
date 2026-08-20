import { useEffect, useState } from 'react';
import { api, jstDateTime } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';

/**
 * お問い合わせ（ポータルと同じ仕様）。
 * ログイン中の利用者が管理者へ問い合わせを送り、回答をここで受け取る。
 * 回答が付くと未読になり、開いて「確認しました」で既読になる。
 */

interface Inquiry {
  id: number;
  login_id: string | null;
  name: string;
  category: string;
  message: string;
  status: 'open' | 'resolved';
  reply: string | null;
  replied_by: string | null;
  replied_at: string | null;
  read_at: string | null;
  created_at: string;
}

/** 分類（サーバーの INQUIRY_CATEGORIES と一致させる） */
const INQUIRY_CATEGORIES = [
  'ログインできない',
  'アプリのエラー・不具合',
  'アカウント・権限（支店／営業所／担当）',
  '操作方法について',
  '機能の要望・改善',
  'その他',
];

const dt = (s: string | null | undefined) => jstDateTime(s);

export default function Contact() {
  const me = useUser();
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [rows, setRows] = useState<Inquiry[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<{ rows: Inquiry[]; unread: number }>('/inquiries/mine')
      .then((r) => setRows(r.rows))
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
  };
  useEffect(load, []);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('/inquiries', { method: 'POST', body: JSON.stringify({ category, message }) });
      setMsg({ kind: 'ok', text: '送信しました。回答はこのページに届きます。' });
      setCategory('');
      setMessage('');
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const markRead = async (id: number) => {
    try {
      await api(`/inquiries/mine/${id}/read`, { method: 'PATCH' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <div>
      <h1 className="page-title">お問い合わせ</h1>
      <p className="page-sub">
        アプリの不明点・不具合・要望などを管理者へ送れます。回答はこのページに届きます。
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <Card title="お問い合わせを送る">
        <form onSubmit={send} style={{ maxWidth: 640 }}>
          <p className="pt-note" style={{ marginTop: 0 }}>
            送信者: <strong>{me.name}</strong>{me.loginId ? `（${me.loginId}）` : ''}
          </p>
          <label className="fld" style={{ marginBottom: 12 }}>
            お問い合わせ分類（必須）
            <select value={category} required onChange={(e) => setCategory(e.target.value)}>
              <option value="" disabled>選択してください</option>
              {INQUIRY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="fld" style={{ marginBottom: 14 }}>
            お問い合わせ内容（必須）
            <textarea value={message} rows={5} maxLength={2000} required
              style={{ width: '100%', border: '1px solid var(--baseline)', borderRadius: 9,
                       padding: '9px 11px', font: 'inherit', resize: 'vertical' }}
              placeholder="困っていること・起きたこと・要望などをご記入ください"
              onChange={(e) => setMessage(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? '送信中...' : '管理者へ送信'}
          </button>
        </form>
      </Card>

      <Card title="お問い合わせ履歴">
        {rows.length === 0 ? (
          <p className="pt-note" style={{ margin: 0 }}>これまでのお問い合わせはありません。</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.map((r) => (
              <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
                  <span className="badge blue">{r.category}</span>
                  {r.status === 'resolved'
                    ? <span className="badge green">対応済み</span>
                    : <span className="badge yellow">対応中</span>}
                  {r.reply && !r.read_at && <span className="badge red">未読の回答</span>}
                  <span style={{ color: 'var(--muted)' }}>{dt(r.created_at)}</span>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{r.message}</p>
                {r.reply && (
                  <div style={{ marginTop: 10, background: 'var(--accent-soft)', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 700 }}>
                      回答{r.replied_by ? `（${r.replied_by}）` : ''}
                      {r.replied_at && <span style={{ fontWeight: 400, marginLeft: 8, color: 'var(--muted)' }}>{dt(r.replied_at)}</span>}
                    </div>
                    <p style={{ margin: '6px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{r.reply}</p>
                    {!r.read_at && (
                      <button className="btn secondary sm" style={{ marginTop: 8 }} onClick={() => markRead(r.id)}>
                        確認しました（既読にする）
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

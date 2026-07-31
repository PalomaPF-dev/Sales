import { useState } from 'react';
import { changePassword } from '../api';
import { Card } from '../components/ui';

/**
 * パスワード変更。
 * 仮パスワードでログインした直後は forced=true で表示され、
 * 変更するまで他の画面に進めない。
 */
export default function ChangePassword({
  forced = false,
  onDone,
}: {
  forced?: boolean;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setMsg({ kind: 'error', text: '新しいパスワードが一致しません' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await changePassword(current, next);
      setMsg({ kind: 'ok', text: 'パスワードを変更しました' });
      setCurrent('');
      setNext('');
      setConfirm('');
      onDone();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <form onSubmit={submit} style={{ maxWidth: 420 }}>
      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
      {forced && (
        <div className="alert info">
          仮パスワードでログインしています。ご自身のパスワードに変更してください。
        </div>
      )}
      <label className="fld" style={{ marginBottom: 12 }}>
        現在のパスワード
        <input type="password" value={current} autoComplete="current-password"
          onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="fld" style={{ marginBottom: 12 }}>
        新しいパスワード（10文字以上）
        <input type="password" value={next} autoComplete="new-password"
          onChange={(e) => setNext(e.target.value)} required />
      </label>
      <label className="fld" style={{ marginBottom: 18 }}>
        新しいパスワード（確認）
        <input type="password" value={confirm} autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? '変更中...' : 'パスワードを変更'}
      </button>
    </form>
  );

  if (forced) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>パスワードの変更</h1>
          <p>続けるにはパスワードの変更が必要です</p>
          {body}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">パスワードの変更</h1>
      <p className="page-sub">変更すると、他の端末でのログインは一度切断されます。</p>
      <Card>{body}</Card>
    </div>
  );
}

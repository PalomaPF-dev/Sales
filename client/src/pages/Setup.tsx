import { useEffect, useState } from 'react';
import { api } from '../api';
import type { User } from '../types';
import { ROLE_NAMES } from '../types';

interface Candidate {
  login_id: string;
  name: string;
  role: string;
}

/**
 * 初期セットアップ。
 * パスワードを持つユーザーが1人も居ないときだけ表示され、
 * 最初の管理者パスワードをブラウザから設定できる。
 * 設定が完了すると、この画面は二度と表示されない。
 */
export default function Setup({
  candidates, onDone,
}: { candidates: Candidate[]; onDone: (u: User) => void }) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loginId && candidates.length) setLoginId(candidates[0].login_id);
  }, [candidates]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('パスワードが一致しません');
      return;
    }
    setBusy(true);
    setError('');
    try {
      onDone(await api<User>('/setup', { method: 'POST', body: JSON.stringify({ loginId, password }) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit} style={{ width: 460 }}>
        <h1>初期セットアップ</h1>
        <p>
          最初にログインする管理者のパスワードを設定してください。
          この画面は設定が完了すると表示されなくなります。
        </p>
        {error && <div className="alert error">{error}</div>}

        <label className="fld" style={{ marginBottom: 12 }}>
          設定する利用者
          <select value={loginId} onChange={(e) => setLoginId(e.target.value)} required>
            {candidates.map((c) => (
              <option key={c.login_id} value={c.login_id}>
                {c.name}（{ROLE_NAMES[c.role] || c.role}） — ID: {c.login_id}
              </option>
            ))}
          </select>
        </label>
        <label className="fld" style={{ marginBottom: 12 }}>
          パスワード（10文字以上）
          <input type="password" value={password} autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </label>
        <label className="fld" style={{ marginBottom: 18 }}>
          パスワード（確認）
          <input type="password" value={confirm} autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)} required />
        </label>

        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? '設定中...' : 'この内容で開始する'}
        </button>

        <p className="pt-note" style={{ marginTop: 16 }}>
          設定後はそのままログインした状態になります。
          他の担当者は「ユーザー管理」画面から追加でき、追加時に仮パスワードが発行されます。
        </p>
      </form>
    </div>
  );
}

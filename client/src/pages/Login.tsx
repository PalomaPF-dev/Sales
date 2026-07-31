import { useState } from 'react';
import { login } from '../api';
import type { User } from '../types';

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await login(loginId, password));
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>値上げ交渉管理システム</h1>
        <p>ログインIDとパスワードを入力してください</p>
        {error && <div className="alert error">{error}</div>}

        <label className="fld" style={{ marginBottom: 12 }}>
          ログインID
          <input
            type="text"
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label className="fld" style={{ marginBottom: 18 }}>
          パスワード
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'ログイン中...' : 'ログイン'}
        </button>

        <p className="pt-note" style={{ marginTop: 16, textAlign: 'center' }}>
          パスワードが分からない場合は営業企画部にお問い合わせください
        </p>
      </form>
    </div>
  );
}

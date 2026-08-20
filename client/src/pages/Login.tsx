import { useEffect, useState } from 'react';
import { login } from '../api';
import type { User } from '../types';

/**
 * ポータルからのSSOに失敗したときの案内。
 * サーバーは短い区分だけを ?sso= で渡す（詳しい理由は総当たりの手掛かりになるため）。
 */
const SSO_MESSAGES: Record<string, string> = {
  expired: 'リンクの有効期限が切れました。ポータルからもう一度お開きください。',
  replayed: 'このリンクは既に使われています。ポータルからもう一度お開きください。',
  unknown_user: 'このアカウントは登録されていません。本社（管理者）にお問い合わせください。',
  inactive: 'このアカウントは現在ご利用いただけません。本社（管理者）にお問い合わせください。',
  disabled: 'ポータル連携は現在設定されていません。下のログインをお使いください。',
};
const SSO_FALLBACK = 'ポータルからのログインに失敗しました。もう一度お試しください。';

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [ssoError, setSsoError] = useState('');
  const [busy, setBusy] = useState(false);

  // SSOで戻されたときは理由を出す。読み終えたらURLから消しておく
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('sso');
    if (!code) return;
    setSsoError(SSO_MESSAGES[code] ?? SSO_FALLBACK);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

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
        {ssoError && <div className="alert error">{ssoError}</div>}
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
          パスワードが分からない場合は本社（管理者）にお問い合わせください
        </p>
      </form>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api, login } from '../api';
import type { ApiError } from '../api';
import type { User } from '../types';

/**
 * ログイン画面。ポータル（業務アプリポータル）と同じ仕様:
 *   ・社員番号＋パスワードでログイン
 *   ・初めての人は「パスワード設定」から自分でパスワードを決めてそのままログイン
 *     （仮パスワードの発行・伝達はしない）
 *   ・パスワードを忘れた人・ログインできない人は「管理者への問い合わせ」から
 *     未ログインのまま管理者へ連絡できる
 */

/**
 * ポータルからのSSOに失敗したときの案内。
 * サーバーは短い区分だけを ?sso= で渡す（詳しい理由は総当たりの手掛かりになるため）。
 */
const SSO_MESSAGES: Record<string, string> = {
  expired: 'リンクの有効期限が切れました。ポータルからもう一度お開きください。',
  replayed: 'このリンクは既に使われています。ポータルからもう一度お開きください。',
  unknown_user: 'このアカウントは登録されていません。管理者への問い合わせをご利用ください。',
  inactive: 'このアカウントは現在ご利用いただけません。管理者への問い合わせをご利用ください。',
  disabled: 'ポータル連携は現在設定されていません。下のログインをお使いください。',
};
const SSO_FALLBACK = 'ポータルからのログインに失敗しました。もう一度お試しください。';

type Mode = 'login' | 'setup' | 'help';

const TITLES: Record<Mode, string> = {
  login: 'ログイン',
  setup: 'パスワード設定',
  help: '管理者への問い合わせ',
};

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [lead, setLead] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  // ログイン
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  // パスワード設定
  const [setupId, setSetupId] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  // 問い合わせ（ログインできない人向け）
  const [helpId, setHelpId] = useState('');
  const [helpName, setHelpName] = useState('');
  const [helpMsg, setHelpMsg] = useState('');
  const [helpHp, setHelpHp] = useState('');   // ハニーポット（見えない欄）

  // SSOで戻されたときは理由を出す。読み終えたらURLから消しておく
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('sso');
    if (!code) return;
    setError(SSO_MESSAGES[code] ?? SSO_FALLBACK);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const switchTo = (m: Mode, leadText = '') => {
    setMode(m);
    setLead(leadText);
    setError('');
    setOk('');
  };

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await login(loginId, password));
    } catch (err) {
      const ae = err as ApiError;
      if (ae.needsSetup) {
        // 初回ログイン。パスワード設定へ切り替える（社員番号は引き継ぐ）
        setSetupId(loginId);
        switchTo('setup', '初回ログインのため、パスワードの設定が必要です。');
      } else {
        setError(ae.message);
        setPassword('');
      }
    } finally {
      setBusy(false);
    }
  };

  const submitSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw1 !== pw2) {
      setError('新しいパスワードが一致しません');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const u = await api<User>('/login/setup', {
        method: 'POST',
        body: JSON.stringify({ loginId: setupId, password: pw1 }),
      });
      onLogin(u);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitHelp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOk('');
    try {
      await api('/inquiries', {
        method: 'POST',
        body: JSON.stringify({
          category: 'ログインできない',
          loginId: helpId,
          name: helpName,
          message: helpMsg,
          website: helpHp,
        }),
      });
      setOk('送信しました。管理者からの連絡をお待ちください。');
      setHelpMsg('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="lhead">
          {/* 会社ロゴ。ポータル・他のPFアプリと同じ見せ方にそろえる */}
          <img className="llogo" src="/paloma-logo.png" alt="株式会社パロマ" />
          <p className="lorg">営業本部</p>
          <h1 className="lname">価格交渉管理アプリ</h1>
          <p className="lsub">値上げ交渉・単価管理</p>
        </div>
        <h2 className="ltitle">{TITLES[mode]}</h2>
        {lead && <p className="loginlead">{lead}</p>}
        {error && <div className="alert error">{error}</div>}
        {ok && <div className="alert ok">{ok}</div>}

        {mode === 'login' && (
          <form onSubmit={submitLogin}>
            <label className="fld" style={{ marginBottom: 12 }}>
              社員番号
              <input type="text" value={loginId} autoComplete="username" autoFocus required
                autoCapitalize="off" autoCorrect="off" placeholder="例: 12345"
                onChange={(e) => setLoginId(e.target.value)} />
            </label>
            <label className="fld" style={{ marginBottom: 18 }}>
              パスワード
              <input type="password" value={password} autoComplete="current-password" required
                placeholder="••••••••" onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'ログイン中...' : 'ログイン'}
            </button>
          </form>
        )}

        {mode === 'setup' && (
          <form onSubmit={submitSetup}>
            <label className="fld" style={{ marginBottom: 12 }}>
              社員番号
              <input type="text" value={setupId} autoComplete="username" required
                autoCapitalize="off" autoCorrect="off" placeholder="例: 12345"
                onChange={(e) => setSetupId(e.target.value)} />
            </label>
            <label className="fld" style={{ marginBottom: 12 }}>
              新しいパスワード（10文字以上）
              <input type="password" value={pw1} autoComplete="new-password" minLength={10} required
                onChange={(e) => setPw1(e.target.value)} />
            </label>
            <label className="fld" style={{ marginBottom: 18 }}>
              新しいパスワード（確認）
              <input type="password" value={pw2} autoComplete="new-password" minLength={10} required
                onChange={(e) => setPw2(e.target.value)} />
            </label>
            <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? '設定中...' : 'パスワードを設定してログイン'}
            </button>
          </form>
        )}

        {mode === 'help' && (
          <form onSubmit={submitHelp}>
            <label className="fld" style={{ marginBottom: 12 }}>
              社員番号
              <input type="text" value={helpId} autoComplete="username" maxLength={64} required
                autoCapitalize="off" autoCorrect="off"
                onChange={(e) => setHelpId(e.target.value)} />
            </label>
            <label className="fld" style={{ marginBottom: 12 }}>
              氏名
              <input type="text" value={helpName} autoComplete="name" maxLength={100} required
                onChange={(e) => setHelpName(e.target.value)} />
            </label>
            <label className="fld" style={{ marginBottom: 18 }}>
              お困りの内容
              <textarea value={helpMsg} maxLength={2000} rows={3} required
                placeholder="例: パスワードを忘れた／社員番号が分からない など"
                onChange={(e) => setHelpMsg(e.target.value)} />
            </label>
            {/* ハニーポット。人は見えないので入力しない（機械の送信よけ） */}
            <input className="login-hp" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true"
              value={helpHp} onChange={(e) => setHelpHp(e.target.value)} />
            <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? '送信中...' : '管理者へ送信'}
            </button>
          </form>
        )}

        {mode === 'login' ? (
          <button type="button" className="lfirst" onClick={() => switchTo('setup')}>
            <span className="lfirst-main">初めてログインする方はこちら</span>
            <span className="lfirst-sub">パスワード設定</span>
          </button>
        ) : (
          <button type="button" className="lswitch" onClick={() => switchTo('login')}>
            ログイン画面に戻る
          </button>
        )}

        {mode !== 'help' && (
          <p className="lnote">
            パスワードをお忘れの方・ログインできない方は
            <button type="button" className="notelink" onClick={() => switchTo('help')}>
              管理者への問い合わせ
            </button>
            をご利用ください
          </p>
        )}
      </div>
    </div>
  );
}

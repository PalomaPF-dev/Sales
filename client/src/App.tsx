import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, fetchMe, logout } from './api';
import type { User } from './types';
import { ROLE_NAMES } from './types';
import { UserContext } from './user';
import Login from './pages/Login';
import Setup from './pages/Setup';
import ChangePassword from './pages/ChangePassword';
import Dashboard from './pages/Dashboard';
import Deals from './pages/Deals';
import DealDetail from './pages/DealDetail';
import CorpDetail from './pages/CorpDetail';
import Settings from './pages/Settings';
import Users from './pages/Users';
import ImportPage from './pages/ImportPage';
import { IconBrand, IconDashboard, IconDeals, IconImport, IconSettings, IconUsers } from './components/icons';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupCandidates, setSetupCandidates] = useState<{ login_id: string; name: string; role: string }[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Cookieのセッションから復元する。
  // 未ログインなら、初期セットアップが必要な状態か（＝誰もパスワードを持たない）を確認する。
  useEffect(() => {
    fetchMe()
      .then((u) => { setUser(u); setLoading(false); })
      .catch(async () => {
        setUser(null);
        try {
          const s = await api<{ needsSetup: boolean; candidates: typeof setupCandidates }>('/setup/status');
          setSetupCandidates(s.needsSetup ? s.candidates : null);
        } catch (e) {
          // DB未接続などサーバー側の問題を、ログイン画面で握りつぶさない。
          // 入れないログイン画面を見せても原因が分からないため、内容をそのまま表示する。
          setSetupCandidates(null);
          setServerError((e as Error).message);
        }
        setLoading(false);
      });
  }, []);

  const signOut = async () => {
    await logout().catch(() => {});
    setUser(null);
    navigate('/');
  };

  if (loading) {
    return <div className="login-wrap"><p style={{ color: 'var(--ink-2)' }}>読み込み中...</p></div>;
  }

  if (!user) {
    // サーバー側の問題（DB未接続など）は、入れないログイン画面ではなく原因を出す
    if (serverError) {
      return (
        <div className="login-wrap">
          <div className="login-card">
            <h1>設定が完了していません</h1>
            <div className="alert error" style={{ whiteSpace: 'pre-wrap' }}>{serverError}</div>
            <p className="pt-note">
              設定を直したあとに、この画面を再読み込みしてください。<br />
              状況は <code>/api/health</code> でも確認できます。
            </p>
            <button className="btn" style={{ width: '100%', marginTop: 12 }}
              onClick={() => window.location.reload()}>
              再読み込み
            </button>
          </div>
        </div>
      );
    }
    // パスワードが1つも設定されていない初回のみ、セットアップ画面を出す
    if (setupCandidates?.length) {
      return <Setup candidates={setupCandidates} onDone={(u) => { setUser(u); setSetupCandidates(null); navigate('/'); }} />;
    }
    return <Login onLogin={(u) => { setUser(u); navigate('/'); }} />;
  }

  // 仮パスワードのままでは業務画面に進ませない
  if (user.mustChangePassword) {
    return (
      <ChangePassword
        forced
        onDone={() => fetchMe().then(setUser).catch(() => setUser(null))}
      />
    );
  }

  const canConfig = user.role === 'planning' || user.role === 'admin';
  const isAdmin = user.role === 'admin';

  return (
    <UserContext.Provider value={user}>
      <div className="layout">
        {user.authDisabled && (
          <div className="auth-off-banner">
            認証が無効になっています（DISABLE_AUTH）。
            URLを知っている人は誰でも価格データを閲覧・変更できます。
          </div>
        )}
        <aside className="sidebar">
          <div className="brand">
            <span className="mark"><IconBrand /></span>
            <span className="txt">
              <b>値上げ単価管理</b>
              <small>Price Management</small>
            </span>
          </div>
          <nav>
            <NavLink to="/dashboard"><IconDashboard /><span className="lbl">ダッシュボード</span></NavLink>
            <NavLink to="/deals"><IconDeals /><span className="lbl">案件一覧</span></NavLink>
            <div className="nav-sep" />
            <NavLink to="/import"><IconImport /><span className="lbl">Excel取込</span></NavLink>
            {canConfig && <NavLink to="/settings"><IconSettings /><span className="lbl">設定</span></NavLink>}
            {isAdmin && <NavLink to="/users"><IconUsers /><span className="lbl">管理者画面</span></NavLink>}
          </nav>
          <div className="spacer" />
          <div className="userbox">
            <div className="name">{user.name}</div>
            <div className="role">
              {ROLE_NAMES[user.role]}
              {user.branch ? ` ・ ${user.branch}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn secondary sm" onClick={() => navigate('/password')}>パスワード変更</button>
              <button className="btn secondary sm" onClick={signOut}>ログアウト</button>
            </div>
          </div>
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/deals" element={<Deals />} />
            <Route path="/deals/:id" element={<DealDetail />} />
            <Route path="/corps/:code" element={<CorpDetail />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/users" element={<Users />} />
            <Route path="/password" element={<ChangePassword onDone={() => navigate('/')} />} />
          </Routes>
        </main>
      </div>
    </UserContext.Provider>
  );
}

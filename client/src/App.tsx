import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, fetchMe, logout } from './api';
import type { Application, User } from './types';
import { ROLE_NAMES } from './types';
import { UserContext } from './user';
import Login from './pages/Login';
import Setup from './pages/Setup';
import ChangePassword from './pages/ChangePassword';
import Dashboard from './pages/Dashboard';
import Deals from './pages/Deals';
import DealDetail from './pages/DealDetail';
import NewApplication from './pages/NewApplication';
import Applications from './pages/Applications';
import ApplicationDetail from './pages/ApplicationDetail';
import Settings from './pages/Settings';
import Users from './pages/Users';
import Notifications from './pages/Notifications';
import ImportPage from './pages/ImportPage';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupCandidates, setSetupCandidates] = useState<{ login_id: string; name: string; role: string }[] | null>(null);
  const [inboxCount, setInboxCount] = useState(0);
  const [unread, setUnread] = useState(0);
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
        } catch {
          setSetupCandidates(null);
        }
        setLoading(false);
      });
  }, []);

  const refreshInbox = useCallback(() => {
    if (!user || user.mustChangePassword) return;
    api<Application[]>('/applications?inbox=1')
      .then((rows) => setInboxCount(rows.length))
      .catch(() => setInboxCount(0));
    api<{ unread: number }>('/notifications')
      .then((r) => setUnread(r.unread))
      .catch(() => setUnread(0));
  }, [user]);

  useEffect(() => {
    refreshInbox();
    const t = setInterval(refreshInbox, 30000);
    return () => clearInterval(t);
  }, [refreshInbox]);

  const signOut = async () => {
    await logout().catch(() => {});
    setUser(null);
    navigate('/');
  };

  if (loading) {
    return <div className="login-wrap"><p style={{ color: 'var(--ink-2)' }}>読み込み中...</p></div>;
  }

  if (!user) {
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

  const canApprove = user.role === 'branch_manager' || user.role === 'planning' || user.role === 'admin';
  const canConfig = user.role === 'planning' || user.role === 'admin';

  return (
    <UserContext.Provider value={user}>
      <div className="layout">
        {user.authDisabled && (
          <div className="auth-off-banner">
            認証が無効になっています（DISABLE_AUTH）。
            URLを知っている人は誰でも価格データを閲覧・変更でき、承認者も記録されません。
          </div>
        )}
        <aside className="sidebar">
          <div className="brand">
            値上げ交渉管理
            <small>営業価格申請システム</small>
          </div>
          <nav>
            <NavLink to="/" end>ダッシュボード</NavLink>
            <NavLink to="/deals">案件一覧</NavLink>
            <NavLink to="/applications">申請一覧</NavLink>
            {canApprove && (
              <NavLink to="/inbox">
                承認箱
                {inboxCount > 0 && <span className="badge red">{inboxCount}</span>}
              </NavLink>
            )}
            <NavLink to="/notifications">
              通知
              {unread > 0 && <span className="badge red">{unread}</span>}
            </NavLink>
            <NavLink to="/import">Excel取込</NavLink>
            {canConfig && <NavLink to="/settings">設定</NavLink>}
            {canConfig && <NavLink to="/users">ユーザー管理</NavLink>}
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
            <Route path="/deals" element={<Deals />} />
            <Route path="/deals/:id" element={<DealDetail />} />
            <Route path="/applications/new" element={<NewApplication />} />
            <Route path="/applications" element={<Applications mode="all" />} />
            <Route path="/inbox" element={<Applications mode="inbox" />} />
            <Route path="/applications/:id" element={<ApplicationDetail onChanged={refreshInbox} />} />
            <Route path="/notifications" element={<Notifications onChanged={refreshInbox} />} />
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

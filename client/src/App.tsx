import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, getUser, setUser } from './api';
import type { Application, User } from './types';
import { ROLE_NAMES } from './types';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Deals from './pages/Deals';
import DealDetail from './pages/DealDetail';
import NewApplication from './pages/NewApplication';
import Applications from './pages/Applications';
import ApplicationDetail from './pages/ApplicationDetail';
import Settings from './pages/Settings';
import ImportPage from './pages/ImportPage';

export default function App() {
  const [user, setUserState] = useState<User | null>(getUser());
  const [inboxCount, setInboxCount] = useState(0);
  const navigate = useNavigate();

  const refreshInbox = () => {
    if (!getUser()) return;
    api<Application[]>('/applications?inbox=1')
      .then((rows) => setInboxCount(rows.length))
      .catch(() => setInboxCount(0));
  };

  useEffect(() => {
    refreshInbox();
    const t = setInterval(refreshInbox, 30000);
    return () => clearInterval(t);
  }, [user]);

  if (!user) {
    return (
      <Login
        onLogin={(u) => {
          setUser(u);
          setUserState(u);
          navigate('/');
        }}
      />
    );
  }

  const canApprove = user.role === 'branch_manager' || user.role === 'planning' || user.role === 'admin';
  const canConfig = user.role === 'planning' || user.role === 'admin';

  return (
    <div className="layout">
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
          <NavLink to="/import">Excel取込</NavLink>
          {canConfig && <NavLink to="/settings">設定</NavLink>}
        </nav>
        <div className="spacer" />
        <div className="userbox">
          <div className="name">{user.name}</div>
          <div className="role">
            {ROLE_NAMES[user.role]}
            {user.branch ? ` ・ ${user.branch}` : ''}
          </div>
          <button
            className="btn secondary sm"
            onClick={() => {
              setUser(null);
              setUserState(null);
            }}
          >
            ユーザー切替
          </button>
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
          <Route path="/import" element={<ImportPage />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

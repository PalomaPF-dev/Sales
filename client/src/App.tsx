import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, fetchMe, logout } from './api';
import type { User } from './types';
import { ROLE_NAMES } from './types';
import { UserContext } from './user';
import Login from './pages/Login';
import Setup from './pages/Setup';
import ChangePassword from './pages/ChangePassword';
import Dashboard from './pages/Dashboard';
import { IconBrand, IconDashboard, IconDeals, IconImport, IconInbox, IconSettings } from './components/icons';

// 最初に出るのはログインとダッシュボードだけ。残りは開いたときに読み込む。
// 全部をひとまとめにすると、最初の表示までに数百KBの待ちが入る。
const Deals = lazy(() => import('./pages/Deals'));
const DealDetail = lazy(() => import('./pages/DealDetail'));
const CorpDetail = lazy(() => import('./pages/CorpDetail'));

const Users = lazy(() => import('./pages/Users'));
const ImportPage = lazy(() => import('./pages/ImportPage'));
const Contact = lazy(() => import('./pages/Contact'));


/** 表示の切替。自動＝画面の幅で決める */
type ViewMode = 'auto' | 'mobile' | 'pc';
/** これ以下の幅ならスマホ向けの見た目にする（自動のとき） */
const MOBILE_MAX = 860;
const VIEW_LABEL: Record<ViewMode, string> = { auto: '自動', mobile: 'スマホ', pc: 'PC' };

/** 前に選んだ表示。覚えていなければ「自動」 */
const initialViewMode = (): ViewMode => {
  const v = localStorage.getItem('viewMode');
  return v === 'mobile' || v === 'pc' ? v : 'auto';
};
/** 最初の描画でスマホ向けの見た目にするか */
const initialMobile = () => {
  const v = initialViewMode();
  return v === 'mobile' || (v === 'auto' && window.innerWidth <= MOBILE_MAX);
};
/** メニューを開いた状態で覚えているか（PCの見た目のときだけ使う） */
const sideOpenPref = () => localStorage.getItem('sideOpen') !== '0';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // 待ち時間が長いときだけ理由を添える。
  // データベースは使っていない間は止まっており、最初の1回だけ起動を待つ。
  // 何も出ないと固まったように見えるため、数秒たったら状況を知らせる。
  const [slow, setSlow] = useState(false);
  const [setupCandidates, setSetupCandidates] = useState<{ login_id: string; name: string; role: string }[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  // お問い合わせへの未読の回答数。ログイン後に1回だけ確かめて、上部の帯で知らせる
  const [unreadReplies, setUnreadReplies] = useState(0);
  // 表示の切替。自動（画面の幅で決める）／スマホ／PC の3つ。選んだ内容は覚えておく
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  // いまスマホ向けの見た目で出しているか（自動のときは画面の幅で決まる）
  const [narrow, setNarrow] = useState(() => window.innerWidth <= MOBILE_MAX);
  // サイドバーの開閉。案件一覧を広く見たい人向けに、たたんだ状態を覚えておく。
  // スマホの見た目のときは画面に重なる引き出しになるため、初めは閉じておく
  const [sideOpen, setSideOpen] = useState(() => !initialMobile() && sideOpenPref());
  const navigate = useNavigate();

  const toggleSide = () => setSideOpen((v) => {
    try { localStorage.setItem('sideOpen', v ? '0' : '1'); } catch { /* プライベートモード等では覚えない */ }
    return !v;
  });

  const isMobile = viewMode === 'mobile' || (viewMode === 'auto' && narrow);

  /** 表示の切替。自動 → スマホ → PC の順に回す */
  const cycleView = () => setViewMode((v) => {
    const next: ViewMode = v === 'auto' ? 'mobile' : v === 'mobile' ? 'pc' : 'auto';
    try { localStorage.setItem('viewMode', next); } catch { /* 覚えられなくても動く */ }
    return next;
  });

  // 画面の幅が変わったら「自動」の判定をやり直す（横向きにしたときなど）
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= MOBILE_MAX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 見た目の切替は、いちばん外側（html）の目印で行う。
  // PC表示のときは、スマホでも画面の作りを変えずに全体を縮めて出す
  useEffect(() => {
    document.documentElement.classList.toggle('view-mobile', isMobile);
    const vp = document.querySelector('meta[name=viewport]');
    vp?.setAttribute('content',
      viewMode === 'pc' ? 'width=1280' : 'width=device-width, initial-scale=1.0');
  }, [isMobile, viewMode]);

  // スマホの見た目に変わったとき、メニューは引き出し（重なる形）になるので閉じておく。
  // PCの見た目へ戻したら、覚えていた開き具合に戻す
  const wasMobile = useRef(isMobile);
  useEffect(() => {
    if (wasMobile.current === isMobile) return;
    wasMobile.current = isMobile;
    setSideOpen(isMobile ? false : sideOpenPref());
  }, [isMobile]);

  useEffect(() => {
    if (!user) { setUnreadReplies(0); return; }
    api<{ unread: number }>('/inquiries/mine')
      .then((r) => setUnreadReplies(r.unread))
      .catch(() => {});
  }, [user]);

  // Cookieのセッションから復元する。
  // 未ログインなら、初期セットアップが必要な状態か（＝誰もパスワードを持たない）を確認する。
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 3000);
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
      })
      .finally(() => clearTimeout(timer));
    return () => clearTimeout(timer);
  }, []);

  const signOut = async () => {
    await logout().catch(() => {});
    setUser(null);
    navigate('/');
  };

  if (loading) {
    return (
      <div className="login-wrap">
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--ink-2)' }}>読み込み中...</p>
          {slow && (
            <p style={{ color: 'var(--muted)', fontSize: 12.5, maxWidth: 320 }}>
              しばらく使っていなかったため、データベースを起動しています。<br />
              初回は30秒ほどかかることがあります。そのままお待ちください。
            </p>
          )}
        </div>
      </div>
    );
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


  const isAdmin = user.role === 'admin' || user.role === 'developer';

  return (
    <UserContext.Provider value={user}>
      <div className={`layout${sideOpen ? '' : ' side-hidden'}${isMobile ? ' mobile' : ''}`}>
        {user.authDisabled && (
          <div className="auth-off-banner">
            認証が無効になっています（DISABLE_AUTH）。
            URLを知っている人は誰でも価格データを閲覧・変更できます。
          </div>
        )}
        {/* スマホ表示のときの上の帯。メニューの開閉と表示の切替をここから行う */}
        {isMobile ? (
          <header className="mtop">
            <button className="mtop-btn" onClick={toggleSide}
              title="メニュー" aria-label="メニュー">☰</button>
            <span className="mtop-title">値上げ単価管理</span>
            <button className="mtop-btn wide" onClick={cycleView}
              title="表示の切替（自動・スマホ・PC）">表示: {VIEW_LABEL[viewMode]}</button>
          </header>
        ) : !sideOpen && (
          <button className="side-open-btn" onClick={toggleSide}
            title="メニューを開く" aria-label="メニューを開く">☰</button>
        )}
        {/* 引き出しの外側を押したら閉じる（スマホ表示のとき） */}
        {isMobile && sideOpen && (
          <div className="drawer-back" onClick={toggleSide} aria-hidden="true" />
        )}
        <aside className="sidebar">
          <div className="brand">
            <span className="mark"><IconBrand /></span>
            <span className="txt">
              <b>値上げ単価管理</b>
              <small>Price Management</small>
            </span>
            <button className="side-close-btn" onClick={toggleSide}
              title="メニューをたたむ（一覧を広く使えます）" aria-label="メニューをたたむ">◀</button>
          </div>
          <nav onClick={() => { if (isMobile) setSideOpen(false); }}>
            <NavLink to="/dashboard"><IconDashboard /><span className="lbl">ダッシュボード</span></NavLink>
            <NavLink to="/deals"><IconDeals /><span className="lbl">案件一覧</span></NavLink>
            <div className="nav-sep" />
            <NavLink to="/import"><IconImport /><span className="lbl">Excel取込</span></NavLink>
            <NavLink to="/contact">
              <IconInbox />
              <span className="lbl">
                お問い合わせ
                {unreadReplies > 0 && <span className="badge red" style={{ marginLeft: 6 }}>{unreadReplies}</span>}
              </span>
            </NavLink>
            {/* 設定（ユーザー管理など）。管理者だけに見せる */}
            {isAdmin && <NavLink to="/settings"><IconSettings /><span className="lbl">設定</span></NavLink>}
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
              {/* 表示の切替。自動は画面の幅で決め、スマホ・PCは選んだ見た目で固定する */}
              <button className="btn secondary sm" onClick={cycleView}
                title="スマホ向けの見た目とPC向けの見た目を切り替えます（自動は画面の幅で決めます）">
                表示: {VIEW_LABEL[viewMode]}
              </button>
            </div>
          </div>
        </aside>
        <main className="main"
              onClick={(e) => {
                if (!isMobile) return;
                // 折りたたんだ説明を押したら全文を出す（もう一度押すと閉じる）
                const sub = (e.target as HTMLElement).closest('.page-sub');
                sub?.classList.toggle('open');
              }}>
          {/* お問い合わせに回答が付いたことを知らせる（ポータルと同じ）。開くと消える */}
          {unreadReplies > 0 && (
            <div className="alert info" style={{ cursor: 'pointer' }}
                 onClick={() => { setUnreadReplies(0); navigate('/contact'); }}>
              <strong>お問い合わせに回答が届いています</strong>（{unreadReplies}件）。ここを押すと確認できます。
            </div>
          )}
          <Suspense fallback={<p style={{ color: 'var(--muted)' }}>読み込み中...</p>}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/deals" element={<Deals />} />
              <Route path="/deals/:id" element={<DealDetail />} />
              <Route path="/corps/:code" element={<CorpDetail />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/contact" element={<Contact />} />
              <Route path="/settings" element={<Users />} />
              <Route path="/users" element={<Users />} />
              <Route path="/password" element={<ChangePassword onDone={() => navigate('/')} />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </UserContext.Provider>
  );
}

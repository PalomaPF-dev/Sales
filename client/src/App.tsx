import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, fetchMe, logout } from './api';
import type { User } from './types';
import { ROLE_NAMES } from './types';
import { UserContext, isViewerRole } from './user';
import { MobileContext } from './view';
import Login from './pages/Login';
import Setup from './pages/Setup';
import ChangePassword from './pages/ChangePassword';
import Dashboard from './pages/Dashboard';
import { IconChart, IconDashboard, IconDeals, IconHelp, IconImport, IconInbox, IconLogout, IconSettings } from './components/icons';

// 最初に出るのはログインとダッシュボードだけ。残りは開いたときに読み込む。
// 全部をひとまとめにすると、最初の表示までに数百KBの待ちが入る。
const Deals = lazy(() => import('./pages/Deals'));
const AvgPrices = lazy(() => import('./pages/AvgPrices'));
const DealDetail = lazy(() => import('./pages/DealDetail'));
const CorpDetail = lazy(() => import('./pages/CorpDetail'));

const Users = lazy(() => import('./pages/Users'));
const ImportPage = lazy(() => import('./pages/ImportPage'));
const Contact = lazy(() => import('./pages/Contact'));
const Help = lazy(() => import('./pages/Help'));
const About = lazy(() => import('./pages/About'));
const Terms = lazy(() => import('./pages/Terms'));


/** 表示の切替。自動＝画面の幅で決める */
type ViewMode = 'auto' | 'mobile' | 'pc';
/** これ以下の幅ならスマホ向けの見た目にする（自動のとき） */
const MOBILE_MAX = 860;
const VIEW_LABEL: Record<ViewMode, string> = { auto: '自動', mobile: 'スマホ固定', pc: 'PC固定' };

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

  /** 表示を選び直す（サイドバーの3択）。選んだ内容は覚えておく */
  const setView = (next: ViewMode) => {
    try { localStorage.setItem('viewMode', next); } catch { /* 覚えられなくても動く */ }
    setViewMode(next);
  };
  /** 表示の切替。自動 → スマホ → PC の順に回す（スマホの上の帯から使う） */
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
          // 生のメッセージだけでは何を直せばよいか分からないので、
          // /api/health から直し方（hint）と接続先も取って添える。
          setSetupCandidates(null);
          setServerError((e as Error).message);
          try {
            const res = await fetch('/api/health', { credentials: 'same-origin' });
            const h = await res.json() as {
              error?: string; hint?: string;
              target?: { host: string; port: string; user: string; database: string };
            };
            if (h.hint || h.target) {
              setServerError([
                h.error ?? (e as Error).message,
                h.hint && `\n${h.hint}`,
                h.target && `\n接続先: ${h.target.host}:${h.target.port}`
                  + ` / ユーザー: ${h.target.user} / データベース: ${h.target.database}`,
              ].filter(Boolean).join('\n'));
            }
          } catch { /* 取れなければ元のメッセージのまま出す */ }
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
  // 閲覧専用（共通ID）。取込やパスワード変更は出さない
  const viewer = isViewerRole(user.role);
  // サイドバー下部の表示（ポータル・他のPFアプリと同じ並び）。
  // 所属は支店・営業所。本社や管理者のように支店を持たない人は出さない。
  const affiliation = [user.branch, user.office].filter(Boolean).join(' ');
  // このアプリで扱えるデータの範囲。絞り込みの規則は権限ごとに違う
  const scopeText = viewer ? '全社のデータ（閲覧のみ）'
    : isAdmin || user.role === 'planning' ? '全社のデータ'
      : user.role === 'wide_area' ? '担当する広域のデータ'
        : user.role === 'branch_manager' ? `${user.branch ?? ''}のデータ`
          : `${affiliation || '自分'}のデータ`;

  return (
    <UserContext.Provider value={user}>
     <MobileContext.Provider value={isMobile}>
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
            <img className="mtop-logo" src="/paloma-logo.png" alt="株式会社パロマ" />
            <span className="mtop-title">価格改定進捗</span>
            <button className="mtop-btn wide" onClick={cycleView}
              title="表示の切替（自動・スマホ・PC）">{VIEW_LABEL[viewMode]}</button>
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
          {/* ロゴ。会社ロゴ＋アプリ名（ポータル・他のPFアプリと同じ並び） */}
          <div className="brand">
            <span className="mark">
              <img src="/paloma-logo.png" alt="株式会社パロマ" />
            </span>
            <span className="txt">
              <b>価格改定進捗</b>
            </span>
            <button className="side-close-btn" onClick={toggleSide}
              title="メニューをたたむ（一覧を広く使えます）" aria-label="メニューをたたむ">◀</button>
          </div>
          <nav onClick={() => { if (isMobile) setSideOpen(false); }}>
            <div className="nav-head">日々の運用</div>
            <NavLink to="/dashboard"><IconDashboard /><span className="lbl">ダッシュボード</span></NavLink>
            <NavLink to="/deals"><IconDeals /><span className="lbl">案件一覧</span></NavLink>
            <NavLink to="/avg-prices"><IconChart /><span className="lbl">平均単価</span></NavLink>
            {(!viewer || isAdmin) && <div className="nav-head">取込・設定</div>}
            {!viewer && <NavLink to="/import"><IconImport /><span className="lbl">Excel取込</span></NavLink>}
            {/* 設定（ユーザー管理など）。管理者だけに見せる */}
            {isAdmin && <NavLink to="/settings"><IconSettings /><span className="lbl">設定</span></NavLink>}
            <div className="nav-head">サポート</div>
            <NavLink to="/help"><IconHelp /><span className="lbl">使い方</span></NavLink>
            <NavLink to="/contact">
              <IconInbox />
              <span className="lbl">
                お問い合わせ
                {unreadReplies > 0 && <span className="badge red" style={{ marginLeft: 6 }}>{unreadReplies}</span>}
              </span>
            </NavLink>
          </nav>
          <div className="spacer" />
          {/* 表示モードの切替。ポータル・他のPFアプリと同じ3択の並び */}
          <div className="viewswitch">
            <div className="vs-label">表示モード</div>
            <div className="vs-seg">
              {(['auto', 'mobile', 'pc'] as const).map((m) => (
                <button key={m} type="button"
                        className={viewMode === m ? 'on' : ''}
                        onClick={() => setView(m)}>
                  {VIEW_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
          {/* ログインしている人の所属・氏名・権限・扱えるデータの範囲 */}
          <div className="userbox">
            <div className="name">
              {affiliation && <>{affiliation}<span className="sep">/</span></>}
              {user.name}
            </div>
            <div className="who">
              <span className={`rbadge${isAdmin ? ' admin' : ''}`}
                    title={isAdmin ? 'このアプリで承認やマスタ設定ができる権限です'
                      : 'このアプリで日常の入力・閲覧ができる権限です'}>
                {ROLE_NAMES[user.role]}
              </span>
              <span className="scope">{scopeText}</span>
            </div>
            {/* お問い合わせはサポートのメニューにあるので、ここには置かない */}
            <div className="btnrow">
              {/* 閲覧専用は共通IDのため、1人が変えると全員が入れなくなる。変更は管理者が行う */}
              {!viewer && (
                <button className="btn secondary" onClick={() => navigate('/password')}>
                  パスワード変更
                </button>
              )}
              <button className="btn secondary" onClick={signOut}>
                <IconLogout />ログアウト
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
          {/*
            ログインしている人の帯。
            どの支店・営業所の立場で見ているかで数字が変わるアプリなので、
            「いま誰として見ているか」を画面の上にはっきり出す。
          */}
          <header className="apphead">
            <div className="who">
              <span className="item">
                <small>支店（部署）</small>
                <b>{user.branch || '本社'}</b>
              </span>
              <span className="item">
                <small>営業所（室）</small>
                <b>{user.office || '—'}</b>
              </span>
              <span className="item">
                <small>役職</small>
                <b>{user.title || ROLE_NAMES[user.role]}</b>
              </span>
              <span className="item name">
                <small>氏名</small>
                <b>{user.name}</b>
              </span>
              <span className={`rbadge${isAdmin ? ' admin' : ''}`}
                    title={`このアプリでの権限：${ROLE_NAMES[user.role]}（${scopeText}）`}>
                {ROLE_NAMES[user.role]}
              </span>
            </div>
          </header>
          {/* お問い合わせに回答が付いたことを知らせる（ポータルと同じ）。開くと消える */}
          {unreadReplies > 0 && (
            <div className="alert info" style={{ cursor: 'pointer' }}
                 onClick={() => { setUnreadReplies(0); navigate('/contact'); }}>
              <strong>お問い合わせに回答が届いています</strong>（{unreadReplies}件）。ここを押すと確認できます。
            </div>
          )}
          <div className="main-body">
          <Suspense fallback={<p style={{ color: 'var(--muted)' }}>読み込み中...</p>}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/deals" element={<Deals />} />
              <Route path="/avg-prices" element={<AvgPrices />} />
              <Route path="/deals/:id" element={<DealDetail />} />
              <Route path="/corps/:code" element={<CorpDetail />} />
              <Route path="/import" element={viewer ? <Dashboard /> : <ImportPage />} />
              <Route path="/contact" element={<Contact />} />
              <Route path="/help" element={<Help />} />
              <Route path="/about" element={<About />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/settings" element={<Users />} />
              <Route path="/users" element={<Users />} />
              <Route path="/password"
                     element={viewer ? <Dashboard /> : <ChangePassword onDone={() => navigate('/')} />} />
            </Routes>
          </Suspense>
          </div>
          {/*
            アプリ内フッター。画面の中身が短くても、いちばん下に置く。
            規約は本アプリ専用のものを持つ（ポータルの共通規約は
            生産・調達統括本部のアプリ向けで、本アプリには当てはまらないため）。
          */}
          <footer className="appfoot">
            <span className="org">© {new Date().getFullYear()} 株式会社パロマ　営業本部</span>
            <a href="/terms" onClick={(e) => { e.preventDefault(); navigate('/terms'); }}
               title="本アプリの利用規約・著作権ポリシー（免責を含む）">
              利用規約・著作権ポリシー
            </a>
            <a href="/about" onClick={(e) => { e.preventDefault(); navigate('/about'); }}>
              バックアップ・仕様の説明
            </a>
            <a href="/help" onClick={(e) => { e.preventDefault(); navigate('/help'); }}>
              使い方
            </a>
          </footer>
        </main>
      </div>
     </MobileContext.Provider>
    </UserContext.Provider>
  );
}

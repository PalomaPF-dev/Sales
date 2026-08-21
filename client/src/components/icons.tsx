/**
 * サイドバー用のアイコン。外部依存を増やさないよう、必要なものだけ手書きで持つ。
 * すべて 24x24 のストローク描画で、色は currentColor に従う。
 */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function IconDashboard() {
  return (
    <svg {...base}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

export function IconDeals() {
  return (
    <svg {...base}>
      <path d="M3 5.5h18M3 12h18M3 18.5h18" />
      <circle cx="7.5" cy="5.5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="14" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="10" cy="18.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconApplications() {
  return (
    <svg {...base}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13.5l2 2 4-4" />
    </svg>
  );
}

export function IconInbox() {
  return (
    <svg {...base}>
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
      <path d="M4.5 5h15l1.5 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z" />
    </svg>
  );
}

export function IconBell() {
  return (
    <svg {...base}>
      <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
      <path d="M10.5 20a2 2 0 0 0 3 0" />
    </svg>
  );
}

export function IconImport() {
  return (
    <svg {...base}>
      <path d="M12 3v11" />
      <path d="M8 10.5l4 4 4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

export function IconSettings() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-2.87-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.2-2.87l-.06-.06A2 2 0 1 1 8.56 5.24l.06.06A1.7 1.7 0 0 0 10.5 5.6V4.5a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.2 2.87h.1a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.01z" />
    </svg>
  );
}

export function IconUsers() {
  return (
    <svg {...base}>
      <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
      <circle cx="9" cy="7.5" r="3.5" />
      <path d="M22 20v-1.5a4 4 0 0 0-3-3.87" />
      <path d="M16.5 4.13a4 4 0 0 1 0 6.74" />
    </svg>
  );
}

/** サイドバー先頭のロゴ */
export function IconBrand() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" width="17" height="17">
      <path d="M4 19V11" />
      <path d="M10 19V5" />
      <path d="M16 19v-6" />
      <path d="M21 8l-5 5-3-3-4 4" opacity="0.55" />
    </svg>
  );
}

/** 使い方（？マーク） */
export function IconHelp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.3 9a2.8 2.8 0 0 1 5.4 1c0 1.8-2.7 2.2-2.7 3.6" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** ログアウト（扉から出る矢印） */
export function IconLogout() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

/** ポータル（アプリの一覧） */
export function IconGrid() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

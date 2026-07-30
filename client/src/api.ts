import type { User } from './types';

const KEY = 'sales-app-user';

export function getUser(): User | null {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as User) : null;
}

export function setUser(u: User | null) {
  if (u) localStorage.setItem(KEY, JSON.stringify(u));
  else localStorage.removeItem(KEY);
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const user = getUser();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (user) headers['x-user-id'] = String(user.id);
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `エラー (${res.status})`);
  return data as T;
}

export const fmt = new Intl.NumberFormat('ja-JP');
export const yen = (v: number | null | undefined) =>
  v == null ? '—' : `${fmt.format(Math.round(v))}`;
export const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${v.toFixed(1)}%`;

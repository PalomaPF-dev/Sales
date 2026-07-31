import type { User } from './types';

/**
 * APIクライアント。
 * 認証はHttpOnly Cookieのセッションで行うため、
 * ブラウザ側にユーザー情報やトークンを保持しない（localStorageは使わない）。
 */
export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error || `エラー (${res.status})`) as ApiError;
    err.status = res.status;
    err.mustChangePassword = Boolean((data as { mustChangePassword?: boolean }).mustChangePassword);
    throw err;
  }
  return data as T;
}

export interface ApiError extends Error {
  status?: number;
  mustChangePassword?: boolean;
}

export const login = (loginId: string, password: string) =>
  api<User>('/login', { method: 'POST', body: JSON.stringify({ loginId, password }) });

export const logout = () => api('/logout', { method: 'POST' });

export const fetchMe = () => api<User>('/me');

export const changePassword = (currentPassword: string, newPassword: string) =>
  api('/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });

export const fmt = new Intl.NumberFormat('ja-JP');
export const yen = (v: number | null | undefined) =>
  v == null ? '—' : `${fmt.format(Math.round(v))}`;
export const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${v.toFixed(1)}%`;

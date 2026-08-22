import { createContext, useContext } from 'react';
import type { User } from './types';

/** ログイン中のユーザー。App が /api/me の結果を流し込む */
export const UserContext = createContext<User | null>(null);

/** ログイン済み画面で使う。App がログイン前に描画しないため null にはならない */
export function useUser(): User {
  const user = useContext(UserContext);
  if (!user) throw new Error('useUser はログイン後の画面でのみ使用できます');
  return user;
}

/**
 * 閲覧専用（共通IDで配る権限）。入力の欄・ボタンを出さないために使う。
 * サーバー側でも書き込みを止めているため、ここは見た目の整理のためのもの。
 */
export const isViewerRole = (role: string) => role === 'viewer';

/** 値上げ交渉の入力ができるか（閲覧専用以外） */
export function useCanEdit(): boolean {
  return !isViewerRole(useUser().role);
}

/**
 * 実績原価まで含めて、すべての情報を見られる権限。
 * 原価は社外秘のため、本社（営業部・製品企画部）と管理者・開発者だけ。
 * サーバーの canSeeAllInfo と揃える。
 */
export const canSeeAllInfo = (role: string) =>
  role === 'admin' || role === 'developer' || role === 'planning';

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

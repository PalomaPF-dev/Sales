import { createContext, useContext } from 'react';

/**
 * いまスマホ向けの見た目で出しているか。App が「表示: 自動／スマホ／PC」の
 * 判定結果を流し込む。画面ごとに出す項目や単位を変えるために使う。
 */
export const MobileContext = createContext(false);

export const useIsMobile = () => useContext(MobileContext);

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 横に長い表のための、上側にも出す横スクロールバー。
 *
 * 案件一覧は列が多く、下端のスクロールバーまで目線と手を動かすのが手間になる。
 * 表の上に同じ幅のスクロールバーを重ねて置き、どちらを動かしても連動させる。
 *
 * 上のバーは見た目だけの入れ物で、中身は幅を持たせた空のdiv。
 * 実際の表は今までどおり下の要素に入る。
 */
export default function HScroll({
  children,
  className,
  fillViewport = false,
  bottomGap = 16,
}: {
  children: React.ReactNode;
  className?: string;
  /**
   * 表の入れ物を画面の下端までの高さに収め、中だけを縦にスクロールさせる。
   * こうすると見出し（position: sticky）が入れ物の上に留まり、
   * 下へスクロールしても項目名が見えたままになる。
   */
  fillViewport?: boolean;
  /** 表の下に置くもの（ページ送りなど）のぶん、高さを空けておく */
  bottomGap?: number;
}) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);
  // 連動させるとき、相手のscrollイベントで戻ってくるのを止める
  const syncing = useRef(false);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (el) setWidth(el.scrollWidth);
  }, []);

  /**
   * 入れ物の高さを、画面の下端までに合わせる。
   * 絞り込みの折り返しなどで表の位置が変わるので、そのつど測り直す。
   * 低すぎると使いにくいので下限を設ける。
   */
  const fit = useCallback(() => {
    if (!fillViewport) { setMaxH(undefined); return; }
    const el = bodyRef.current;
    if (!el) return;
    // 画面の中での表の上端と、表より下にあるもの（ページ送りなど）の高さ。
    // 下のものまで画面に収めておかないと、そこを見るために画面を送ることになり、
    // 表の見出しが上へ流れてしまう。
    const rect = el.getBoundingClientRect();
    const below = Math.max(0, document.body.scrollHeight - (rect.bottom + window.scrollY));
    const room = window.innerHeight - rect.top - below - bottomGap;
    setMaxH(Math.max(240, Math.round(room)));
  }, [fillViewport, bottomGap]);

  useEffect(() => {
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit, children]);

  useEffect(() => {
    measure();
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // 列の増減や文字の折り返しで幅が変わるので、変化を見て測り直す
    const ro = new ResizeObserver(() => { measure(); fit(); });
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [measure, fit, children]);

  const link = (from: HTMLDivElement | null, to: HTMLDivElement | null) => () => {
    if (syncing.current || !from || !to) return;
    syncing.current = true;
    to.scrollLeft = from.scrollLeft;
    // 相手のscrollイベントが流れ終わってから解除する
    requestAnimationFrame(() => { syncing.current = false; });
  };

  // 横に収まっているときはバーを出さない（余計な線が増えるだけのため）
  const needed = width > (bodyRef.current?.clientWidth ?? 0) + 1;

  return (
    <>
      <div
        className={`hscroll-top${needed ? '' : ' hidden'}`}
        ref={topRef}
        onScroll={link(topRef.current, bodyRef.current)}
        aria-hidden="true"
      >
        <div style={{ width, height: 1 }} />
      </div>
      <div
        className={`${className ?? ''}${fillViewport ? ' vfill' : ''}`}
        ref={bodyRef}
        style={maxH ? { maxHeight: maxH } : undefined}
        onScroll={link(bodyRef.current, topRef.current)}
      >
        {children}
      </div>
    </>
  );
}

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
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // 連動させるとき、相手のscrollイベントで戻ってくるのを止める
  const syncing = useRef(false);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (el) setWidth(el.scrollWidth);
  }, []);

  useEffect(() => {
    measure();
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // 列の増減や文字の折り返しで幅が変わるので、変化を見て測り直す
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [measure, children]);

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
        className={className}
        ref={bodyRef}
        onScroll={link(bodyRef.current, topRef.current)}
      >
        {children}
      </div>
    </>
  );
}

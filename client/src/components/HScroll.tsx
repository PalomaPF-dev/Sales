import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 横に長い表の入れ物。
 *
 * 案件一覧は列が多いため横スクロールが要る。スクロールバーは表の下だけに出す
 * （上下に出ていると、どちらを動かしているのか分かりにくいため）。
 *
 * fillViewport を付けると、入れ物の高さを画面の下端までに収め、
 * 中だけを縦にスクロールさせる。こうすると見出し（position: sticky）が
 * 入れ物の上に留まり、下へスクロールしても項目名が見えたままになる。
 */
export default function HScroll({
  children,
  className,
  fillViewport = false,
  /** 表の下に置くもの（ページ送り・余白）のぶん、空けておく高さ */
  reserveBelow = 80,
  /** これより低くはしない。低すぎると数行しか見えず使いにくい */
  minHeight = 320,
}: {
  children: React.ReactNode;
  className?: string;
  fillViewport?: boolean;
  reserveBelow?: number;
  minHeight?: number;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);

  /**
   * 入れ物の高さを画面の下端までに合わせる。
   * 絞り込みの折り返しや説明の開閉で表の位置が変わるので、そのつど測り直す。
   */
  const fit = useCallback(() => {
    if (!fillViewport) { setMaxH(undefined); return; }
    const el = bodyRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    setMaxH(Math.max(minHeight, Math.round(window.innerHeight - top - reserveBelow)));
  }, [fillViewport, reserveBelow, minHeight]);

  useEffect(() => {
    fit();
    // 描き終わってから測り直す（読み込み直後は表の位置がまだ動くため）
    const t = window.setTimeout(fit, 120);
    window.addEventListener('resize', fit);
    return () => { window.clearTimeout(t); window.removeEventListener('resize', fit); };
  }, [fit, children]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // 列の増減や文字の折り返しで表の大きさが変わるので、変化を見て測り直す
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [fit, children]);

  return (
    <div
      className={`${className ?? ''}${fillViewport ? ' vfill' : ''}`}
      ref={bodyRef}
      style={maxH ? { maxHeight: maxH } : undefined}
    >
      {children}
    </div>
  );
}

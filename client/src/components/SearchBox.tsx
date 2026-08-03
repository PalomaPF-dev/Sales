import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Item { code?: string | null; name: string; count: number }
interface Group { key: string; label: string; filter: string; items: Item[] }

/**
 * 検索窓と候補の表示。
 *
 * 入力中に「その言葉で何が絞り込めるか」を種類ごとに出す。
 * 候補を選んだときは、法人・得意先はコードで絞り込む（同名の取引先を取り違えないため）。
 * 候補を使わずEnterを押した場合は、これまでどおり文字での検索になる。
 */
export default function SearchBox({
  value,
  onSearch,
  onPick,
}: {
  value: string;
  /** 文字での検索（Enter） */
  onSearch: (q: string) => void;
  /** 候補を選んだとき。filterは案件一覧の絞り込みキー */
  onPick: (filter: string, value: string) => void;
}) {
  const [text, setText] = useState(value);
  const [groups, setGroups] = useState<Group[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => { setText(value); }, [value]);

  // 打つたびに問い合わせると重いので、入力が止まってから取りに行く
  useEffect(() => {
    window.clearTimeout(timer.current);
    const q = text.trim();
    if (q.length < 1) { setGroups([]); return; }
    timer.current = window.setTimeout(() => {
      api<{ groups: Group[] }>(`/suggest?q=${encodeURIComponent(q)}`)
        .then((r) => { setGroups(r.groups); setActive(-1); })
        .catch(() => setGroups([]));
    }, 200);
    return () => window.clearTimeout(timer.current);
  }, [text]);

  // 外側を押したら閉じる
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // 上下キーで選べるように、種類ごとの候補を1本の並びに均す
  const flat = groups.flatMap((g) => g.items.map((it) => ({ group: g, item: it })));

  const pick = (g: Group, it: Item) => {
    setOpen(false);
    // 法人・得意先はコードで絞る。名前が同じでも別の取引先を選ばないため
    onPick(g.filter, g.filter === 'corp' || g.filter === 'customer' ? String(it.code ?? it.name) : it.name);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, -1)); }
    else if (e.key === 'Escape') { setOpen(false); }
    else if (e.key === 'Enter') {
      if (open && active >= 0 && flat[active]) { e.preventDefault(); pick(flat[active].group, flat[active].item); }
      else { setOpen(false); onSearch(text.trim()); }
    }
  };

  let index = -1;
  return (
    <div className="searchbox" ref={boxRef}>
      <input
        type="text"
        value={text}
        placeholder="例: 東京ガス / FH-1613 / 池田"
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {text && (
        <button type="button" className="clear" title="消す"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { setText(''); setGroups([]); onSearch(''); }}>×</button>
      )}
      {open && groups.length > 0 && (
        <div className="suggest">
          {groups.map((g) => (
            <div key={g.key} className="sg">
              <div className="sg-head">{g.label}</div>
              {g.items.map((it) => {
                index += 1;
                const i = index;
                return (
                  <button
                    type="button"
                    key={`${g.key}-${it.code ?? it.name}`}
                    className={`sg-item${i === active ? ' active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(g, it)}
                  >
                    <span className="nm">{it.name}</span>
                    <span className="ct">{Number(it.count).toLocaleString()}件</span>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="sg-foot">Enterでそのまま文字検索／↑↓で候補を選択</div>
        </div>
      )}
    </div>
  );
}

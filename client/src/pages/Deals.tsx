import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, yen } from '../api';
import { NEGO_LABELS } from '../types';
import type { Deal, Meta, RoundState } from '../types';
import SearchBox from '../components/SearchBox';
import HScroll from '../components/HScroll';
import type { BulkResult } from '../bulkUpdateClient';
import { useUser, isViewerRole } from '../user';
import { useIsMobile } from '../view';

interface DealsRes {
  rows: Deal[];
  totals: {
    count: number; r2_done: number;
    // 値上げ額（1か月あたり）の合計。当月・翌月・翌々月・3か月後のA基準それぞれ
    raise_m0: number | null;
    raise_m1: number | null; raise_m2: number | null; raise_m3: number | null;
    /** 売上改善額（過去最新単価 → 当月のマスタ単価）。上がった品目ぶん / 下がった品目ぶん */
    gain_plus: number | null; gain_minus: number | null;
  };
  page: number;
  size: number;
  months: number;        // 当月ぶん（=1）。金額はそのまま1か月あたり
  /** マスタ単価の月別実績の月（YYYY-MM、4月〜取込前日）。実績列の見出しに使う */
  histMonths?: string[];
}

/** マスタ登録単価のまとまりに並べる月。実績（月別履歴）と計画（当月〜3か月後） */
type MonthCol = { kind: 'hist'; ym: string } | { kind: 'plan'; n: 0 | 1 | 2 | 3 };

const FILTER_KEYS = ['q', 'equip', 'person', 'customer', 'corp', 'branch', 'office',
  'aState', 'act', 'aDateYm', 'aDateOp', 'gain'] as const;

// 並び替えに使うキー。サーバー側の許可リスト（SORTABLE）と揃える
const SORT_KEYS = ['sort', 'dir'] as const;

/** 「2026-04」形式かどうか。保存前に画面側でも確かめる */
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A基準の月の見出し。「2026-09」→「9月」。取込前は仮の名前で出す */
const ymLabel = (ym: string | undefined, fallback: string) =>
  ym && /^\d{4}-\d{2}$/.test(ym) ? `${Number(ym.slice(5, 7))}月` : fallback;

/** 商談結果の表記ゆれをそろえる（○/〇、×/✕ など）。選択肢に無い文字はそのまま */
const normNego = (v: string | null | undefined) => {
  const t = String(v ?? '').trim();
  if (['○', '〇', '◯'].includes(t)) return '〇';
  if (['□', '■'].includes(t)) return '□';
  if (['△', '▲'].includes(t)) return '△';
  if (['×', '✕', '✗', 'X', 'x', 'Ｘ'].includes(t)) return '×';
  return t;
};

/**
 * マスタ登録日（承認日）のうち一番新しいもの。
 * 計画（当月〜3か月後）のどこかに登録があれば、その最新日で「いつ登録された単価か」を見る。
 */
const newestMasterDate = (d: Deal) => {
  const days = [d.a_date_m0, d.a_date_m1, d.a_date_m2, d.a_date_m3]
    .map((v) => String(v ?? '').trim())
    .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))
    .sort();
  return days.length ? days[days.length - 1] : null;
};

/** 「2026-05」→「2026年5月」 */
const ymText = (ym: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${m[1]}年${Number(m[2])}月` : ym;
};

/** 承認日（登録日）の表示。「2026-06-05」→「26/6/5」 */
const dateLabel = (d: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d ?? ''));
  return m ? `${m[1].slice(2)}/${Number(m[2])}/${Number(m[3])}` : null;
};

export default function Deals() {
  const [params, setParams] = useSearchParams();
  const me = useUser();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [data, setData] = useState<DealsRes | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const isDev = me.role === 'developer';
  // 閲覧専用（共通ID）。入力・一括入力の欄は出さない
  const canEdit = !isViewerRole(me.role);
  const mobile = useIsMobile();
  /**
   * 合計の金額。スマホでは桁が多いと1行に収まらないため万円でまとめる。
   * 表の中の単価は1台あたりの金額なので、こちらは円のまま出す。
   */
  const sumYen = (v: number) => (mobile
    ? `${Math.round(v / 1e4).toLocaleString()}万`
    : `¥${yen(v)}`);
  // 本社（と管理者）。目標単価をこの画面から直接入力できる
  const isHq = ['planning', 'admin', 'developer'].includes(me.role);

  // マスタ登録単価のまとまりの表示位置。実績（4月〜）と計画（当月〜3か月後）を
  // ◀▶で1か月ずつずらして見る。null は既定（計画の先頭 = 当月から）
  const [mOff, setMOff] = useState<number | null>(null);

  // 値上げ交渉の一括入力。商談結果の左のチェックで品目を選び、
  // 入力の項目（商談結果・商談メモ・最終確定日・最終確定単価・適用年月）をまとめて入れる
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [selNego, setSelNego] = useState('');
  const [selNote, setSelNote] = useState('');
  const [selFinalDate, setSelFinalDate] = useState('');
  const [selFinalPrice, setSelFinalPrice] = useState('');
  const [selAppliedYm, setSelAppliedYm] = useState('');

  const toggleSel = (id: number) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /** 一括入力で送る内容。書き入れた項目だけを対象にし、空欄の項目は変更しない */
  const bulkBody = () => {
    const body: Record<string, unknown> = {};
    if (selNego) body.nego_result = selNego;
    if (selNote.trim()) body.nego_note = selNote.trim();
    if (selFinalDate) body.final_date = selFinalDate;
    if (selFinalPrice.trim() !== '') body.final_price = Number(selFinalPrice);
    if (selAppliedYm) body.r2_applied_ym = selAppliedYm;
    return body;
  };

  /** 選んだ品目へ、値上げ交渉の入力をまとめて入れる */
  const applyBulkNego = async () => {
    const body = bulkBody();
    if (!sel.size || !Object.keys(body).length) return;
    if (selAppliedYm && !YM_RE.test(selAppliedYm)) {
      setMsg({ kind: 'error', text: '適用年月は「2026-04」の形式で入れてください' });
      return;
    }
    setBusy(true);
    setMsg(null);
    let done = 0;
    try {
      for (const id of sel) {
        const updated = await api<Deal>(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        setData((prev) => prev && {
          ...prev,
          rows: prev.rows.map((r) => (r.id === id ? { ...r, ...updated } : r)),
        });
        done += 1;
      }
      setMsg({ kind: 'ok', text: `${done.toLocaleString()}件に一括入力しました（空欄の項目は変更していません）` });
      setSel(new Set());
      setSelNego('');
      setSelNote('');
      setSelFinalDate('');
      setSelFinalPrice('');
      setSelAppliedYm('');
    } catch (e) {
      setMsg({
        kind: 'error',
        text: `${done.toLocaleString()}件まで保存できました。続きでエラー: ${(e as Error).message}`,
      });
    } finally {
      setBusy(false);
    }
  };

  // Excelでの一括取込
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkProgress, setBulkProgress] = useState('');
  const [bulk, setBulk] = useState<(BulkResult & { dryRun: boolean; skippedRows: number }) | null>(null);

  /**
   * まず dryRun で件数を確かめ、確認できたら書き込む。
   * 数千行をまとめて書き換えるので、中身を見ずに適用できないようにしている。
   */
  const runBulk = async (dryRun: boolean) => {
    const file = bulkFileRef.current?.files?.[0];
    if (!file) { setMsg({ kind: 'error', text: 'ファイルを選択してください' }); return; }
    setBusy(true);
    setMsg(null);
    setBulkProgress('ファイルを読み込んでいます...');
    try {
      const bulkClient = await import('../bulkUpdateClient');
      const parsed = await bulkClient.parseBulkFile(file);
      setBulkProgress(`${parsed.rows.length.toLocaleString()}行を${dryRun ? '確認' : '取込'}中...`);
      const res = await bulkClient.sendBulkUpdate(parsed.rows, {
        dryRun,
        onProgress: (done, total) =>
          setBulkProgress(`${done.toLocaleString()} / ${total.toLocaleString()}行`),
      });
      setBulk({ ...res, dryRun, skippedRows: parsed.skippedRows });
      setBulkProgress('');
      if (!dryRun) load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
      setBulkProgress('');
    } finally {
      setBusy(false);
    }
  };

  const get = (k: string) => params.get(k) || '';
  const page = Number(params.get('page') || 1);

  /**
   * 古いマスタ登録の色分け。
   * 指定した年月より前に登録されたきり更新されていない単価を、赤くして見つけやすくする。
   * 例: 指定「2026-05」なら、2024-05-12 に登録された分は対象（2026年5月の登録は対象外）。
   * 絞り込みではないため、一覧の件数は変わらない。
   */
  // 検索欄に打っている途中の文字。「絞り込む」を押したときに、
  // Enterを押していなくてもその内容で絞り込めるようにする
  const qDraft = useRef(get('q'));

  // 画面の説明。表をできるだけ広く使うため、既定では閉じておく（選んだ状態は覚える）
  const [subOpen, setSubOpen] = useState(() => {
    try { return localStorage.getItem('deals.sub') === '1'; } catch { return false; }
  });
  const toggleSub = () => {
    setSubOpen((v) => {
      try { localStorage.setItem('deals.sub', v ? '0' : '1'); } catch { /* 使えなくても困らない */ }
      return !v;
    });
  };

  /**
   * 値上げ額の合計に入るか（承認日の条件）。
   * ダッシュボードと同じ決まりで、案件は全部出したまま、
   * 合計は承認日が条件に合う品目だけを足す。基準は3か月後の承認日。
   */
  const inRaise = (d: Deal) => {
    const ym = get('aDateYm');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return true;
    const first = `${ym}-01`;
    const v = String(d.a_date_m3 ?? '').slice(0, 10);
    return get('aDateOp') === 'before' ? v !== '' && v < first : v >= first;
  };

  const oldYm = get('oldYm');
  const isOldDate = (v: string | null | undefined) =>
    Boolean(oldYm && v && String(v).slice(0, 10) < `${oldYm}-01`);
  const isOldRow = (d: Deal) => isOldDate(newestMasterDate(d));

  /**
   * 絞り込みを書き換える。複数まとめて渡せるようにしてある。
   * 1つずつ呼ぶと、2回目が1回目より前の状態から作り直してしまい、
   * 先の変更が消える（支店を選ぶと同時に営業所を空にする場合など）。
   */
  const setMany = (updates: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== 'page') next.delete('page');
    }
    setParams(next, { replace: true });
  };
  const setParam = (key: string, value: string) => setMany({ [key]: value });

  useEffect(() => {
    api<Meta>('/meta').then((m) => {
      setMeta(m);
      // 営業担当者・支店長は自分の支店を初期表示にする
      // （広域担当・本社・管理者は全社のまま。支店長も絞り込みを外せば全支店が見える）
      if (!params.get('branch') && me.branch
          && ['sales', 'branch_manager'].includes(me.role)) {
        if (m.branches.some((b) => b.name === me.branch)) setParam('branch', me.branch);
      }
    }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, []);

  const queryString = useCallback(() => {
    const qs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (get(k)) qs.set(k, get(k));
    for (const k of SORT_KEYS) if (get(k)) qs.set(k, get(k));
    return qs;
  }, [params]);

  /**
   * 見出しを押したときの並び替え。
   * 同じ列を押すたびに 昇順 → 降順 → 既定の並び に戻る。
   */
  const toggleSort = (col: string) => {
    const cur = get('sort');
    const dir = get('dir');
    const next = new URLSearchParams(params);
    next.delete('page');
    if (cur !== col) { next.set('sort', col); next.set('dir', 'asc'); }
    else if (dir === 'asc') { next.set('dir', 'desc'); }
    else { next.delete('sort'); next.delete('dir'); }
    setParams(next, { replace: true });
  };

  /** 並び替えできる見出し。現在の向きを矢印で示す */
  const Th = ({ col, children, className, title }:
    { col: string; children?: React.ReactNode; className?: string; title?: string }) => {
    const on = get('sort') === col;
    const mark = on ? (get('dir') === 'desc' ? '▼' : '▲') : '';
    return (
      <th className={`${className ?? ''} sortable${on ? ' sorted' : ''}`}
          onClick={() => toggleSort(col)}
          title={title ? `${title}（押すと並び替えます）` : '押すと並び替えます（昇順→降順→解除）'}>
        {children}<span className="sort-mark">{mark}</span>
      </th>
    );
  };

  /** いま絞り込みが掛かっているか（「解除」を出すかの判断） */
  const hasFilters = FILTER_KEYS.some((k) => get(k)) || Boolean(get('oldYm'));

  /**
   * 「絞り込む」。検索欄に打った文字を取り込んだうえで一覧を出し直す。
   * 条件が変わらないときも、押せば最新の内容を取り直す。
   */
  const applyFilters = () => {
    const q = qDraft.current.trim();
    if (q !== get('q')) setMany({ q, page: '' });
    else load();
  };

  /** 「解除」。検索・絞り込み・赤塗りの指定をすべて外す（並び替えは残す） */
  const clearFilters = () => {
    const next = new URLSearchParams(params);
    for (const k of FILTER_KEYS) next.delete(k);
    next.delete('oldYm');
    next.delete('page');
    qDraft.current = '';
    setParams(next, { replace: true });
  };

  const load = useCallback(() => {
    const qs = queryString();
    qs.set('page', String(page));
    qs.set('size', '50');
    api<DealsRes>(`/deals?${qs}`)
      .then((d) => {
        setData(d);
        // 表示が変わったら選択は引き継がない（見えていない行への一括入力を防ぐ）
        setSel(new Set());
      })
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, [queryString, page]);

  useEffect(load, [load]);

  const exportExcel = () => {
    setMsg(null);
    const limit = meta?.exportMaxRows ?? Infinity;
    if (data && data.totals.count > limit) {
      setMsg({
        kind: 'error',
        text: `対象が${data.totals.count.toLocaleString()}件あります。`
          + `一度に書き出せるのは${limit.toLocaleString()}件までです。`
          + '器具区分・担当者・得意先などで絞り込んでから実行してください',
      });
      return;
    }
    window.location.href = `/api/deals/export?${queryString()}`;
  };

  const startEdit = (d: Deal) => {
    setEditing(d.id);
    setMsg(null);
    setDraft({
      r2_applied_ym: d.r2_applied_ym ?? '',
      // 取込ファイル由来の「○」などの表記ゆれも、選択肢の記号に揃えて出す
      nego_result: normNego(d.nego_result),
      nego_note: d.nego_note ?? '',
      final_date: d.final_date ?? '',
      final_price: d.final_price == null ? '' : String(d.final_price),
      qty: d.qty == null ? '' : String(d.qty),
      // 開発者は取込のズレ（法人名・器種・支店・営業所・出荷単価など）も一覧から直せる
      corp_name: d.corp_name ?? '',
      customer_name: d.customer_name ?? '',
      model_name: d.model_name ?? '',
      equip_name: d.equip_name ?? '',
      branch: d.branch ?? '',
      office: d.office ?? '',
      sales_person: d.sales_person ?? '',
      base_price: d.base_price == null ? '' : String(d.base_price),
      // 目標単価（本社・管理者だけが編集できる）
      r2_target_price: d.r2_target_price == null ? '' : String(d.r2_target_price),
    });
  };

  /**
   * 開発者の取込項目の保存（欄を離れた時点で、変わっていた場合だけ送る）。
   * うっかり触っただけでは書き込まない。
   */
  const saveBase = (d: Deal, key: string) => {
    const v = (draft[key] ?? '').trim();
    const before = (d as unknown as Record<string, unknown>)[key];
    if (v === String(before ?? '')) return;
    patch(d.id, { [key]: v });
  };

  /** 開発者だけに出す、取込項目の入力欄（コンポーネントにすると再描画で焦点が外れるため関数で返す） */
  const baseCell = (d: Deal, k: string, num = false) => (
    <input
      type={num ? 'number' : 'text'} className="cell"
      style={{ minWidth: num ? 90 : 130 }}
      value={draft[k] ?? ''}
      onChange={(e) => setDraft((prev) => ({ ...prev, [k]: e.target.value }))}
      onBlur={() => saveBase(d, k)}
    />
  );

  const patch = async (id: number, body: Record<string, unknown>): Promise<Deal | null> => {
    setBusy(true);
    try {
      const updated = await api<Deal>(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setData((prev) => prev && { ...prev, rows: prev.rows.map((r) => (r.id === id ? { ...r, ...updated } : r)) });
      setMsg(null);
      return updated;
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** 適用年月の保存 */
  const saveRound = async (d: Deal) => {
    const ym = draft.r2_applied_ym?.trim() ?? '';
    if (ym && !YM_RE.test(ym)) {
      setMsg({ kind: 'error', text: '適用年月は「2026-04」の形式で入力してください' });
      return;
    }
    const fp = (draft.final_price ?? '').trim();
    const body: Record<string, unknown> = {
      r2_applied_ym: ym === '' ? null : ym,
      nego_result: draft.nego_result?.trim() || null,
      nego_note: draft.nego_note?.trim() || null,
      final_date: draft.final_date?.trim() || null,
      final_price: fp === '' ? null : Number(fp),
    };
    // 目標単価は本社（と管理者）だけが送る（他の権限が送るとサーバーで拒否される）
    if (isHq) {
      const tp = (draft.r2_target_price ?? '').trim();
      body.r2_target_price = tp === '' ? null : Number(tp);
    }
    const ok = await patch(d.id, body);
    if (ok) setMsg({ kind: 'ok', text: '値上げ交渉の内容を保存しました' });
  };

  // 現状は価格調査の当月実績（単価・数量）。過去最新単価と比べると、
  // 値上げ前からいくら上がったかが分かる。
  const actYm = meta?.actualMeta?.ym ?? '';
  const actLabel = actYm ? `${Number(actYm.slice(5, 7))}月` : '当月';
  /** 当月の実単価（金額÷数量）。見積ぶんが混ざるとマスタ単価より下がる。実績の正 */
  const effPrice = (d: Deal) => d.master_avg_price ?? null;
  /** 当月のマスタ単価（値決めの単価）。A基準はこれと比べる。無い行は実単価で代用 */
  const mPrice = (d: Deal) => d.master_price ?? d.master_avg_price ?? null;
  /** 当月の数量 */
  const monthlyQty = (d: Deal) => (d.master_qty == null ? null : Number(d.master_qty));

  /**
   * 差額を「＋1,000 / +2.5%」の形で出す小さな部品。
   * マイナス（下回っている）は赤で示す。
   */
  const diffCell = (diff: number, base: number | null, tip: string) => {
    const rate = base != null && base > 0 ? Math.round((diff / base) * 1000) / 10 : null;
    return (
      <span style={diff < 0 ? { color: '#c2410c', fontWeight: 700 } : { fontWeight: 700 }} title={tip}>
        {diff === 0 ? '0' : `${diff < 0 ? '−' : '＋'}${yen(Math.abs(diff))}`}
        {rate != null && diff !== 0 && <div className="sub">{rate > 0 ? '+' : ''}{rate}%</div>}
      </span>
    );
  };

  /**
   * 値上げ前（過去最新単価）から当月の実単価までに、実際に上がった幅。
   * どちらかが無い行は出さない（比べる相手が無いため）。
   */
  const actDiff = (d: Deal) => {
    const now = effPrice(d);
    const past = d.past_price;
    if (now == null || past == null) return '—';
    return diffCell(Number(now) - Number(past), Number(past),
      `${actLabel}の実単価 ${yen(now)} − 過去最新単価 ${yen(past)}`
      + (d.past_date ? `（過去最新受注日 ${d.past_date}）` : ''));
  };

  /**
   * 目標値（第2弾新値上げ単価）の値上げ幅。目標 − 当月のマスタ単価。
   * A基準の値上げ幅と同じ土俵で、目標がいくらの値上げにあたるかを添える。
   */
  const targetDiff = (d: Deal) => {
    const price = d.r2_target_price;
    if (price == null || Number(price) <= 0 || mPrice(d) == null) return null;
    const base = Number(mPrice(d));
    const diff = Number(price) - base;
    return (
      <div className="sub"
           style={diff < 0 ? { color: '#c2410c', fontWeight: 700 } : { fontWeight: 700 }}
           title={`目標単価 − ${actLabel}のマスタ単価 ${yen(base)}`}>
        {diff === 0 ? '±0' : `${diff < 0 ? '−' : '＋'}${yen(Math.abs(diff))}`}
      </div>
    );
  };

  /**
   * A基準の1マス。申請単価と、その単価の承認日（マスタ登録の登録日）を重ねて出す。
   * 法人×品目にまとめているため、承認日はそのまとまりで一番新しい日になる。
   * カーソルを合わせると承認日と稟議Noが見える（稟議Noはマスタ登録に列があるときだけ）。
   */
  const aCell = (
    price: number | null | undefined,
    date: string | null | undefined,
    ringi: string | null | undefined,
    note?: string,
  ) => {
    const day = dateLabel(date);
    // 指定した年月より前の登録は、日付を赤くしてどの月の登録が古いのか分かるようにする
    const old = isOldDate(date);
    const tip = [
      note,
      date && `承認日（マスタ登録の登録日）: ${date}`,
      old && `${ymText(oldYm)}より前の登録です`,
      ringi && `稟議No: ${ringi}`,
    ].filter(Boolean).join('\n');
    return (
      <span title={tip || undefined}>
        {/* 0は「未申請」の印なので出さない */}
        {price == null || Number(price) <= 0 ? '—' : yen(price)}
        {day && (
          <div className="sub" style={old ? { color: '#b91c1c', fontWeight: 700 } : undefined}>
            {day}{ringi ? ' ※' : ''}
          </div>
        )}
      </span>
    );
  };

  /**
   * 当月のマスタ単価とA基準との差額。1台あたりの値上げ幅にあたる。
   * 値決めどうしの比較なので、見積ぶんで下がる実単価とは混ぜない。
   * 単価は月ごとに変わるため、当月〜3か月後をそれぞれ出す。
   * マイナス（申請がマスタ単価を下回る）は赤で示す。
   */
  const aDiff = (d: Deal, price: number | null | undefined, label: string) => {
    // 申請単価0は「未申請」の印。値上げ幅としては出さない
    if (price == null || Number(price) <= 0 || mPrice(d) == null) return '—';
    const base = Number(mPrice(d));
    const diff = Number(price) - base;
    if (diff === 0) return '0';
    const rate = base > 0 ? Math.round((diff / base) * 1000) / 10 : null;
    return (
      <span style={diff < 0 ? { color: '#c2410c', fontWeight: 700 } : undefined}
            title={`マスタ登録単価（${label}の申請単価）− ${actLabel}のマスタ単価 ${yen(base)}`}>
        {diff < 0 ? '−' : '＋'}{yen(Math.abs(diff))}
        {rate != null && <div className="sub">{rate > 0 ? '+' : ''}{rate}%</div>}
      </span>
    );
  };

    const pages = data ? Math.max(1, Math.ceil(data.totals.count / data.size)) : 1;
  const offices = meta?.offices.filter((o) => !get('branch') || o.branch === get('branch')) || [];

  // ---- マスタ登録単価のまとまり（実績 → 計画）----
  // 4月〜取込前日の実績（月別履歴）に続けて、当月（本日時点）〜3か月後の計画を並べる。
  // 列が多くなるため5列の窓で見せ、◀▶で実績と計画を行き来する。既定は計画の先頭（当月）
  const histMonths = data?.histMonths ?? meta?.aggMeta?.histMonths ?? [];
  const PLAN_FALLBACK = ['当月', '翌月', '翌々月', '3か月後'] as const;
  const planLabel = (n: 0 | 1 | 2 | 3) => {
    const ym = [meta?.aggMeta?.m0, meta?.aggMeta?.m1, meta?.aggMeta?.m2, meta?.aggMeta?.m3][n];
    return ymLabel(ym, PLAN_FALLBACK[n]);
  };
  const mCols: MonthCol[] = [
    ...histMonths.map((ym) => ({ kind: 'hist' as const, ym })),
    ...([0, 1, 2, 3] as const).map((n) => ({ kind: 'plan' as const, n })),
  ];
  const M_WIN = 5;
  const mMax = Math.max(0, mCols.length - M_WIN);
  const mAt = Math.min(mOff ?? Math.min(histMonths.length, mMax), mMax);
  const visCols = mCols.slice(mAt, mAt + M_WIN);

  /**
   * 翌月（9月計画）を当月（8月計画）で置き換える境目の日。
   * 実績の月（当月の前月）の1日。当月が2026-08なら 2026-07-01。
   * この日より前の登録は、今回の値上げより前の古い申請とみなす。
   */
  const slideFrom = (() => {
    const m0 = meta?.aggMeta?.m0;
    if (!m0 || !/^\d{4}-\d{2}$/.test(m0)) return null;
    const y = Number(m0.slice(0, 4));
    const m = Number(m0.slice(5, 7));
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return `${py}-${String(pm).padStart(2, '0')}-01`;
  })();

  /**
   * 翌月（9月計画）は、承認日が境目の日より前なら当月（8月計画）をそのままスライドして出す。
   * 古い登録のまま翌月の欄に出すと、値上げ後の単価と取り違えるため。
   * 境目の日以降に登録し直されていれば、その内容をそのまま出す。
   */
  const isSlid = (d: Deal) => {
    if (!slideFrom) return false;
    const own = d.a_date_m1 ? String(d.a_date_m1).slice(0, 10) : '';
    return own < slideFrom;   // 未記入（空）も古い扱いにしてスライドする
  };

  /** 計画（当月〜3か月後の申請単価）の1マス。承認日・稟議Noつき */
  const planCell = (d: Deal, n: 0 | 1 | 2 | 3) => {
    // 9月計画がスライドのときは、8月計画の単価・承認日・稟議Noをそのまま出す
    const from = n === 1 && isSlid(d) ? 0 : n;
    return aCell(
      [d.a_price_m0, d.a_price_m1, d.a_price_m2, d.a_price_m3][from],
      [d.a_date_m0, d.a_date_m1, d.a_date_m2, d.a_date_m3][from],
      [d.a_ringi_m0, d.a_ringi_m1, d.a_ringi_m2, d.a_ringi_m3][from],
      n === 1 && from === 0
        ? `${planLabel(1)}計画は${planLabel(0)}計画をそのままスライドしています`
          + `（${planLabel(1)}計画の承認日が ${slideFrom} より前のため）`
        : undefined,
    );
  };

  return (
    // 表を1行でも多く出すため、この画面だけ下の余白をつめる（deals-page）
    <div className="deals-page">
      <h1 className="page-title">
        案件一覧（単価管理）
        <button className="sub-toggle" onClick={toggleSub}
                title="この画面の見方を開きます（閉じておくと表を広く使えます）">
          この画面の見方 {subOpen ? '▲' : '▼'}
        </button>
      </h1>
      <p className="page-sub" style={subOpen ? undefined : { display: 'none' }}>
        <strong>価格調査（毎日更新）の得意先×商品</strong>を常にベースに、価格を比較します。
        <strong>売上高（{actLabel}）</strong>はこのベースへ単価・数量を突合して重なり、
        突合で当たらなかった品目は<strong>{actLabel}実績無し</strong>として載ります（数量の欄に出ます）。
        売上高にだけある行も案件として残るため、売上高の合計は必ずファイルと一致します。
        <strong>マスタ登録単価</strong>は、4月からの<strong>月別実績</strong>（当月は取込前日まで）と、
        当月（本日時点）からの<strong>計画</strong>（申請単価。下段は承認日）を並べます。
        見出しの<strong>◀ 実績／計画 ▶</strong>で表示する月を1か月ずつずらせます（既定は当月の計画から）。
        {slideFrom && (
          <>
            {' '}
            <strong>{planLabel(1)}計画</strong>は、承認日が <strong>{slideFrom}</strong> より前のときは
            今回の値上げより前の古い申請とみなし、<strong>{planLabel(0)}計画をそのままスライド</strong>して出します
            （その2つのマスを<span className="slid-chip" />同じ色にしています）。
            {planLabel(2)}計画・{planLabel(3)}計画は取り込んだとおりです。
          </>
        )}
        隣の<strong>目標単価</strong>は本社が設定します。
        <strong>値上げ幅</strong>は「マスタ登録単価 − {actLabel}のマスタ単価」の差額で、当月から4か月分を並べます。
        {canEdit ? (
          <>
            <strong>商談結果・商談メモ・最終確定日・最終確定単価・適用年月</strong>は「入力」から営業担当者が入れられます。
            商談結果の左のチェックで品目を選ぶと、<strong>入力の項目（商談結果・商談メモ・最終確定日・最終確定単価・適用年月）をまとめて一括入力</strong>できます（空欄の項目は変更されません）。
          </>
        ) : (
          <>
            この画面は<strong>閲覧専用</strong>です。
            <strong>検索・絞り込み・並び替え・ページの移動・Excel出力</strong>はそのままお使いいただけます。
            できないのは内容の入力・変更だけです。
          </>
        )}
      </p>
      {/* 開発者だけの操作。表の下に置くと表が狭くなるため、説明と一緒にまとめる
          （ほかの権限の案内は上の説明に書いてあるので繰り返さない） */}
      {subOpen && isDev && (
        <p className="page-sub" style={{ marginTop: -10 }}>
          開発者のため、「入力」で取込項目
          （法人名・得意先名・器種名・器具区分・支店・営業所・担当者・出荷単価）も直せます。
          変更は入力欄を離れた時点で保存されます。
          コード類・日付など残りの項目は、器種名を押して案件を開き「取込データの修正」から直せます。
        </p>
      )}
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <div className="filters">
        <label className="fld" style={{ minWidth: 260, flex: '1 1 260px' }}>
          検索（含む・空白区切りでAND）
          <SearchBox
            value={get('q')}
            onSearch={(q) => setParam('q', q)}
            onDraft={(q) => { qDraft.current = q; }}
            onPick={(filter, value) => {
              // 候補で絞り込むときは、文字検索は消して条件を入れ替える
              const next = new URLSearchParams(params);
              next.delete('q');
              next.delete('page');
              if (value) next.set(filter, value); else next.delete(filter);
              setParams(next, { replace: true });
            }}
          />
        </label>
        <label className="fld">
          企業名
          <select value={get('corp')} onChange={(e) => setParam('corp', e.target.value)}>
            <option value="">すべて</option>
            {meta?.corps.map((c) => <option key={c.code} value={c.code}>{c.name}（{c.count.toLocaleString()}）</option>)}
          </select>
        </label>
        <label className="fld">
          支店
          <select value={get('branch')} onChange={(e) => setMany({ branch: e.target.value, office: '' })}>
            <option value="">全社</option>
            {meta?.branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </label>
        <label className="fld">
          営業所
          <select value={get('office')} onChange={(e) => setParam('office', e.target.value)}>
            <option value="">すべて</option>
            {offices.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
        </label>
        <label className="fld">
          器具区分
          <select value={get('equip')} onChange={(e) => setParam('equip', e.target.value)}>
            <option value="">すべて</option>
            {meta?.equips.map((x) => <option key={x.name} value={x.name}>{x.name}（{x.count.toLocaleString()}）</option>)}
          </select>
        </label>
        <label className="fld">
          担当者
          <select value={get('person')} onChange={(e) => setParam('person', e.target.value)}>
            <option value="">すべて</option>
            {meta?.persons.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
        <label className="fld">
          マスタ登録単価
          <select value={get('aState')} onChange={(e) => setParam('aState', e.target.value)}>
            <option value="">すべて</option>
            <option value="has">あり（値上げ対象）</option>
            <option value="none">なし</option>
          </select>
        </label>
        {/* 売上高（月次）との突合。ベースにだけあって当たらない品目は実績無し */}
        <label className="fld" title={`ベース（価格調査（毎日更新））へ売上高（${actLabel}）を突合しています。当たらない品目は${actLabel}実績無しです`}>
          売上高（{actLabel}）
          <select value={get('act')} onChange={(e) => setParam('act', e.target.value)}>
            <option value="">すべて</option>
            <option value="has">あり（突合済）</option>
            <option value="none">なし（{actLabel}実績無し）</option>
          </select>
        </label>
        {/*
          承認日での絞り込み。「2026-08以降だけ見る（それより前は値上げ前の単価）」
          という使い方をする。基準は値上げ後の単価にあたる3か月後のA基準の承認日。
        */}
        <label className="fld"
               title={`${ymLabel(meta?.aggMeta?.m3, '3か月後')}のマスタ登録単価の承認日で、値上げ額の合計に入れるものを決めます`
                 + '（案件は全部そのまま出ます。ダッシュボードと同じ決まりです）'}>
          承認日<small style={{ fontWeight: 400 }}>（合計の対象）</small>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="month"
              value={get('aDateYm')}
              onChange={(e) => setParam('aDateYm', e.target.value)}
              style={{ flex: '1 1 auto', minWidth: 0 }}
            />
            <select
              value={get('aDateOp') || 'from'}
              onChange={(e) => setParam('aDateOp', e.target.value === 'from' ? '' : e.target.value)}
              style={{ flex: '0 0 auto' }}
            >
              <option value="from">以降</option>
              <option value="before">より前</option>
            </select>
          </div>
        </label>
        {/*
          古いマスタ登録の色分け。絞り込みではなく色を付けるだけなので、
          全体を見ながら「まだ値上げできていない品目」を拾える。
        */}
        <label className="fld"
               title="ここで指定した年月より前に登録されたきりの単価を、一覧で赤くします（絞り込みはしません）">
          古い登録を赤く表示
          <input
            type="month"
            value={oldYm}
            onChange={(e) => setParam('oldYm', e.target.value)}
          />
        </label>
        {/*
          絞り込みの実行。選ぶたびに一覧は変わるが、検索欄はEnterを押さないと
          反映されないため、押せば必ず今の内容で絞り込めるボタンを置く。
        */}
        <div className="filter-actions">
          <button className="btn sm" onClick={applyFilters}
                  title="いま選んでいる条件で一覧を出し直します（検索欄に打った文字も反映します）">
            絞り込む
          </button>
          <button className="btn secondary sm" onClick={clearFilters} disabled={!hasFilters}
                  title="検索と絞り込みをすべて外します">
            解除
          </button>
        </div>
        <label className="fld">
          売上改善額
          <select value={get('gain')} onChange={(e) => setParam('gain', e.target.value)}
                  title={`過去最新単価と${actLabel}のマスタ単価を比べた向きで絞り込みます`}>
            <option value="">すべて</option>
            <option value="plus">プラス（上がった）</option>
            <option value="minus">マイナス（下がった）</option>
            <option value="same">変わらず</option>
            <option value="none">比較なし（過去単価なし）</option>
          </select>
        </label>
      </div>

      {data && (
        <div className="toolbar">
          <span className="count">
            <b>{data.totals.count.toLocaleString()}</b>件
            {' ・ '}完了 <b>{Number(data.totals.r2_done || 0).toLocaleString()}</b>
            {/* 絞り込んだ全件の値上げ額（1か月あたり）。月ごとに単価が変わるので3つ出す */}
            {/* 売上改善額（過去→当月）。絞り込んだ全件の合計をプラス・マイナスで出す */}
            <span title={`（${actLabel}のマスタ単価 − 過去最新単価）× マスタ分の数量 を、絞り込んだ全件で合計した金額`}>
              {' ・ '}売上改善額{' '}
              {(() => {
                const gp = Math.round(Number(data.totals.gain_plus ?? 0));
                const gm = Math.round(Number(data.totals.gain_minus ?? 0));
                const g = gp + gm;
                return (
                  <>
                    <b className={g < 0 ? 'shortfall' : 'surplus'}>
                      {g < 0 ? '−' : '＋'}{sumYen(Math.abs(g))}
                    </b>
                    {'（＋'}{sumYen(gp)}{' / −'}{sumYen(Math.abs(gm))}{'）'}
                  </>
                );
              })()}
            </span>
            <span title={`値上げ幅（A基準−${actLabel}のマスタ単価）× ${actLabel}の数量 を、絞り込んだ全件で合計した金額`}>
              {' ・ '}値上げ額（月）合計{' '}
              {([['m0', data.totals.raise_m0], ['m1', data.totals.raise_m1],
                 ['m2', data.totals.raise_m2], ['m3', data.totals.raise_m3]] as const)
                .map(([key, v], i) => (
                  <span key={key}>
                    {i > 0 && ' / '}
                    {ymLabel(meta?.aggMeta?.[key], ['当月', '翌月', '翌々月', '3か月後'][i])}{' '}
                    <b className={Number(v ?? 0) < 0 ? 'shortfall' : 'surplus'}>
                      {v == null ? '—' : sumYen(Math.round(Number(v)))}
                    </b>
                  </span>
                ))}
            </span>
          </span>
          <div className="grow" />
          {canEdit && (
            <button className="btn secondary sm" onClick={() => { setBulkOpen((v) => !v); setBulk(null); }}>
              一括取込
            </button>
          )}
          <button className="btn dark sm" style={{ marginLeft: 6 }} onClick={exportExcel}>Excel出力</button>
        </div>
      )}

      {/* 色分けの凡例。件数はいま出しているページの中の数（全件ではない） */}
      {data && oldYm && (
        <p className="pt-note" style={{ marginTop: 0 }}>
          <span className="old-master-chip" />
          マスタ登録日が<strong>{ymText(oldYm)}より前</strong>の行を赤くしています
          （このページ {data.rows.filter(isOldRow).length.toLocaleString()}件 / {data.rows.length.toLocaleString()}件中）。
          マスタ登録日が入っていない品目は色を付けていません。
        </p>
      )}

      {/* 値上げ交渉の一括入力。商談結果の左のチェックで品目を選び、
          入力と同じ項目（商談結果・商談メモ・最終確定日・最終確定単価・適用年月）を
          まとめて入れる。書き入れた項目だけが対象で、空欄の項目は変更しない */}
      {data && canEdit && sel.size > 0 && (
        <div className="toolbar" style={{ flexWrap: 'wrap', rowGap: 8 }}>
          <span className="count">選択 <b>{sel.size.toLocaleString()}</b>件</span>
          <select value={selNego} onChange={(e) => setSelNego(e.target.value)} title="商談結果">
            <option value="">商談結果</option>
            <option value="〇">〇 合意</option>
            <option value="□">□ 広域待ち</option>
            <option value="△">△ 否決</option>
            <option value="×">× 本社へ相談</option>
          </select>
          <input type="text" value={selNote}
            placeholder="商談メモ（商談結果の詳細）"
            style={{ flex: '1 1 200px', minWidth: 160 }}
            onChange={(e) => setSelNote(e.target.value)} />
          <input type="date" value={selFinalDate}
            title="最終確定日" style={{ width: 140 }}
            onChange={(e) => setSelFinalDate(e.target.value)} />
          <input type="number" value={selFinalPrice}
            placeholder="最終確定単価" title="最終確定単価" style={{ width: 120 }}
            onChange={(e) => setSelFinalPrice(e.target.value)} />
          <input type="month" value={selAppliedYm}
            title="適用年月" style={{ width: 140 }}
            onChange={(e) => setSelAppliedYm(e.target.value)} />
          <button className="btn sm"
                  disabled={busy || !sel.size || Object.keys(bulkBody()).length === 0}
                  title="書き入れた項目だけを、選んだ品目すべてに入れます（空欄の項目は変更しません）"
                  onClick={applyBulkNego}>
            選択した品目へ一括入力
          </button>
        </div>
      )}

      {bulkOpen && (
        <div className="card">
          <h3>Excelで一括取込</h3>
          <p className="pt-note" style={{ marginTop: 0 }}>
            「Excel出力」で書き出したファイルに<strong>合意単価・適用年月・完了</strong>を記入して戻します。
            <strong>案件ID</strong>の列で行を突き合わせるため、この列は消さないでください。
            記入しなかった列は変更しません（列ごと削除しておけば触りません）。
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="file" ref={bulkFileRef} accept=".xlsx,.xlsm"
              onChange={() => setBulk(null)} />
            <button className="btn secondary" onClick={() => runBulk(true)} disabled={busy}>
              {busy ? '確認中...' : '内容を確認する'}
            </button>
            <button className="btn" onClick={() => runBulk(false)}
              disabled={busy || !bulk || bulk.dryRun !== true || bulk.updated === 0}>
              取り込む
            </button>
            <button className="btn secondary sm" onClick={() => { setBulkOpen(false); setBulk(null); }}>
              閉じる
            </button>
          </div>

          {bulkProgress && <p className="pt-note">{bulkProgress}</p>}

          {bulk && (
            <div className={`alert ${bulk.errors.length ? 'warn' : bulk.dryRun ? 'info' : 'ok'}`} style={{ marginTop: 12 }}>
              <strong>
                {bulk.dryRun
                  ? `確認結果: ${bulk.updated.toLocaleString()}件が変更されます`
                  : `取り込みました: ${bulk.updated.toLocaleString()}件を更新`}
              </strong>
              <div style={{ marginTop: 6, fontSize: 12 }}>
                変更なし {bulk.unchanged.toLocaleString()}件
                {bulk.notFound > 0 && ` ・ 対象外 ${bulk.notFound.toLocaleString()}件（見える範囲にない案件）`}
                {bulk.skippedRows ? ` ・ 案件IDが読めない行 ${bulk.skippedRows.toLocaleString()}件` : ''}
              </div>
              {bulk.errors.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  入力を直す必要のある行 {bulk.errors.length}件:
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {bulk.errors.slice(0, 10).map((e, i) => (
                      <li key={i}>案件ID {e.id ?? '—'}: {e.message}</li>
                    ))}
                  </ul>
                  {bulk.errors.length > 10 && <div>ほか {bulk.errors.length - 10}件</div>}
                </div>
              )}
              {bulk.dryRun && bulk.updated > 0 && (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  問題なければ「取り込む」を押してください。
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 下へスクロールしても項目名が見えるよう、表の中だけを縦スクロールさせる */}
      {/* スマホは画面が狭く、表の中だけを縦スクロールさせると窮屈になるため、
          項目の固定（＝表の中のスクロール）はPC表示のときだけにする */}
      <HScroll className="card tbl-scroll" fillViewport={!mobile}>
        <table className="tbl deals">
          <thead>
            <tr>
              <th colSpan={5} className="grp">基本情報</th>
              <th colSpan={2} className="grp">規格・区分</th>
              <th className="grp">担当</th>
              <th colSpan={5} className="grp sep"
                  title={`売上高（${actLabel}）の実績。ベース（価格調査（毎日更新））へ単価・数量を突合しています`}>
                売上高<small>（{actLabel}）</small>
              </th>
              <th colSpan={visCols.length + 1} className="grp sep">
                マスタ登録単価（実績→計画・下段は承認日）・目標単価
                {mCols.length > M_WIN && (
                  <span style={{ marginLeft: 8, whiteSpace: 'nowrap' }}
                        title="◀で過去の実績、▶で先の計画へ1か月ずつずらせます">
                    <button className="mnav" disabled={mAt <= 0}
                      onClick={() => setMOff(Math.max(0, mAt - 1))}>◀ 実績</button>
                    <button className="mnav" disabled={mAt >= mMax}
                      onClick={() => setMOff(Math.min(mMax, mAt + 1))}>計画 ▶</button>
                  </span>
                )}
              </th>
              <th colSpan={4} className="grp sep"
                  title={`その月のマスタ登録単価 − ${actLabel}のマスタ単価。値決めどうしの比較です`}>
                値上げ幅（マスタ登録単価−{actLabel}マスタ単価）
              </th>
              {/* 閲覧専用のときは、選択のチェックと「入力」の列を出さないぶん狭くする */}
              <th colSpan={canEdit ? 6 : 5} className="grp sep">
                値上げ交渉{canEdit && '（営業担当者が入力）'}
              </th>
              {canEdit && <th className="grp"></th>}
            </tr>
            <tr>
              <Th col="corp_name" className="fx fx2">企業名</Th>
              <Th col="customer_name" className="fx fx3">得意先名</Th>
              <Th col="delivery_name" className="fx fx4">納入先名</Th>
              <Th col="model_code" className="fx fx5">商品コード</Th>
              <Th col="model_name" className="fx fx6" title="押すと案件の詳細が開けます（マスタ単価の月別実績もここで見られます）">
                器種名
              </Th>
              <Th col="gas_type">ガス種</Th>
              <Th col="equip_name">器具区分</Th>
              <Th col="branch" title="上段: 支店・営業所 ／ 下段: 得意先（営業）担当者。押すと支店で並び替えます">
                支店・営業所<br /><small>担当者</small>
              </Th>
              <Th col="past_price" className="num sep"
                  title="値上げ前の単価。カーソルを合わせると受注日が出ます">
                過去最新単価
              </Th>
              <Th col="hist_avg_price" className="num"
                  title={`${actLabel}の実単価（金額÷数量）`}>
                {actLabel}単価
              </Th>
              <Th col="master_price" className="num"
                  title={`${actLabel}のマスタ単価（値決めの単価）。マスタ登録単価・目標単価の値上げ幅はこれと比べます`}>
                {actLabel}マスタ
              </Th>
              <th className="num" title={`${actLabel}の実単価 − 過去最新単価。実際に上がった幅`}>
                上がり幅<br /><small>過去→{actLabel}</small>
              </th>
              <Th col="hist_qty" className="num"
                  title={`${actLabel}の数量。0は${actLabel}の出荷が無かった品目（出荷無）`}>
                数量
              </Th>
              {visCols.map((c, i) => c.kind === 'hist' ? (
                <th key={c.ym} className={`num${i === 0 ? ' sep' : ''}`}
                    title={c.ym === meta?.aggMeta?.m0
                      ? `${c.ym} のマスタ単価の実績（取り込んだ前日までの値）`
                      : `${c.ym} のマスタ単価の実績`}>
                  {ymLabel(c.ym, c.ym)}実績
                  {c.ym === meta?.aggMeta?.m0 && <><br /><small>前日まで</small></>}
                </th>
              ) : (
                <Th key={`p${c.n}`} col={`a_price_m${c.n}`} className={`num${i === 0 ? ' sep' : ''}`}
                    title={c.n === 0
                      ? '当月の計画（毎日更新のファイルの本日時点の申請単価）'
                      : `${planLabel(c.n)}の計画（申請単価）`}>
                  {planLabel(c.n)}計画
                  {c.n === 0 && <><br /><small>本日時点</small></>}
                </Th>
              ))}
              <Th col="r2_target_price" className="num"
                  title={`目標単価（本社にて設定）。下段は目標の値上げ幅（目標単価 − ${actLabel}のマスタ単価）`}>
                目標単価<br /><small>本社設定</small>
              </Th>
              <th className="num sep">{ymLabel(meta?.aggMeta?.m0, '当月')}</th>
              <th className="num">{ymLabel(meta?.aggMeta?.m1, '翌月')}</th>
              <th className="num">{ymLabel(meta?.aggMeta?.m2, '翌々月')}</th>
              <th className="num">{ymLabel(meta?.aggMeta?.m3, '3か月後')}</th>
              {/* 商談結果の一括入力のための選択。見出しはページ内の全行をまとめて選ぶ */}
              {canEdit && (
                <th className="sep" title="表示中の行をまとめて選ぶ／外す">
                  <input type="checkbox"
                    checked={(data?.rows.length ?? 0) > 0 && (data?.rows ?? []).every((r) => sel.has(r.id))}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setSel(on ? new Set((data?.rows ?? []).map((r) => r.id)) : new Set());
                    }} />
                </th>
              )}
              <Th col="nego_result"
                  title="商談の結果。〇=合意 / □=広域待ち / △=否決 / ×=本社へ相談">
                商談結果
              </Th>
              <th title="商談結果の詳細。品目ごとに残すメモです">商談メモ</th>
              <Th col="final_date" className="num">最終確定日</Th>
              <Th col="final_price" className="num">最終確定単価</Th>
              <Th col="r2_applied_ym" className="num">適用年月</Th>
              {canEdit && <th></th>}
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((d) => {
              const isEditing = editing === d.id;
              return (
                <tr key={d.id}
                    className={[isEditing ? 'editing' : '', isOldRow(d) ? 'old-master' : '']
                      .filter(Boolean).join(' ')}
                    title={isOldRow(d)
                      ? `マスタ登録日 ${newestMasterDate(d)}（${ymText(oldYm)}より前）`
                      : undefined}>
                  <td className="fx fx2" title={[d.corp_name, d.corp_code, d.industry].filter(Boolean).join(' / ')}>
                    {isEditing && isDev ? baseCell(d, 'corp_name') : (
                      <a href={`/corps/${d.corp_code}`}
                         onClick={(e) => { e.preventDefault(); if (d.corp_code) navigate(`/corps/${d.corp_code}`); }}>
                        {d.corp_name || '—'}
                      </a>
                    )}
                  </td>
                  <td className="fx fx3" title={d.customer_name || ''}>
                    {isEditing && isDev ? baseCell(d, 'customer_name') : (d.customer_name || '—')}
                  </td>
                  <td className="fx fx4" title={d.delivery_name || ''}>{d.delivery_name || '—'}</td>
                  <td className="fx fx5" title={d.model_code || ''}>
                    {d.model_code ? <code>{d.model_code}</code> : '—'}
                  </td>
                  <td className="fx fx6" title={[d.model_name, d.product_name].filter(Boolean).join(' / ')}>
                    {isEditing && isDev ? baseCell(d, 'model_name') : (
                      <>
                        {/* 器種名が無い行もどの品目か分かるように、商品名・コードで代用して必ず出す */}
                        <a href={`/deals/${d.id}`} onClick={(e) => { e.preventDefault(); navigate(`/deals/${d.id}`); }}>
                          {d.model_name || d.product_name || d.model_code || '（品目名なし）'}
                        </a>
                      </>
                    )}
                  </td>
                  <td>{d.gas_type || '—'}</td>
                  <td title={d.equip_name || ''}>
                    {isEditing && isDev ? baseCell(d, 'equip_name') : (d.equip_name || '—')}
                  </td>
                  {/* 担当。上段に支店・営業所、下段に得意先（営業）担当者 */}
                  <td title={[d.branch, d.office, d.sales_person].filter(Boolean).join(' / ')}>
                    {isEditing && isDev ? (
                      <>
                        {baseCell(d, 'branch')}
                        {baseCell(d, 'office')}
                        {baseCell(d, 'sales_person')}
                      </>
                    ) : (
                      <>
                        {[d.branch, d.office].filter(Boolean).join('・') || '—'}
                        {/* 担当者名は補足扱いにせず、読みやすいよう通常の大きさ＋太字で出す */}
                        <div style={{ fontWeight: 600 }}>{d.sales_person || '—'}</div>
                      </>
                    )}
                  </td>

                  {/* 実績（価格調査）。過去最新単価 → 当月の実単価と、その上がり幅・数量 */}
                  <td className="num sep"
                      title={d.past_date ? `過去最新受注日 ${d.past_date}` : undefined}>
                    {d.past_price == null ? '—' : yen(d.past_price)}
                    {d.past_date && <div className="sub">{dateLabel(d.past_date)}</div>}
                  </td>
                  <td className="num">{effPrice(d) == null ? '—' : yen(effPrice(d))}</td>
                  {/* 当月のマスタ単価（値決めの単価）。A基準・目標値の値上げ幅の比較のもと */}
                  <td className="num">{d.master_price == null ? '—' : yen(d.master_price)}</td>
                  <td className="num">{actDiff(d)}</td>
                  <td className="num">
                    {monthlyQty(d) == null
                      // ベース（価格調査（毎日更新））にだけあって、売上高と突合で当たらなかった品目
                      ? <span style={{ color: 'var(--muted)' }}
                              title={`ベース（価格調査（毎日更新））にはあるものの、売上高（${actLabel}）に無かった品目です`}>
                          {actLabel}実績無し
                        </span>
                      : Number(monthlyQty(d)) === 0
                        ? <span style={{ color: 'var(--muted)' }} title={`${actLabel}の出荷が無かった品目です`}>出荷無</span>
                        : Number(monthlyQty(d)).toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </td>

                  {/* マスタ登録単価（実績 → 計画）。◀▶で表示中の月が変わる。
                      実績は月別履歴の値、計画は申請単価（下段は承認日）。隣は目標単価 */}
                  {visCols.map((c, i) => c.kind === 'hist' ? (
                    <td key={c.ym} className={`num${i === 0 ? ' sep' : ''}`}>
                      {d.hist_prices?.[c.ym] == null ? '—' : yen(d.hist_prices[c.ym])}
                    </td>
                  ) : (
                    // スライドしたときは、元の8月計画と並べて同じ色にして組が分かるようにする
                    <td key={`p${c.n}`}
                        className={`num${i === 0 ? ' sep' : ''}`
                          + ((c.n === 0 || c.n === 1) && isSlid(d) ? ' slid' : '')}>
                      {planCell(d, c.n)}
                    </td>
                  ))}
                  {/* 目標単価。下段に目標の値上げ幅（目標単価 − 当月のマスタ単価）を添える。
                      本社・管理者は「入力」からここで直接入れられる */}
                  <td className="num">
                    {isEditing && isHq ? (
                      <input type="number" className="cell" value={draft.r2_target_price}
                        placeholder="目標単価"
                        onChange={(e) => setDraft({ ...draft, r2_target_price: e.target.value })} />
                    ) : d.r2_target_price == null ? '—' : (
                      <>
                        {yen(d.r2_target_price)}
                        {targetDiff(d)}
                      </>
                    )}
                  </td>

                  {/* 値上げ幅 = その月のA基準 − 当月のマスタ単価。単価は月ごとに変わる */}
                  {/* 承認日の条件に合わない品目は、幅は出すが合計には入れない（薄く出す） */}
                  <td className={`num sep${inRaise(d) ? '' : ' uncounted'}`}
                      title={inRaise(d) ? undefined : '承認日の条件に合わないため、上の合計には入れていません'}>
                    {aDiff(d, d.a_price_m0, ymLabel(meta?.aggMeta?.m0, '当月'))}
                  </td>
                  {/* 9月は、スライドしたときは8月の単価で幅を出す（表示している単価と合わせる） */}
                  <td className={`num${isSlid(d) ? ' slid' : ''}${inRaise(d) ? '' : ' uncounted'}`}>
                    {aDiff(d, isSlid(d) ? d.a_price_m0 : d.a_price_m1, ymLabel(meta?.aggMeta?.m1, '翌月'))}
                  </td>
                  <td className={`num${inRaise(d) ? '' : ' uncounted'}`}>
                    {aDiff(d, d.a_price_m2, ymLabel(meta?.aggMeta?.m2, '翌々月'))}
                  </td>
                  <td className={`num${inRaise(d) ? '' : ' uncounted'}`}>
                    {aDiff(d, d.a_price_m3, ymLabel(meta?.aggMeta?.m3, '3か月後'))}
                  </td>

                  {/* 値上げ交渉。選択（一括入力用）・商談結果・商談メモ・最終確定日・最終確定単価・適用年月 */}
                  {canEdit && (
                    <td className="sep">
                      <input type="checkbox" checked={sel.has(d.id)} onChange={() => toggleSel(d.id)} />
                    </td>
                  )}
                  <td>
                    {isEditing ? (
                      <select className="cell" value={draft.nego_result}
                        onChange={(e) => setDraft({ ...draft, nego_result: e.target.value })}>
                        <option value="">—</option>
                        <option value="〇">〇 合意</option>
                        <option value="□">□ 広域待ち</option>
                        <option value="△">△ 否決</option>
                        <option value="×">× 本社へ相談</option>
                      </select>
                    ) : (
                      <span className={d.nego_result ? 'nego-mark' : undefined}
                            title={NEGO_LABELS[d.nego_result ?? ''] ?? undefined}>
                        {d.nego_result || '—'}
                      </span>
                    )}
                  </td>
                  {/* 商談メモ（商談結果の詳細）。長い文はカーソルを合わせると全文が読める */}
                  <td title={d.nego_note || undefined}>
                    {isEditing ? (
                      <input type="text" className="cell" value={draft.nego_note}
                        placeholder="商談結果の詳細"
                        style={{ width: 180, textAlign: 'left' }}
                        onChange={(e) => setDraft({ ...draft, nego_note: e.target.value })} />
                    ) : (
                      d.nego_note
                        ? <small style={{ color: 'var(--ink-2)' }}>{d.nego_note}</small>
                        : '—'
                    )}
                  </td>
                  <td className="num">
                    {isEditing ? (
                      <input type="date" className="cell" value={draft.final_date}
                        onChange={(e) => setDraft({ ...draft, final_date: e.target.value })} />
                    ) : (dateLabel(d.final_date) ?? '—')}
                  </td>
                  <td className="num">
                    {isEditing ? (
                      <input type="number" className="cell" value={draft.final_price}
                        onChange={(e) => setDraft({ ...draft, final_price: e.target.value })} />
                    ) : (d.final_price == null ? '—' : yen(d.final_price))}
                  </td>
                  <td className="num">
                    {isEditing ? (
                      <input type="month" className="cell" value={draft.r2_applied_ym}
                        onChange={(e) => setDraft({ ...draft, r2_applied_ym: e.target.value })} />
                    ) : (d.r2_applied_ym || '—')}
                  </td>
                  {canEdit && (
                    <td>
                      <div className="round-actions">
                        {isEditing && (
                          <button className="btn sm" disabled={busy} onClick={() => saveRound(d)}>保存</button>
                        )}
                        <button className="btn secondary sm" onClick={() => (isEditing ? setEditing(null) : startEdit(d))}>
                          {isEditing ? '閉じる' : '入力'}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </HScroll>

      <div className="pagination">
        <button className="btn secondary sm" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>前へ</button>
        <span>{page} / {pages} ページ</span>
        <button className="btn secondary sm" disabled={page >= pages} onClick={() => setParam('page', String(page + 1))}>次へ</button>
      </div>

    </div>
  );
}

export type { RoundState };

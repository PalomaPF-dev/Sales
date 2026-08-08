import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, yen } from '../api';
import type { Deal, Meta, RoundState } from '../types';
import { RoundStateBadge } from '../components/ui';
import SearchBox from '../components/SearchBox';
import HScroll from '../components/HScroll';
import { parseBulkFile, sendBulkUpdate, type BulkResult } from '../bulkUpdateClient';
import { useUser } from '../user';

interface DealsRes {
  rows: Deal[];
  totals: {
    count: number; r2_done: number;
    // 値上げ額（1か月あたり）の合計。翌月・翌々月・3か月後のA基準それぞれ
    raise_m1: number | null; raise_m2: number | null; raise_m3: number | null;
  };
  page: number;
  size: number;
  months: number;   // 出荷実績の対象月数（数量の月平均に使う）
}

const FILTER_KEYS = ['q', 'equip', 'person', 'customer', 'corp', 'branch', 'office',
  'r2State', 'aState', 'aDateYm', 'aDateOp'] as const;

// 並び替えに使うキー。サーバー側の許可リスト（SORTABLE）と揃える
const SORT_KEYS = ['sort', 'dir'] as const;

/** 「2026-04」形式かどうか。保存前に画面側でも確かめる */
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A基準の月の見出し。「2026-09」→「9月」。取込前は仮の名前で出す */
const ymLabel = (ym: string | undefined, fallback: string) =>
  ym && /^\d{4}-\d{2}$/.test(ym) ? `${Number(ym.slice(5, 7))}月` : fallback;

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
  // B基準（実際の決定単価）は同課（営業企画）と管理者が入れる
  const canB = ['planning', 'admin', 'developer'].includes(me.role);

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
      const parsed = await parseBulkFile(file);
      setBulkProgress(`${parsed.rows.length.toLocaleString()}行を${dryRun ? '確認' : '取込'}中...`);
      const res = await sendBulkUpdate(parsed.rows, {
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

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    api<Meta>('/meta').then((m) => {
      setMeta(m);
      // 営業担当者・支店長は自分の支店を初期表示にする（営業企画部・管理者は全社）
      if (!params.get('branch') && me.branch
          && !['planning', 'admin', 'developer'].includes(me.role)) {
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

  const load = useCallback(() => {
    const qs = queryString();
    qs.set('page', String(page));
    qs.set('size', '50');
    api<DealsRes>(`/deals?${qs}`).then(setData).catch((e) => setMsg({ kind: 'error', text: e.message }));
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
      b_price: d.b_price == null ? '' : String(d.b_price),
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
    const ok = await patch(d.id, { r2_applied_ym: ym === '' ? null : ym });
    if (ok) setMsg({ kind: 'ok', text: '適用年月を保存しました' });
  };

  // 出荷実績の対象月数。数量は期間全体の合計なので、割って月平均を出す
  const months = data?.months || 12;
  /** 月平均の数量（期間の合計 ÷ 月数） */
  const monthlyQty = (d: Deal) =>
    (d.hist_qty == null ? null : Number(d.hist_qty) / months);

  /**
   * A基準の1マス。申請単価と、その単価の承認日（マスタ登録の登録日）を重ねて出す。
   * 法人×品目にまとめているため、承認日はそのまとまりで一番新しい日になる。
   * カーソルを合わせると承認日と稟議Noが見える（稟議Noはマスタ登録に列があるときだけ）。
   */
  const aCell = (
    price: number | null | undefined,
    date: string | null | undefined,
    ringi: string | null | undefined,
  ) => {
    const day = dateLabel(date);
    const tip = [
      date && `承認日（マスタ登録の登録日）: ${date}`,
      ringi && `稟議No: ${ringi}`,
    ].filter(Boolean).join('\n');
    return (
      <span title={tip || undefined}>
        {yen(price)}
        {day && <div className="sub">{day}{ringi ? ' ※' : ''}</div>}
      </span>
    );
  };

  /**
   * 出荷単価とA基準との差額。1台あたりの値上げ幅にあたる。
   * 単価は月ごとに変わるため、翌月・翌々月・3か月後をそれぞれ出す。
   * マイナス（申請が出荷単価を下回る）は赤で示す。
   */
  const aDiff = (d: Deal, price: number | null | undefined, label: string) => {
    // マスタ単価0は「未申請」の印。値上げ幅としては出さない
    if (price == null || Number(price) <= 0 || d.hist_avg_price == null) return '—';
    const base = Number(d.hist_avg_price);
    const diff = Number(price) - base;
    if (diff === 0) return '0';
    const rate = base > 0 ? Math.round((diff / base) * 1000) / 10 : null;
    return (
      <span style={diff < 0 ? { color: '#c2410c', fontWeight: 700 } : undefined}
            title={`A基準（${label}の申請単価）− 実績の平均出荷単価`}>
        {diff < 0 ? '−' : '＋'}{yen(Math.abs(diff))}
        {rate != null && <div className="sub">{rate > 0 ? '+' : ''}{rate}%</div>}
      </span>
    );
  };

  /** B基準（決定単価）の保存。欄を離れた時点で、変わっていた場合だけ送る */
  const saveB = async (d: Deal) => {
    const v = (draft.b_price ?? '').trim();
    if (v === (d.b_price == null ? '' : String(d.b_price))) return;
    const ok = await patch(d.id, { b_price: v === '' ? null : Number(v) });
    if (ok) setMsg({ kind: 'ok', text: v === '' ? '決定単価（B基準）を未入力に戻しました' : '決定単価（B基準）を保存しました' });
  };

    const pages = data ? Math.max(1, Math.ceil(data.totals.count / data.size)) : 1;
  const offices = meta?.offices.filter((o) => !get('branch') || o.branch === get('branch')) || [];

  return (
    <div>
      <h1 className="page-title">案件一覧（単価管理）</h1>
      <p className="page-sub">
        <strong>出荷実績の法人×品目</strong>を土台に、価格を比較します。
        実績は期間全体の平均出荷単価と数量（合計と月平均）、A基準はマスタ登録の申請単価（当月と向こう3か月。法人×品目へ数量加重平均で集約）、
        B基準は実際の決定単価（営業企画・管理者が入力）です。
        A基準の下段はその単価の<strong>承認日</strong>（まとまりの中で一番新しい登録日）で、絞り込みにも使えます。
        <strong>値上げ幅</strong>は月ごとに単価が変わるため3か月分を並べ、
        値上げ額（幅×月平均の数量）は絞り込んだ全件の合計を上に出します。
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <div className="filters">
        <label className="fld" style={{ minWidth: 260, flex: '1 1 260px' }}>
          検索（法人・得意先・器種・担当者）
          <SearchBox
            value={get('q')}
            onSearch={(q) => setParam('q', q)}
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
          法人
          <select value={get('corp')} onChange={(e) => setParam('corp', e.target.value)}>
            <option value="">すべて</option>
            {meta?.corps.map((c) => <option key={c.code} value={c.code}>{c.name}（{c.count.toLocaleString()}）</option>)}
          </select>
        </label>
        <label className="fld">
          支店
          <select value={get('branch')} onChange={(e) => { setParam('branch', e.target.value); setParam('office', ''); }}>
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
          A基準
          <select value={get('aState')} onChange={(e) => setParam('aState', e.target.value)}>
            <option value="">すべて</option>
            <option value="has">あり（値上げ対象）</option>
            <option value="none">なし</option>
          </select>
        </label>
        {/*
          承認日での絞り込み。「2026-08以降だけ見る（それより前は値上げ前の単価）」
          という使い方をする。基準は値上げ後の単価にあたる3か月後のA基準の承認日。
        */}
        <label className="fld" title={`${ymLabel(meta?.aggMeta?.m3, '3か月後')}のA基準の承認日で絞り込みます`}>
          承認日
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
        <label className="fld">
          状態
          <select value={get('r2State')} onChange={(e) => setParam('r2State', e.target.value)}>
            <option value="">すべて</option>
            {meta?.states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
      </div>

      {data && (
        <div className="toolbar">
          <span className="count">
            <b>{data.totals.count.toLocaleString()}</b>件
            {' ・ '}完了 <b>{Number(data.totals.r2_done || 0).toLocaleString()}</b>
            {/* 絞り込んだ全件の値上げ額（1か月あたり）。月ごとに単価が変わるので3つ出す */}
            <span title="値上げ幅（A基準−実績の平均単価）× 月平均の数量 を、絞り込んだ全件で合計した金額">
              {' ・ '}値上げ額（月）合計{' '}
              {([['m1', data.totals.raise_m1], ['m2', data.totals.raise_m2], ['m3', data.totals.raise_m3]] as const)
                .map(([key, v], i) => (
                  <span key={key}>
                    {i > 0 && ' / '}
                    {ymLabel(meta?.aggMeta?.[key], ['翌月', '翌々月', '3か月後'][i])}{' '}
                    <b className={Number(v ?? 0) < 0 ? 'shortfall' : 'surplus'}>
                      {v == null ? '—' : `¥${yen(Math.round(Number(v)))}`}
                    </b>
                  </span>
                ))}
            </span>
          </span>
          <div className="grow" />
          <button className="btn secondary sm" onClick={() => { setBulkOpen((v) => !v); setBulk(null); }}>
            一括取込
          </button>
          <button className="btn dark sm" style={{ marginLeft: 6 }} onClick={exportExcel}>Excel出力</button>
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

      <HScroll className="card tbl-scroll">
        <table className="tbl deals">
          <thead>
            <tr>
              <th colSpan={7} className="grp">基本情報</th>
              <th colSpan={2} className="grp sep">
                出荷実績<small>{meta?.histMeta?.period ? `（${meta.histMeta.period}）` : ''}</small>
              </th>
              <th colSpan={4} className="grp sep">A基準（申請単価・数量加重平均／下段は承認日）</th>
              <th className="num grp sep">B基準</th>
              <th colSpan={3} className="grp sep">値上げ幅（A基準−実績）</th>
              <th colSpan={2} className="grp sep">値上げ交渉</th>
              <th className="grp"></th>
            </tr>
            <tr>
              <Th col="corp_name">法人</Th>
              <Th col="customer_name">得意先 / 納入先</Th>
              <Th col="model_name">器種名</Th>
              <Th col="equip_name">器具区分</Th>
              <Th col="branch">支店</Th>
              <Th col="office">営業所</Th>
              <Th col="sales_person">担当者</Th>
              <Th col="hist_avg_price" className="num sep">平均単価</Th>
              <Th col="hist_qty" className="num" title={`期間全体の合計と、1か月あたり（÷${months}か月）`}>
                数量<br /><small>合計 / 月平均</small>
              </Th>
              <Th col="a_price_m0" className="num sep">{ymLabel(meta?.aggMeta?.m0, '当月')}</Th>
              <Th col="a_price_m1" className="num">{ymLabel(meta?.aggMeta?.m1, '翌月')}</Th>
              <Th col="a_price_m2" className="num">{ymLabel(meta?.aggMeta?.m2, '翌々月')}</Th>
              <Th col="a_price_m3" className="num">{ymLabel(meta?.aggMeta?.m3, '3か月後')}</Th>
              <Th col="b_price" className="num sep">決定単価</Th>
              <th className="num sep">{ymLabel(meta?.aggMeta?.m1, '翌月')}</th>
              <th className="num">{ymLabel(meta?.aggMeta?.m2, '翌々月')}</th>
              <th className="num">{ymLabel(meta?.aggMeta?.m3, '3か月後')}</th>
              <Th col="r2_applied_ym" className="num sep">適用年月</Th>
              <Th col="r2_state">状態</Th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((d) => {
              const isEditing = editing === d.id;
              return (
                <tr key={d.id} className={isEditing ? 'editing' : ''}>
                  <td title={d.corp_code || ''}>
                    {isEditing && isDev ? baseCell(d, 'corp_name') : (
                      <a href={`/corps/${d.corp_code}`}
                         onClick={(e) => { e.preventDefault(); if (d.corp_code) navigate(`/corps/${d.corp_code}`); }}>
                        {d.corp_name || '—'}
                      </a>
                    )}
                  </td>
                  <td title={d.delivery_name || ''}>
                    {isEditing && isDev ? baseCell(d, 'customer_name') : (
                      <>
                        {d.customer_name}
                        {d.delivery_name && <><br /><small style={{ color: 'var(--muted)' }}>{d.delivery_name}</small></>}
                      </>
                    )}
                  </td>
                  <td>
                    {isEditing && isDev ? baseCell(d, 'model_name') : (
                      <>
                        <a href={`/deals/${d.id}`} onClick={(e) => { e.preventDefault(); navigate(`/deals/${d.id}`); }}>
                          {d.model_name}
                        </a>
                        {d.gas_type && <><br /><small style={{ color: 'var(--muted)' }}>{d.gas_type}</small></>}
                      </>
                    )}
                  </td>
                  <td>{isEditing && isDev ? baseCell(d, 'equip_name') : d.equip_name}</td>
                  <td>{isEditing && isDev ? baseCell(d, 'branch') : (d.branch || '—')}</td>
                  <td>{isEditing && isDev ? baseCell(d, 'office') : (d.office || '—')}</td>
                  <td>{isEditing && isDev ? baseCell(d, 'sales_person') : (d.sales_person || '—')}</td>

                  {/* 出荷実績（法人×品目）。案件の土台 */}
                  <td className="num sep">{yen(d.hist_avg_price)}</td>
                  <td className="num">
                    {yen(d.hist_qty)}
                    {monthlyQty(d) != null && (
                      <div className="sub" title={`1か月あたり（÷${months}か月）`}>
                        月{Number(monthlyQty(d)).toLocaleString(undefined, { maximumFractionDigits: 1 })}
                      </div>
                    )}
                  </td>

                  {/* A基準（マスタ登録の申請単価: 当月・翌月・翌々月・3か月後）。下段は承認日。
                      カーソルで承認日と稟議Noが見える */}
                  <td className="num sep">{aCell(d.a_price_m0, d.a_date_m0, d.a_ringi_m0)}</td>
                  <td className="num">{aCell(d.a_price_m1, d.a_date_m1, d.a_ringi_m1)}</td>
                  <td className="num">{aCell(d.a_price_m2, d.a_date_m2, d.a_ringi_m2)}</td>
                  <td className="num">{aCell(d.a_price_m3, d.a_date_m3, d.a_ringi_m3)}</td>

                  {/* B基準: 実際の決定単価。同課（営業企画）と管理者が入れる */}
                  <td className="num sep">
                    {isEditing && canB ? (
                      <input type="number" className="cell" value={draft.b_price}
                        onChange={(e) => setDraft({ ...draft, b_price: e.target.value })}
                        onBlur={() => saveB(d)} />
                    ) : yen(d.b_price)}
                  </td>

                  {/* 値上げ幅 = その月のA基準 − 実績の平均出荷単価。単価は月ごとに変わる */}
                  <td className="num sep">{aDiff(d, d.a_price_m1, ymLabel(meta?.aggMeta?.m1, '翌月'))}</td>
                  <td className="num">{aDiff(d, d.a_price_m2, ymLabel(meta?.aggMeta?.m2, '翌々月'))}</td>
                  <td className="num">{aDiff(d, d.a_price_m3, ymLabel(meta?.aggMeta?.m3, '3か月後'))}</td>

                  {/* 値上げ交渉（適用年月・状態） */}
                  <td className="num sep">
                    {isEditing ? (
                      <input type="month" className="cell" value={draft.r2_applied_ym}
                        onChange={(e) => setDraft({ ...draft, r2_applied_ym: e.target.value })} />
                    ) : (d.r2_applied_ym || '—')}
                  </td>
                  <td>
                    {isEditing ? (
                      <div className="round-actions">
                        <button className="btn secondary sm" disabled={busy} onClick={() => saveRound(d)}>保存</button>
                      </div>
                    ) : <RoundStateBadge state={d.r2_state} />}
                  </td>

                  <td>
                    <button className="btn secondary sm" onClick={() => (isEditing ? setEditing(null) : startEdit(d))}>
                      {isEditing ? '閉じる' : '入力'}
                    </button>
                  </td>
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

      {isDev ? (
        <p className="pt-note" style={{ marginTop: 10 }}>
          開発者のため、「入力」で取込項目
          （法人名・得意先名・器種名・器具区分・支店・営業所・担当者・出荷単価）と
          決定単価（B基準）を直せます。変更は入力欄を離れた時点で保存されます。
          コード類・日付など残りの項目は、器種名を押して案件を開き「取込データの修正」から直せます。
        </p>
      ) : canB ? (
        <p className="pt-note" style={{ marginTop: 10 }}>
          「入力」から決定単価（B基準）と適用年月を入れられます（変更は入力欄を離れた時点で保存されます）。
        </p>
      ) : (
        <p className="pt-note" style={{ marginTop: 10 }}>
          決定単価（B基準）の入力は営業企画・管理者が行います。
        </p>
      )}
    </div>
  );
}

export type { RoundState };

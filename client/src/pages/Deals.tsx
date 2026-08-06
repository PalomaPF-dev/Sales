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
  totals: { count: number; r2_done: number };
  page: number;
  size: number;
}

const FILTER_KEYS = ['q', 'equip', 'person', 'customer', 'corp', 'kubun', 'branch', 'office', 'r2State', 'below'] as const;

// 並び替えに使うキー。サーバー側の許可リスト（SORTABLE）と揃える
const SORT_KEYS = ['sort', 'dir'] as const;

/** 基準価格表の区分（サーバーの KUBUNS と揃える） */
const KUBUN_LIST = ['大手', '中規模', '小規模'];

/** 「2026-04」形式かどうか。保存前に画面側でも確かめる */
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A基準の月の見出し。「2026-09」→「9月」。取込前は仮の名前で出す */
const ymLabel = (ym: string | undefined, fallback: string) =>
  ym && /^\d{4}-\d{2}$/.test(ym) ? `${Number(ym.slice(5, 7))}月` : fallback;

/**
 * 合意との差の比較元。設定中の目標があればそれと比べる。
 * まだ目標が無い行は、基準価格表の3区分のうち一番安い値上後単価と比べる
 * （最低限ここまで、の当たりを付けるため）。
 */
function diffBase(d: Deal): { base: number; label: string } | null {
  if (d.r2_target_price != null) {
    return { base: Number(d.r2_target_price), label: '設定中の目標' };
  }
  const t = d.std_targets;
  if (t) {
    const vals = Object.values(t).filter((v) => v != null).map(Number);
    if (vals.length) return { base: Math.min(...vals), label: '基準価格表の一番安い値上後' };
  }
  return null;
}

/**
 * 合意との差を出す対象か。「実際に合意した行」だけ（状態が未入力でない）。
 * 管理表では未交渉の行にも0が入っている。これを含めると、
 * これから交渉する案件が目標額まるごとの不足として並んでしまう。
 */
function hasAgreed(d: Deal): boolean {
  return d.r2_state !== 'open' && d.r2_agreed_price != null && Number(d.r2_agreed_price) > 0;
}

/** 合意が目標に届いていないか（欄の色付けに使う） */
function belowTarget(d: Deal): boolean {
  if (!hasAgreed(d)) return false;
  const b = diffBase(d);
  return b != null && Number(d.r2_agreed_price) < b.base;
}

/**
 * 合意単価と、目標との差の表示。差は金額の横に並べる。
 * 不足は −（赤）、上回りは ＋（緑）。
 *
 * 差の欄は幅を決め打ちにして、差の有無や桁数にかかわらず
 * 合意の金額が同じ位置に並ぶようにする（行ごとに左右へずれないため）。
 */
function AgreedCell({ deal }: { deal: Deal }) {
  const agreed = deal.r2_agreed_price;
  const b = diffBase(deal);
  const diff = hasAgreed(deal) && b != null ? Number(agreed) - b.base : null;
  const show = diff != null && diff !== 0;
  return (
    <span className="agreed-cell">
      <span className="amt">{yen(agreed)}</span>
      <span className={`diff${show ? (diff < 0 ? ' shortfall' : ' surplus') : ''}`}
            title={show ? `${b!.label} ¥${yen(b!.base)} との差です` : undefined}>
        {show ? `${diff < 0 ? '−' : '＋'}${yen(Math.abs(diff))}` : ''}
      </span>
    </span>
  );
}

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
  const isAdmin = me.role === 'admin' || me.role === 'developer';
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
  const Th = ({ col, children, className }: { col: string; children?: React.ReactNode; className?: string }) => {
    const on = get('sort') === col;
    const mark = on ? (get('dir') === 'desc' ? '▼' : '▲') : '';
    return (
      <th className={`${className ?? ''} sortable${on ? ' sorted' : ''}`}
          onClick={() => toggleSort(col)}
          title="押すと並び替えます（昇順→降順→解除）">
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
      r2_agreed_price: d.r2_agreed_price == null ? '' : String(d.r2_agreed_price),
      r2_applied_ym: d.r2_applied_ym ?? '',
      r2_target_price: d.r2_target_price == null ? '' : String(d.r2_target_price),
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

  /** 弾ごとの保存。合意単価と適用年月をまとめて送る */
  const saveRound = async (d: Deal, alsoDone: boolean) => {
    const priceKey = 'r2_agreed_price';
    const ymKey = 'r2_applied_ym';
    const price = draft[priceKey]?.trim() ?? '';
    const ym = draft[ymKey]?.trim() ?? '';
    if (alsoDone && price === '') {
      setMsg({ kind: 'error', text: '完了にするには合意単価を入力してください' });
      return;
    }
    if (ym && !YM_RE.test(ym)) {
      setMsg({ kind: 'error', text: '適用年月は「2026-04」の形式で入力してください' });
      return;
    }
    const body: Record<string, unknown> = {
      [priceKey]: price === '' ? null : Number(price),
      [ymKey]: ym === '' ? null : ym,
    };
    if (alsoDone) body.r2_done = true;
    const ok = await patch(d.id, body);
    if (ok && alsoDone) setMsg({ kind: 'ok', text: '完了にしました' });
  };

  /**
   * 区分の選択。基準価格表の値上後単価が目標として入る。
   * どの区分の得意先かは営業担当者が判断して選ぶ。
   */
  const saveKubun = async (d: Deal, kubun: string) => {
    const updated = await patch(d.id, { kubun });
    if (updated) {
      setMsg(kubun
        ? { kind: 'ok', text: `区分を「${kubun}」にしました。基準価格表の値上後単価が目標に入っています` }
        : { kind: 'ok', text: '区分を外しました（目標も未設定に戻ります）' });
      // 管理者の目標入力欄も、入った値に追随させる
      setDraft((prev) => ({
        ...prev,
        r2_target_price: updated.r2_target_price == null ? '' : String(updated.r2_target_price),
      }));
    }
  };

  const saveTarget = async (d: Deal) => {
    const key = 'r2_target_price';
    const v = draft[key]?.trim() ?? '';
    const ok = await patch(d.id, { [key]: v === '' ? null : Number(v) });
    if (ok) setMsg({ kind: 'ok', text: '目標単価を更新しました' });
  };

  /** B基準（決定単価）の保存。欄を離れた時点で、変わっていた場合だけ送る */
  const saveB = async (d: Deal) => {
    const v = (draft.b_price ?? '').trim();
    if (v === (d.b_price == null ? '' : String(d.b_price))) return;
    const ok = await patch(d.id, { b_price: v === '' ? null : Number(v) });
    if (ok) setMsg({ kind: 'ok', text: v === '' ? '決定単価（B基準）を未入力に戻しました' : '決定単価（B基準）を保存しました' });
  };

  /**
   * 目標の根拠（どの基準に紐づくか・類似か・基準に無いか）。
   * 一覧には出さず、目標の欄にカーソルを合わせたときだけツールチップで示す。
   */
  const stdTitle = (d: Deal) => {
    if (d.std_name) {
      return d.std_kind === 'similar'
        ? `基準価格表の「${d.std_name}」の類似として判別しています`
        : `基準価格表の「${d.std_name}」に一致しています`;
    }
    // null はマスターと照合したうえで該当なし。undefined はマスター未登録
    if (d.std_name === null) return '基準価格表に該当する器種がありません';
    return undefined;
  };

  const pages = data ? Math.max(1, Math.ceil(data.totals.count / data.size)) : 1;
  const offices = meta?.offices.filter((o) => !get('branch') || o.branch === get('branch')) || [];

  return (
    <div>
      <h1 className="page-title">案件一覧（単価管理）</h1>
      <p className="page-sub">
        値上げ結果の集約表（得意先×納入先×商品）を一元管理します。
        A基準は価格申請した向こう3か月の単価、B基準は実際の決定単価（営業企画・管理者が入力）です。
        器種名は基準価格表の品名と自動で突き合わせ、目標（基準価格表）の列に区分ごとの値上後単価を表示します。
        {meta?.aggMeta?.basePeriod && ` 出荷単価❶は ${meta.aggMeta.basePeriod} の実績です。`}
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
          状態
          <select value={get('r2State')} onChange={(e) => setParam('r2State', e.target.value)}>
            <option value="">すべて</option>
            {meta?.states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label className="fld">
          区分
          <select value={get('kubun')} onChange={(e) => setParam('kubun', e.target.value)}>
            <option value="">すべて</option>
            {KUBUN_LIST.map((k) => <option key={k} value={k}>{k}</option>)}
            <option value="none">未選択</option>
          </select>
        </label>
        <label className="fld">
          目標との差
          <select value={get('below')} onChange={(e) => setParam('below', e.target.value)}>
            <option value="">すべて</option>
            <option value="r2">目標未達</option>
          </select>
        </label>
      </div>

      {data && (
        <div className="toolbar">
          <span className="count">
            <b>{data.totals.count.toLocaleString()}</b>件
            {' ・ '}完了 <b>{Number(data.totals.r2_done || 0).toLocaleString()}</b>
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
              <th colSpan={isDev ? 7 : 5} className="grp">基本情報</th>
              <th className="num grp sep">出荷単価❶</th>
              <th className="num grp">数量</th>
              <th colSpan={3} className="grp sep">A基準（申請単価）</th>
              <th className="num grp sep">B基準</th>
              <th colSpan={3} className="grp sep">目標（基準価格表）</th>
              <th colSpan={4} className="grp sep">値上げ交渉</th>
              <th className="grp sep">区分</th>
              <th className="grp"></th>
            </tr>
            <tr>
              <Th col="corp_name">法人</Th>
              <Th col="customer_name">得意先 / 納入先</Th>
              <Th col="model_name">器種名</Th>
              <Th col="equip_name">器具区分</Th>
              {isDev && <Th col="branch">支店</Th>}
              {isDev && <Th col="office">営業所</Th>}
              <Th col="sales_person">担当者</Th>
              <Th col="base_price" className="num sep" />
              <Th col="qty" className="num" />
              <Th col="a_price_m1" className="num sep">{ymLabel(meta?.aggMeta?.m1, '翌月')}</Th>
              <Th col="a_price_m2" className="num">{ymLabel(meta?.aggMeta?.m2, '翌々月')}</Th>
              <Th col="a_price_m3" className="num">{ymLabel(meta?.aggMeta?.m3, '3か月後')}</Th>
              <Th col="b_price" className="num sep">決定単価</Th>
              <th className="num sep">大手</th>
              <th className="num">中規模</th>
              <th className="num">小規模</th>
              <Th col="r2_target_price" className="num sep">設定中の目標</Th>
              <Th col="r2_agreed_price" className="num agreed-h">合意</Th>
              <Th col="r2_applied_ym" className="num">適用年月</Th>
              <Th col="r2_state">状態</Th>
              <Th col="kubun" className="sep" />
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
                  {isDev && <td>{isEditing ? baseCell(d, 'branch') : d.branch}</td>}
                  {isDev && <td>{isEditing ? baseCell(d, 'office') : d.office}</td>}
                  <td>{isEditing && isDev ? baseCell(d, 'sales_person') : d.sales_person}</td>

                  <td className="num sep">
                    {isEditing && isDev ? baseCell(d, 'base_price', true) : yen(d.base_price)}
                  </td>
                  <td className="num">
                    {isEditing && isDev ? baseCell(d, 'qty', true) : yen(d.qty)}
                  </td>

                  {/* A基準（マスタ登録の申請単価: 翌月・翌々月・3か月後） */}
                  <td className="num sep">{yen(d.a_price_m1)}</td>
                  <td className="num">{yen(d.a_price_m2)}</td>
                  <td className="num">{yen(d.a_price_m3)}</td>

                  {/* B基準: 実際の決定単価。同課（営業企画）と管理者が入れる */}
                  <td className="num sep">
                    {isEditing && canB ? (
                      <input type="number" className="cell" value={draft.b_price}
                        onChange={(e) => setDraft({ ...draft, b_price: e.target.value })}
                        onBlur={() => saveB(d)} />
                    ) : yen(d.b_price)}
                  </td>

                  {/* 目標（基準価格表）: 大手・中規模・小規模の3列。選択中の区分は色付き */}
                  {KUBUN_LIST.map((k, i) => {
                    const v = d.std_targets?.[k];
                    return (
                      <td key={k} className={`num${i === 0 ? ' sep' : ''}`} title={stdTitle(d)}>
                        <span className={d.kubun === k ? 'picked' : undefined}
                              style={v == null ? { color: 'var(--muted)' } : undefined}>
                          {v == null ? '—' : yen(v)}
                        </span>
                      </td>
                    );
                  })}

                  {/* 値上げ交渉（設定中の目標・合意・適用年月・状態） */}
                  <td className="num sep">
                    {isEditing && isAdmin ? (
                      <input type="number" className="cell" value={draft.r2_target_price}
                        onChange={(e) => setDraft({ ...draft, r2_target_price: e.target.value })}
                        onBlur={() => saveTarget(d)} />
                    ) : yen(d.r2_target_price)}
                  </td>
                  <td className={`num${belowTarget(d) ? ' below' : ''}`}>
                    {isEditing ? (
                      <input type="number" className="cell" value={draft.r2_agreed_price}
                        onChange={(e) => setDraft({ ...draft, r2_agreed_price: e.target.value })} />
                    ) : <AgreedCell deal={d} />}
                  </td>
                  <td className="num">
                    {isEditing ? (
                      <input type="month" className="cell" value={draft.r2_applied_ym}
                        onChange={(e) => setDraft({ ...draft, r2_applied_ym: e.target.value })} />
                    ) : (d.r2_applied_ym || '—')}
                  </td>
                  <td>
                    {isEditing ? (
                      <div className="round-actions">
                        <button className="btn secondary sm" disabled={busy} onClick={() => saveRound(d, false)}>保存</button>
                        {!d.r2_done && (
                          <button className="btn sm" disabled={busy} onClick={() => saveRound(d, true)}>完了</button>
                        )}
                        {!!d.r2_done && (
                          <button className="btn secondary sm" disabled={busy}
                            onClick={() => patch(d.id, { r2_done: false })}>完了を戻す</button>
                        )}
                      </div>
                    ) : <RoundStateBadge state={d.r2_state} />}
                  </td>

                  {/* 区分（大手・中規模・小規模）。選ぶと基準価格表の値上後単価が目標❷に入る */}
                  <td className="sep">
                    {isEditing ? (
                      <select
                        value={d.kubun ?? ''}
                        disabled={busy}
                        title="得意先の区分。選ぶと基準価格表の値上後単価が目標に入ります"
                        onChange={(e) => saveKubun(d, e.target.value)}
                      >
                        <option value="">選ぶ</option>
                        {KUBUN_LIST.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    ) : (
                      d.kubun
                        ? <strong>{d.kubun}</strong>
                        : <span style={{ color: 'var(--muted)' }}>未選択</span>
                    )}
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
          開発者のため、支店・営業所の列が表示され、「入力」で取込項目
          （法人名・得意先名・器種名・器具区分・支店・営業所・担当者・出荷単価❶）と
          目標単価を直せます。変更は入力欄を離れた時点で保存されます。
          コード類・日付など残りの項目は、器種名を押して案件を開き「取込データの修正」から直せます。
        </p>
      ) : isAdmin ? (
        <p className="pt-note" style={{ marginTop: 10 }}>
          管理者のため、目標単価も「入力」から変更できます（変更は入力欄を離れた時点で保存されます）。
        </p>
      ) : (
        <p className="pt-note" style={{ marginTop: 10 }}>
          目標単価の手入力は管理者のみ行えます（区分の選択はどなたでもできます）。
        </p>
      )}
    </div>
  );
}

export type { RoundState };

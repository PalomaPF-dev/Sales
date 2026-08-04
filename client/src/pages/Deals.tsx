import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, yen } from '../api';
import type { Deal, Meta, RoundState } from '../types';
import { CorpStatusBadge, PriceTypeBadge, RoundStateBadge } from '../components/ui';
import SearchBox from '../components/SearchBox';
import HScroll from '../components/HScroll';
import { parseBulkFile, sendBulkUpdate, type BulkResult } from '../bulkUpdateClient';
import { useUser } from '../user';

interface DealsRes {
  rows: Deal[];
  totals: { count: number; r1_done: number; r2_done: number };
  page: number;
  size: number;
}

const FILTER_KEYS = ['q', 'equip', 'person', 'customer', 'corp', 'priceType', 'branch', 'office', 'r1State', 'r2State', 'below'] as const;

// 並び替えに使うキー。サーバー側の許可リスト（SORTABLE）と揃える
const SORT_KEYS = ['sort', 'dir'] as const;

/** 「2026-04」形式かどうか。保存前に画面側でも確かめる */
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 合意単価が目標に届かなかったか。
 *
 * 対象は「実際に合意した行」だけ（状態が未入力でない）。
 * 管理表では未交渉の行にも値が入っており、第1弾は出荷単価と同額、
 * 第2弾は0が入っている。これを未達に含めると、
 * これから交渉する案件が目標額まるごとの不足として並んでしまう。
 */
function belowTarget(d: Deal, round: 1 | 2): boolean {
  const state = round === 1 ? d.r1_state : d.r2_state;
  if (state === 'open') return false;
  const agreed = round === 1 ? d.r1_agreed_price : d.r2_agreed_price;
  const target = round === 1 ? d.r1_target_price : d.r2_target_price;
  if (agreed == null || target == null) return false;
  if (!(Number(agreed) > 0)) return false;
  return Number(agreed) < Number(target);
}

/**
 * 合意単価と、目標に届かなかった分の表示。
 *
 * 差額を金額と同じ行に置くと、その行だけ金額が左へ押し出されて
 * 列の数字が縦に揃わなくなる。金額は今までどおりの位置に置いたまま、
 * 差額は下の行へ回す。
 */
function AgreedCell({ deal, round }: { deal: Deal; round: 1 | 2 }) {
  const agreed = round === 1 ? deal.r1_agreed_price : deal.r2_agreed_price;
  const target = round === 1 ? deal.r1_target_price : deal.r2_target_price;
  if (!belowTarget(deal, round)) return <>{yen(agreed)}</>;
  const gap = Number(target) - Number(agreed);
  return (
    <>
      <div>{yen(agreed)}</div>
      <div className="shortfall" title={`目標に ¥${yen(gap)} 届いていません（目標 ¥${yen(target)}）`}>
        −{yen(gap)}
      </div>
    </>
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
      if (!params.get('branch') && me.branch && me.role !== 'planning' && me.role !== 'admin') {
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
      r1_agreed_price: d.r1_agreed_price == null ? '' : String(d.r1_agreed_price),
      r1_applied_ym: d.r1_applied_ym ?? '',
      r2_agreed_price: d.r2_agreed_price == null ? '' : String(d.r2_agreed_price),
      r2_applied_ym: d.r2_applied_ym ?? '',
      r1_target_price: d.r1_target_price == null ? '' : String(d.r1_target_price),
      r2_target_price: d.r2_target_price == null ? '' : String(d.r2_target_price),
    });
  };

  const patch = async (id: number, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const updated = await api<Deal>(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setData((prev) => prev && { ...prev, rows: prev.rows.map((r) => (r.id === id ? { ...r, ...updated } : r)) });
      setMsg(null);
      return true;
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** 弾ごとの保存。合意単価と適用年月をまとめて送る */
  const saveRound = async (d: Deal, round: 1 | 2, alsoDone: boolean) => {
    const priceKey = `r${round}_agreed_price`;
    const ymKey = `r${round}_applied_ym`;
    const price = draft[priceKey]?.trim() ?? '';
    const ym = draft[ymKey]?.trim() ?? '';
    if (alsoDone && price === '') {
      setMsg({ kind: 'error', text: `第${round}弾を完了にするには合意単価を入力してください` });
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
    if (alsoDone) body[`r${round}_done`] = true;
    const ok = await patch(d.id, body);
    if (ok && alsoDone) setMsg({ kind: 'ok', text: `第${round}弾を完了にしました` });
  };

  const saveTarget = async (d: Deal, round: 1 | 2) => {
    const key = `r${round}_target_price`;
    const v = draft[key]?.trim() ?? '';
    const ok = await patch(d.id, { [key]: v === '' ? null : Number(v) });
    if (ok) setMsg({ kind: 'ok', text: `第${round}弾の目標単価を更新しました` });
  };

  const pages = data ? Math.max(1, Math.ceil(data.totals.count / data.size)) : 1;
  const offices = meta?.offices.filter((o) => !get('branch') || o.branch === get('branch')) || [];

  return (
    <div>
      <h1 className="page-title">案件一覧（単価管理）</h1>
      <p className="page-sub">
        器種ごとの値上げ単価を一元管理します。第1弾・第2弾それぞれに合意単価と適用年月を入れて、弾ごとに完了にできます。
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
          第1弾
          <select value={get('r1State')} onChange={(e) => setParam('r1State', e.target.value)}>
            <option value="">すべて</option>
            {meta?.states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label className="fld">
          第2弾
          <select value={get('r2State')} onChange={(e) => setParam('r2State', e.target.value)}>
            <option value="">すべて</option>
            {meta?.states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label className="fld">
          単価種別
          <select value={get('priceType')} onChange={(e) => setParam('priceType', e.target.value)}>
            <option value="">すべて</option>
            {meta?.priceTypes.map((p) => <option key={p.code} value={String(p.code)}>{p.code}. {p.name}</option>)}
          </select>
        </label>
        <label className="fld">
          目標との差
          <select value={get('below')} onChange={(e) => setParam('below', e.target.value)}>
            <option value="">すべて</option>
            <option value="any">目標未達（第1弾・第2弾どちらか）</option>
            <option value="r1">第1弾が目標未達</option>
            <option value="r2">第2弾が目標未達</option>
          </select>
        </label>
      </div>

      {data && (
        <div className="toolbar">
          <span className="count">
            <b>{data.totals.count.toLocaleString()}</b>件
            {' ・ '}第1弾 完了 <b>{Number(data.totals.r1_done || 0).toLocaleString()}</b>
            {' ・ '}第2弾 完了 <b>{Number(data.totals.r2_done || 0).toLocaleString()}</b>
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
              <th colSpan={5} className="grp">基本情報</th>
              <th className="grp sep">交渉状況<br /><small>（法人）</small></th>
              <th className="num grp sep">出荷単価❶</th>
              <th colSpan={4} className="grp sep">第1弾</th>
              <th colSpan={4} className="grp sep">第2弾</th>
              <th className="grp sep">単価種別</th>
              <th className="grp"></th>
            </tr>
            <tr>
              <Th col="corp_name">法人</Th>
              <Th col="customer_name">得意先 / 納入先</Th>
              <Th col="model_name">器種名</Th>
              <Th col="equip_name">器具区分</Th>
              <Th col="sales_person">担当者</Th>
              <th className="sep"></th>
              <Th col="base_price" className="num sep" />
              <Th col="r1_target_price" className="num sep">目標❷</Th>
              <Th col="r1_agreed_price" className="num">合意❸</Th>
              <Th col="r1_applied_ym" className="num">適用年月</Th>
              <Th col="r1_state">状態</Th>
              <Th col="r2_target_price" className="num sep">目標❻</Th>
              <Th col="r2_agreed_price" className="num">合意❼</Th>
              <Th col="r2_applied_ym" className="num">適用年月</Th>
              <Th col="r2_state">状態</Th>
              <Th col="price_type_code" className="sep" />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((d) => {
              const pt = meta?.priceTypes.find((p) => p.code === d.price_type_code);
              const isEditing = editing === d.id;
              return (
                <tr key={d.id} className={isEditing ? 'editing' : ''}>
                  <td title={d.corp_code || ''}>
                    <a href={`/corps/${d.corp_code}`}
                       onClick={(e) => { e.preventDefault(); if (d.corp_code) navigate(`/corps/${d.corp_code}`); }}>
                      {d.corp_name || '—'}
                    </a>
                  </td>
                  <td title={d.delivery_name || ''}>
                    {d.customer_name}
                    {d.delivery_name && <><br /><small style={{ color: 'var(--muted)' }}>{d.delivery_name}</small></>}
                  </td>
                  <td>
                    <a href={`/deals/${d.id}`} onClick={(e) => { e.preventDefault(); navigate(`/deals/${d.id}`); }}>
                      {d.model_name}
                    </a>
                    {d.gas_type && <><br /><small style={{ color: 'var(--muted)' }}>{d.gas_type}</small></>}
                  </td>
                  <td>{d.equip_name}</td>
                  <td>{d.sales_person}</td>

                  <td className="sep">
                    <CorpStatusBadge status={d.corp_status} />
                    {d.corp_contact_date && (
                      <><br /><small style={{ color: 'var(--muted)' }}>{String(d.corp_contact_date).slice(0, 10)}</small></>
                    )}
                  </td>

                  <td className="num sep">{yen(d.base_price)}</td>

                  {/* 第1弾 */}
                  <td className="num sep">
                    {isEditing && isAdmin ? (
                      <input type="number" className="cell" value={draft.r1_target_price}
                        onChange={(e) => setDraft({ ...draft, r1_target_price: e.target.value })}
                        onBlur={() => saveTarget(d, 1)} />
                    ) : yen(d.r1_target_price)}
                  </td>
                  <td className={`num${belowTarget(d, 1) ? ' below' : ''}`}>
                    {isEditing ? (
                      <input type="number" className="cell" value={draft.r1_agreed_price}
                        onChange={(e) => setDraft({ ...draft, r1_agreed_price: e.target.value })} />
                    ) : <AgreedCell deal={d} round={1} />}
                  </td>
                  <td className="num">
                    {isEditing ? (
                      <input type="month" className="cell" value={draft.r1_applied_ym}
                        onChange={(e) => setDraft({ ...draft, r1_applied_ym: e.target.value })} />
                    ) : (d.r1_applied_ym || '—')}
                  </td>
                  <td>
                    {isEditing ? (
                      <div className="round-actions">
                        <button className="btn secondary sm" disabled={busy} onClick={() => saveRound(d, 1, false)}>保存</button>
                        {!d.r1_done && (
                          <button className="btn sm" disabled={busy} onClick={() => saveRound(d, 1, true)}>完了</button>
                        )}
                        {!!d.r1_done && (
                          <button className="btn secondary sm" disabled={busy}
                            onClick={() => patch(d.id, { r1_done: false })}>完了を戻す</button>
                        )}
                      </div>
                    ) : <RoundStateBadge state={d.r1_state} />}
                  </td>

                  {/* 第2弾 */}
                  <td className="num sep">
                    {isEditing && isAdmin ? (
                      <input type="number" className="cell" value={draft.r2_target_price}
                        onChange={(e) => setDraft({ ...draft, r2_target_price: e.target.value })}
                        onBlur={() => saveTarget(d, 2)} />
                    ) : yen(d.r2_target_price)}
                  </td>
                  <td className={`num${belowTarget(d, 2) ? ' below' : ''}`}>
                    {isEditing ? (
                      <input type="number" className="cell" value={draft.r2_agreed_price}
                        onChange={(e) => setDraft({ ...draft, r2_agreed_price: e.target.value })} />
                    ) : <AgreedCell deal={d} round={2} />}
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
                        <button className="btn secondary sm" disabled={busy} onClick={() => saveRound(d, 2, false)}>保存</button>
                        {!d.r2_done && (
                          <button className="btn sm" disabled={busy} onClick={() => saveRound(d, 2, true)}>完了</button>
                        )}
                        {!!d.r2_done && (
                          <button className="btn secondary sm" disabled={busy}
                            onClick={() => patch(d.id, { r2_done: false })}>完了を戻す</button>
                        )}
                      </div>
                    ) : <RoundStateBadge state={d.r2_state} />}
                  </td>

                  <td className="sep">
                    {isEditing ? (
                      <select value={d.price_type_code ?? ''}
                        onChange={(e) => patch(d.id, { price_type_code: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">未設定</option>
                        {meta?.priceTypes.map((p) => <option key={p.code} value={String(p.code)}>{p.code}. {p.name}</option>)}
                      </select>
                    ) : <PriceTypeBadge code={d.price_type_code} name={pt?.name} category={pt?.category} />}
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

      {isAdmin ? (
        <p className="pt-note" style={{ marginTop: 10 }}>
          管理者のため、目標単価❷❻も「入力」から変更できます（変更は入力欄を離れた時点で保存されます）。
        </p>
      ) : (
        <p className="pt-note" style={{ marginTop: 10 }}>
          目標単価❷❻の変更は管理者のみ行えます。
        </p>
      )}
    </div>
  );
}

export type { RoundState };

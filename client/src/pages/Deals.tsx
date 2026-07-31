import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, yen } from '../api';
import type { Deal, Meta } from '../types';
import { DealStatusBadge, PriceTypeBadge } from '../components/ui';
import { useUser } from '../user';
import BulkApplyDialog from '../components/BulkApplyDialog';
import DealSummary from '../components/DealSummary';
import { NegotiationStage } from '../components/ui';

interface DealsRes {
  rows: Deal[];
  totals: { count: number; r1_amount: number; r2_amount: number; r1_target: number; r2_target: number };
  page: number;
  size: number;
}

const FILTER_KEYS = ['q', 'equip', 'status', 'person', 'priceType', 'customer', 'branch', 'office'] as const;

export default function Deals() {
  const [params, setParams] = useSearchParams();
  const me = useUser();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [data, setData] = useState<DealsRes | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [bulkRound, setBulkRound] = useState<1 | 2 | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [showSummary, setShowSummary] = useState(true);
  const navigate = useNavigate();

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
      // 営業担当者・支店長は自分の支店を初期表示にする（営業企画部は全社）
      if (!params.get('branch') && me.branch && me.role !== 'planning' && me.role !== 'admin') {
        if (m.branches.some((b) => b.name === me.branch)) setParam('branch', me.branch);
      }
    }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, []);

  const queryString = useCallback(() => {
    const qs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (get(k)) qs.set(k, get(k));
    return qs;
  }, [params]);

  const load = useCallback(() => {
    const qs = queryString();
    qs.set('page', String(page));
    qs.set('size', '50');
    api<DealsRes>(`/deals?${qs}`).then(setData).catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, [queryString, page]);

  useEffect(load, [load]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startApplication = (round: 1 | 2) => {
    const deals = data?.rows.filter((d) => selected.has(d.id)) || [];
    if (new Set(deals.map((d) => d.customer_code)).size > 1) {
      setMsg({ kind: 'error', text: '申請は同一の得意先単位で作成してください（選択中の得意先が複数あります）' });
      return;
    }
    navigate('/applications/new', { state: { dealIds: [...selected], round } });
  };

  // 件数はこの画面が既に持っているため、超過は事前に判定してから遷移する。
  // ダウンロード自体はサーバーへ直接遷移させ、ファイル名は Content-Disposition に任せる
  // （blob経由だと環境によって日本語ファイル名が落ちるため）。
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

  // 一覧上での直接編集（詳細画面に遷移せずに更新する）
  const saveInline = async (id: number, patch: Partial<Deal>) => {
    try {
      const updated = await api<Deal>(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setData((prev) => prev && { ...prev, rows: prev.rows.map((r) => (r.id === id ? updated : r)) });
      setEditing(null);
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.totals.count / data.size)) : 1;
  const offices = meta?.offices.filter((o) => !get('branch') || o.branch === get('branch')) || [];

  return (
    <div>
      <h1 className="page-title">案件一覧</h1>
      <p className="page-sub">全器具の交渉状況を一元管理。明細を選択して申請、または得意先ごとにまとめて申請できます。</p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <div className="filters">
        <label className="fld">
          検索（得意先・器種など）
          <input type="text" defaultValue={get('q')} placeholder="例: 東京ガス / FH-1613"
            onKeyDown={(e) => e.key === 'Enter' && setParam('q', (e.target as HTMLInputElement).value)} />
        </label>
        <label className="fld">
          支店
          <select value={get('branch')} onChange={(e) => { setParam('branch', e.target.value); setParam('office', ''); }}>
            <option value="">全社</option>
            {meta?.branches.map((b) => <option key={b.name} value={b.name}>{b.name}（{b.count.toLocaleString()}）</option>)}
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
          ステータス
          <select value={get('status')} onChange={(e) => setParam('status', e.target.value)}>
            <option value="">すべて</option>
            {meta?.statuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
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
          単価種別
          <select value={get('priceType')} onChange={(e) => setParam('priceType', e.target.value)}>
            <option value="">すべて</option>
            {meta?.priceTypes.map((p) => <option key={p.code} value={String(p.code)}>{p.code}. {p.name}</option>)}
          </select>
        </label>
      </div>

      {data && (
        <div className="toolbar">
          <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>
            {data.totals.count.toLocaleString()}件 ・ 第1弾 ¥{yen(data.totals.r1_amount)} ・ 第2弾 ¥{yen(data.totals.r2_amount)}
          </span>
          <div className="grow" />
          <button className="btn secondary sm" onClick={() => setShowSummary((v) => !v)}>
            {showSummary ? '集計を隠す' : '集計を表示'}
          </button>
          <button className="btn secondary sm" onClick={exportExcel}>Excel出力</button>
          <button className="btn secondary sm" onClick={() => setBulkRound(1)}>得意先一括申請（第1弾）</button>
          <button className="btn secondary sm" onClick={() => setBulkRound(2)}>得意先一括申請（第2弾）</button>
          {selected.size > 0 && (
            <>
              <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{selected.size}件選択</span>
              <button className="btn sm" onClick={() => startApplication(1)}>第1弾 申請</button>
              <button className="btn sm" onClick={() => startApplication(2)}>第2弾 申請</button>
            </>
          )}
        </div>
      )}

      {showSummary && <DealSummary query={queryString()} />}

      <div className="card tbl-scroll" style={{ padding: 0 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th></th>
              <th>売上年月</th>
              <th>得意先</th>
              <th>器種名</th>
              <th>器具区分</th>
              <th className="num">台数</th>
              <th className="num">出荷単価❶</th>
              <th className="num">目標単価❷</th>
              <th style={{ minWidth: 150 }}>交渉状況</th>
              <th className="num">値上後単価❸</th>
              <th className="num">値上金額❺</th>
              <th className="num">第2弾目標❻</th>
              <th className="num">最終単価❼</th>
              <th className="num">値上金額❾</th>
              <th>単価種別</th>
              <th>ステータス</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((d) => {
              const pt = meta?.priceTypes.find((p) => p.code === d.price_type_code);
              const isEditing = editing === d.id;
              return (
                <tr key={d.id} className={isEditing ? '' : 'clickable'}
                    onClick={() => !isEditing && navigate(`/deals/${d.id}`)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                  </td>
                  <td>{d.sales_ym}</td>
                  <td title={d.delivery_name || ''}>{d.customer_name}</td>
                  <td>{d.model_name}</td>
                  <td>{d.equip_name}</td>
                  <td className="num">{d.qty}</td>
                  <td className="num">{yen(d.base_price)}</td>
                  <td className="num">{yen(d.r1_target_price)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <NegotiationStage deal={d} />
                  </td>
                  <td className="num">{yen(d.r1_agreed_price)}</td>
                  <td className="num">{yen(d.r1_raise_amount)}</td>
                  <td className="num">{yen(d.r2_target_price)}</td>
                  <td className="num">{d.r2_agreed_price ? yen(d.r2_agreed_price) : '—'}</td>
                  <td className="num">{yen(d.r2_raise_amount)}</td>
                  <td onClick={(e) => isEditing && e.stopPropagation()}>
                    {isEditing ? (
                      <select defaultValue={d.price_type_code ?? ''}
                        onChange={(e) => saveInline(d.id, { price_type_code: e.target.value ? Number(e.target.value) : null } as Partial<Deal>)}>
                        <option value="">未設定</option>
                        {meta?.priceTypes.map((p) => <option key={p.code} value={String(p.code)}>{p.code}. {p.name}</option>)}
                      </select>
                    ) : (
                      <PriceTypeBadge code={d.price_type_code} name={pt?.name} category={pt?.category} />
                    )}
                  </td>
                  <td onClick={(e) => isEditing && e.stopPropagation()}>
                    {isEditing ? (
                      <select defaultValue={d.status}
                        onChange={(e) => saveInline(d.id, { status: e.target.value } as Partial<Deal>)}>
                        {meta?.statuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                      </select>
                    ) : (
                      <DealStatusBadge status={d.status} />
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn secondary sm"
                      onClick={() => setEditing(isEditing ? null : d.id)}>
                      {isEditing ? '完了' : '編集'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <button className="btn secondary sm" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>前へ</button>
        <span>{page} / {pages} ページ</span>
        <button className="btn secondary sm" disabled={page >= pages} onClick={() => setParam('page', String(page + 1))}>次へ</button>
      </div>

      {bulkRound && meta && (
        <BulkApplyDialog
          round={bulkRound}
          meta={meta}
          defaults={{ customer: get('customer'), equip: get('equip'), branch: get('branch'), office: get('office') }}
          onClose={() => setBulkRound(null)}
          onCreated={(id) => navigate(`/applications/${id}`)}
        />
      )}
    </div>
  );
}

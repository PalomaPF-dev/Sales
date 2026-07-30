import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, yen } from '../api';
import type { Deal, Meta } from '../types';
import { DealStatusBadge, PriceTypeBadge } from '../components/ui';

interface DealsRes {
  rows: Deal[];
  totals: { count: number; r1_amount: number; r2_amount: number; r1_target: number; r2_target: number };
  page: number;
  size: number;
}

export default function Deals() {
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [data, setData] = useState<DealsRes | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const q = params.get('q') || '';
  const equip = params.get('equip') || '';
  const status = params.get('status') || '';
  const person = params.get('person') || '';
  const priceType = params.get('priceType') || '';
  const customer = params.get('customer') || '';
  const page = Number(params.get('page') || 1);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch((e) => setError(e.message));
  }, []);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    for (const [k, v] of [['q', q], ['equip', equip], ['status', status], ['person', person], ['priceType', priceType], ['customer', customer]]) {
      if (v) qs.set(k, v);
    }
    qs.set('page', String(page));
    qs.set('size', '50');
    api<DealsRes>(`/deals?${qs}`).then(setData).catch((e) => setError(e.message));
  }, [q, equip, status, person, priceType, customer, page]);

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
    const ids = [...selected];
    const deals = data?.rows.filter((d) => selected.has(d.id)) || [];
    const customers = new Set(deals.map((d) => d.customer_code));
    if (customers.size > 1) {
      setError('申請は同一の得意先単位で作成してください（選択中の得意先が複数あります）');
      return;
    }
    navigate('/applications/new', { state: { dealIds: ids, round } });
  };

  const pages = data ? Math.max(1, Math.ceil(data.totals.count / data.size)) : 1;

  return (
    <div>
      <h1 className="page-title">案件一覧</h1>
      <p className="page-sub">全器具の交渉状況を一元管理。明細を選択して合意価格の申請を作成できます。</p>
      {error && <div className="alert error" onClick={() => setError('')}>{error}</div>}

      <div className="filters">
        <label className="fld">
          検索（得意先・器種など）
          <input type="text" defaultValue={q} placeholder="例: 東京ガス / FH-1613"
            onKeyDown={(e) => e.key === 'Enter' && setParam('q', (e.target as HTMLInputElement).value)} />
        </label>
        <label className="fld">
          器具区分
          <select value={equip} onChange={(e) => setParam('equip', e.target.value)}>
            <option value="">すべて</option>
            {meta?.equips.map((x) => <option key={x.name} value={x.name}>{x.name}（{x.count.toLocaleString()}）</option>)}
          </select>
        </label>
        <label className="fld">
          ステータス
          <select value={status} onChange={(e) => setParam('status', e.target.value)}>
            <option value="">すべて</option>
            {meta?.statuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label className="fld">
          担当者
          <select value={person} onChange={(e) => setParam('person', e.target.value)}>
            <option value="">すべて</option>
            {meta?.persons.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
        <label className="fld">
          単価種別
          <select value={priceType} onChange={(e) => setParam('priceType', e.target.value)}>
            <option value="">すべて</option>
            {meta?.priceTypes.map((p) => <option key={p.code} value={String(p.code)}>{p.code}. {p.name}（{p.category}）</option>)}
          </select>
        </label>
      </div>

      {data && (
        <div className="toolbar">
          <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>
            {data.totals.count.toLocaleString()}件 ・ 第1弾値上金額 ¥{yen(data.totals.r1_amount)} ・ 第2弾値上金額 ¥{yen(data.totals.r2_amount)}
          </span>
          <div className="grow" />
          <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{selected.size}件 選択中</span>
          <button className="btn sm" disabled={selected.size === 0} onClick={() => startApplication(1)}>第1弾 申請作成</button>
          <button className="btn sm" disabled={selected.size === 0} onClick={() => startApplication(2)}>第2弾 申請作成</button>
        </div>
      )}

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
              <th className="num">値上後単価❸</th>
              <th className="num">値上金額❺</th>
              <th className="num">第2弾目標❻</th>
              <th className="num">最終単価❼</th>
              <th className="num">値上金額❾</th>
              <th>単価種別</th>
              <th>ステータス</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((d) => {
              const pt = mapPriceType(meta, d.price_type_code);
              return (
                <tr key={d.id} className="clickable" onClick={() => navigate(`/deals/${d.id}`)}>
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
                  <td className="num">{yen(d.r1_agreed_price)}</td>
                  <td className="num">{yen(d.r1_raise_amount)}</td>
                  <td className="num">{yen(d.r2_target_price)}</td>
                  <td className="num">{d.r2_agreed_price ? yen(d.r2_agreed_price) : '—'}</td>
                  <td className="num">{yen(d.r2_raise_amount)}</td>
                  <td><PriceTypeBadge code={d.price_type_code} name={pt?.name} category={pt?.category} /></td>
                  <td><DealStatusBadge status={d.status} /></td>
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
    </div>
  );
}

function mapPriceType(meta: Meta | null, code: number | null) {
  return meta?.priceTypes.find((p) => p.code === code);
}

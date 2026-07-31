import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, yen } from '../api';
import { Card, CorpStatusBadge, PriceTypeBadge, RoundStateBadge } from '../components/ui';
import Attachments from '../components/Attachments';
import type { CorpNegotiation, Deal, Meta } from '../types';

interface DealRes {
  deal: Deal;
  negotiation: CorpNegotiation | null;
}

export default function DealDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<DealRes | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [msg, setMsg] = useState('');

  const load = () => {
    api<DealRes>(`/deals/${id}`).then(setData).catch((e) => setMsg(e.message));
  };
  useEffect(() => {
    load();
    api<Meta>('/meta').then(setMeta).catch(() => {});
  }, [id]);

  if (!data) {
    return <div>{msg ? <div className="alert error">{msg}</div> : <p style={{ color: 'var(--muted)' }}>読み込み中...</p>}</div>;
  }

  const d = data.deal;
  const pt = meta?.priceTypes.find((p) => p.code === d.price_type_code);

  return (
    <div>
      <a href="/deals" onClick={(e) => { e.preventDefault(); navigate('/deals'); }}>← 案件一覧へ戻る</a>
      <h1 className="page-title" style={{ marginTop: 8 }}>{d.customer_name} ／ {d.model_name}</h1>
      <p className="page-sub">
        {d.equip_name} ・ {d.gas_type} ・ 売上年月 {d.sales_ym} ・ 担当 {d.sales_person}
      </p>
      {msg && <div className="alert error" onClick={() => setMsg('')}>{msg}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        <Card title="基本情報">
          <dl className="kv">
            <dt>法人</dt>
            <dd>
              {d.corp_code ? (
                <a href={`/corps/${d.corp_code}`}
                   onClick={(e) => { e.preventDefault(); navigate(`/corps/${d.corp_code}`); }}>
                  {d.corp_name}
                </a>
              ) : (d.corp_name || '—')}
            </dd>
            <dt>得意先</dt><dd>{d.customer_name}（{d.customer_code}）</dd>
            <dt>納入先</dt><dd>{d.delivery_name || '—'}</dd>
            <dt>扱い先</dt><dd>{d.handler_name || '—'}</dd>
            <dt>業種</dt><dd>{d.industry || '—'}</dd>
            <dt>器具区分</dt><dd>{d.equip_name || '—'}</dd>
            <dt>カテゴリー</dt><dd>{d.category_name || '—'}</dd>
            <dt>器種名</dt><dd>{d.model_name}（{d.gas_type}）</dd>
            <dt>定価</dt><dd>¥{yen(d.list_price)}{d.rate != null && `（掛け率 ${(Number(d.rate) * 100).toFixed(1)}%）`}</dd>
            <dt>支店 / 営業所</dt><dd>{[d.branch, d.office].filter(Boolean).join(' / ') || '—'}</dd>
            <dt>売上伝票NO</dt><dd>{d.voucher_no || '—'}</dd>
            <dt>見積伝票番号</dt><dd>{d.quote_no || '—'}</dd>
            <dt>単価種別</dt>
            <dd><PriceTypeBadge code={d.price_type_code} name={pt?.name} category={pt?.category} /></dd>
          </dl>
        </Card>

        <Card title="値上げ状況">
          <dl className="kv">
            <dt>出荷単価 ❶</dt><dd>¥{yen(d.base_price)}</dd>
          </dl>

          <div className="section-title">第1弾 <RoundStateBadge state={d.r1_state} /></div>
          <dl className="kv">
            <dt>目標値上げ単価 ❷</dt><dd>¥{yen(d.r1_target_price)}</dd>
            <dt>合意単価 ❸</dt><dd>{d.r1_agreed_price == null ? '—' : `¥${yen(d.r1_agreed_price)}`}</dd>
            <dt>値上がり単価 ❹</dt>
            <dd>{d.r1_raise_unit == null ? '—' : `¥${yen(d.r1_raise_unit)}`}</dd>
            <dt>適用年月</dt><dd>{d.r1_applied_ym || '—'}</dd>
          </dl>

          <div className="section-title">第2弾 <RoundStateBadge state={d.r2_state} /></div>
          <dl className="kv">
            <dt>目標値上げ単価 ❻</dt><dd>¥{yen(d.r2_target_price)}</dd>
            <dt>合意単価 ❼</dt><dd>{d.r2_agreed_price == null ? '—' : `¥${yen(d.r2_agreed_price)}`}</dd>
            <dt>値上がり単価 ❽</dt>
            <dd>{d.r2_raise_unit == null ? '—' : `¥${yen(d.r2_raise_unit)}`}</dd>
            <dt>適用年月</dt><dd>{d.r2_applied_ym || '—'}</dd>
          </dl>

          <p className="pt-note" style={{ marginTop: 12 }}>
            合意単価・適用年月・完了の入力は<a href="/deals" onClick={(e) => { e.preventDefault(); navigate('/deals'); }}>案件一覧</a>から行います。
          </p>
        </Card>
      </div>

      <Card title="交渉状況（法人単位）">
        <p style={{ margin: 0, fontSize: 13 }}>
          <CorpStatusBadge status={data.negotiation?.status} />
          {data.negotiation?.contact_date && (
            <span style={{ marginLeft: 8, color: 'var(--ink-2)' }}>
              直近商談日 {String(data.negotiation.contact_date).slice(0, 10)}
            </span>
          )}
        </p>
        {data.negotiation?.note && <p className="pt-note" style={{ marginTop: 6 }}>{data.negotiation.note}</p>}
        <p className="pt-note" style={{ marginTop: 10 }}>
          交渉情報と履歴は法人ごとに記録します。
          {d.corp_code && (
            <>
              {' '}
              <a href={`/corps/${d.corp_code}`}
                 onClick={(e) => { e.preventDefault(); navigate(`/corps/${d.corp_code}`); }}>
                {d.corp_name} の交渉情報を開く
              </a>
            </>
          )}
        </p>
      </Card>

      <Attachments dealId={d.id} />
    </div>
  );
}

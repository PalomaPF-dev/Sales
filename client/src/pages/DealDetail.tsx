import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, yen, pct } from '../api';
import type { Deal, Meta } from '../types';
import { useUser } from '../user';
import { AppStatusBadge, Card, DealStatusBadge } from '../components/ui';
import NegotiationLog from '../components/NegotiationLog';
import Attachments from '../components/Attachments';

interface DealRes {
  deal: Deal;
  applications: { id: number; round: number; status: string; achievement_rate: number | null; created_at: string; agreed_price: number }[];
}

export default function DealDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<DealRes | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [form, setForm] = useState({ status: '', negotiation_note: '', negotiated_date: '', price_type_code: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const user = useUser();

  useEffect(() => {
    api<Meta>('/meta').then(setMeta);
    api<DealRes>(`/deals/${id}`).then((r) => {
      setData(r);
      setForm({
        status: r.deal.status,
        negotiation_note: r.deal.negotiation_note || '',
        negotiated_date: r.deal.negotiated_date || '',
        price_type_code: r.deal.price_type_code ? String(r.deal.price_type_code) : '',
      });
    }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, [id]);

  if (!data) return <p>読み込み中...</p>;
  const d = data.deal;

  const save = async () => {
    try {
      const updated = await api<Deal>(`/deals/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: form.status,
          negotiation_note: form.negotiation_note || null,
          negotiated_date: form.negotiated_date || null,
          price_type_code: form.price_type_code ? Number(form.price_type_code) : null,
        }),
      });
      setData({ ...data, deal: updated });
      setMsg({ kind: 'ok', text: '交渉状況を保存しました' });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <div>
      <p style={{ marginBottom: 8 }}><Link to="/deals">← 案件一覧へ戻る</Link></p>
      <h1 className="page-title">{d.customer_name} ／ {d.model_name}</h1>
      <p className="page-sub">
        {d.equip_name} ・ {d.gas_type} ・ 売上年月 {d.sales_ym} ・ 担当 {d.sales_person} <DealStatusBadge status={d.status} />
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="基本情報">
          <dl className="kv">
            <dt>法人</dt><dd>{d.corp_name || '—'}</dd>
            <dt>得意先</dt><dd>{d.customer_name}（{d.customer_code}）</dd>
            <dt>納入先</dt><dd>{d.delivery_name || '—'}</dd>
            <dt>業種</dt><dd>{d.industry || '—'}</dd>
            <dt>カテゴリー</dt><dd>{d.category_name || '—'}</dd>
            <dt>台数</dt><dd>{d.qty}</dd>
            <dt>定価</dt><dd>¥{yen(d.list_price)}（新定価 ¥{yen(d.new_list_price)}）</dd>
            <dt>掛け率</dt><dd>{d.rate != null ? pct(d.rate * 100) : '—'}</dd>
            <dt>売上伝票NO</dt><dd>{d.voucher_no || '—'}</dd>
            <dt>見積伝票番号</dt><dd>{d.quote_no || '—'}</dd>
          </dl>
        </Card>

        <Card title="値上げ状況">
          <dl className="kv">
            <dt>出荷単価 ❶</dt><dd>¥{yen(d.base_price)}</dd>
            <dt>第1弾 目標 ❷</dt><dd>¥{yen(d.r1_target_price)}</dd>
            <dt>値上後単価 ❸</dt><dd>¥{yen(d.r1_agreed_price)}{d.r1_ringi_no ? `（稟議 ${d.r1_ringi_no}）` : ''}</dd>
            <dt>値上がり単価 ❹</dt><dd>¥{yen(d.r1_raise_unit)}</dd>
            <dt>値上がり金額 ❺</dt><dd><strong>¥{yen(d.r1_raise_amount)}</strong></dd>
            <dt>第2弾 目標 ❻</dt><dd>¥{yen(d.r2_target_price)}</dd>
            <dt>1回目提示</dt><dd>{d.offer1_date ? `${d.offer1_date} ¥${yen(d.offer1_price)}` : '—'}</dd>
            <dt>商談結果記号</dt><dd>{d.r2_result_symbol || '—'}</dd>
            <dt>最終確定単価 ❼</dt><dd>¥{yen(d.r2_agreed_price)}{d.r2_ringi_no ? `（稟議 ${d.r2_ringi_no}）` : ''}</dd>
            <dt>更なる値上 ❽</dt><dd>¥{yen(d.r2_raise_unit)}</dd>
            <dt>値上がり金額 ❾</dt><dd><strong>¥{yen(d.r2_raise_amount)}</strong></dd>
          </dl>
        </Card>
      </div>

      <Card title="交渉状況の更新">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="fld">
            ステータス
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {meta?.statuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </label>
          <label className="fld">
            確定商談日
            <input type="text" value={form.negotiated_date} placeholder="例: 2026-07-08"
              onChange={(e) => setForm({ ...form, negotiated_date: e.target.value })} />
          </label>
          <label className="fld">
            マスター単価種別（目標値上げ単価の登録先）
            <select value={form.price_type_code} onChange={(e) => setForm({ ...form, price_type_code: e.target.value })}>
              <option value="">未設定</option>
              {meta?.priceTypes.map((p) => (
                <option key={p.code} value={String(p.code)}>{p.code}. {p.name}（{p.category}）</option>
              ))}
            </select>
          </label>
          <label className="fld" style={{ flex: 1, minWidth: 260 }}>
            商談メモ
            <textarea rows={2} value={form.negotiation_note}
              onChange={(e) => setForm({ ...form, negotiation_note: e.target.value })} />
          </label>
          <button className="btn" onClick={save} disabled={!user}>保存</button>
        </div>
        {form.price_type_code && meta && (
          <p className="pt-note">
            {meta.priceTypes.find((p) => p.code === Number(form.price_type_code))?.note}
          </p>
        )}
      </Card>

      <NegotiationLog dealId={d.id} />

      <Attachments dealId={d.id} title="添付ファイル（見積書など）" />

      <Card title="この明細に関する申請">
        {data.applications.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            申請はまだありません。案件一覧で明細を選択して申請を作成するか、
            <a href="#" onClick={(e) => { e.preventDefault(); navigate('/applications/new', { state: { dealIds: [d.id], round: d.r1_agreed_price && d.r1_agreed_price > (d.base_price ?? 0) ? 2 : 1 } }); }}> この明細で申請を作成</a>
            できます。
          </p>
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>申請</th><th>弾</th><th className="num">合意単価</th><th className="num">達成率</th><th>状態</th><th>作成日</th></tr>
            </thead>
            <tbody>
              {data.applications.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => navigate(`/applications/${a.id}`)}>
                  <td>#{a.id}</td>
                  <td>第{a.round}弾</td>
                  <td className="num">¥{yen(a.agreed_price)}</td>
                  <td className="num">{a.achievement_rate != null ? pct(a.achievement_rate) : '—'}</td>
                  <td><AppStatusBadge status={a.status} /></td>
                  <td>{a.created_at?.slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

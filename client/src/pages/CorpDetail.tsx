import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Card, CorpStatusBadge } from '../components/ui';
import NegotiationLog from '../components/NegotiationLog';
import type { CorpNegotiation, Meta } from '../types';

interface CorpDetailRes {
  corp_code: string;
  corp_name: string | null;
  deals: number;
  r1_done: number;
  r2_done: number;
  negotiation: CorpNegotiation | null;
}

/**
 * 法人ごとの交渉情報。
 * 交渉は法人（本部）単位で進むため、状況とメモはここで管理する。
 */
export default function CorpDetail() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<CorpDetailRes | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [form, setForm] = useState({ status: 'not_started', contact_date: '', note: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<CorpDetailRes>(`/corps/${encodeURIComponent(code)}`)
      .then((d) => {
        setData(d);
        setForm({
          status: d.negotiation?.status ?? 'not_started',
          contact_date: d.negotiation?.contact_date ?? '',
          note: d.negotiation?.note ?? '',
        });
      })
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
  };
  useEffect(() => {
    load();
    api<Meta>('/meta').then(setMeta).catch(() => {});
  }, [code]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/corps/${encodeURIComponent(code)}/negotiation`, { method: 'PUT', body: JSON.stringify(form) });
      setMsg({ kind: 'ok', text: '交渉情報を保存しました' });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div>
        {msg && <div className="alert error">{msg.text}</div>}
        <p style={{ color: 'var(--muted)' }}>読み込み中...</p>
      </div>
    );
  }

  return (
    <div>
      <a href="/deals" onClick={(e) => { e.preventDefault(); navigate('/deals'); }}>← 案件一覧へ戻る</a>
      <h1 className="page-title" style={{ marginTop: 8 }}>{data.corp_name}</h1>
      <p className="page-sub">
        法人コード {data.corp_code} ・ 明細 {Number(data.deals).toLocaleString()}件 ・
        第1弾完了 {Number(data.r1_done).toLocaleString()}件 ・ 第2弾完了 {Number(data.r2_done).toLocaleString()}件
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <Card title="交渉情報">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="fld">
            交渉状況
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {(meta?.corpStatuses ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </label>
          <label className="fld">
            直近の商談日
            <input type="date" value={form.contact_date ?? ''}
              onChange={(e) => setForm({ ...form, contact_date: e.target.value })} />
          </label>
          <label className="fld" style={{ flex: 1, minWidth: 280 }}>
            交渉メモ
            <input type="text" value={form.note ?? ''} placeholder="本部の方針・条件など"
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <button className="btn" onClick={save} disabled={busy}>保存</button>
        </div>
        <p className="pt-note" style={{ marginTop: 10 }}>
          現在の状況: <CorpStatusBadge status={data.negotiation?.status} />
          {data.negotiation?.updated_at && `（最終更新 ${String(data.negotiation.updated_at).slice(0, 16).replace('T', ' ')}）`}
        </p>
      </Card>

      <NegotiationLog corpCode={data.corp_code} corpName={data.corp_name} />

      <Card title="この法人の明細">
        <p className="pt-note" style={{ margin: 0 }}>
          <a href={`/deals?corp=${encodeURIComponent(data.corp_code)}`}
             onClick={(e) => { e.preventDefault(); navigate(`/deals?corp=${encodeURIComponent(data.corp_code)}`); }}>
            案件一覧でこの法人の明細を表示する（{Number(data.deals).toLocaleString()}件）
          </a>
        </p>
      </Card>
    </div>
  );
}

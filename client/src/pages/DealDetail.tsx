import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, yen } from '../api';
import { Card, CorpStatusBadge, PriceTypeBadge, RoundStateBadge } from '../components/ui';
import Attachments from '../components/Attachments';
import { useUser } from '../user';
import type { CorpNegotiation, Deal, Meta } from '../types';

interface DealRes {
  deal: Deal;
  negotiation: CorpNegotiation | null;
}

interface FixField { key: string; label: string; group: string; type: string }

export default function DealDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useUser();
  const [data, setData] = useState<DealRes | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [msg, setMsg] = useState('');
  // 開発者の修正モード。取込のズレを全項目直せる
  const [fixFields, setFixFields] = useState<FixField[]>([]);
  const [fixing, setFixing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [fixMsg, setFixMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = () => {
    api<DealRes>(`/deals/${id}`).then(setData).catch((e) => setMsg(e.message));
  };
  useEffect(() => {
    load();
    api<Meta>('/meta').then(setMeta).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (me.role !== 'developer') return;
    api<{ fields: FixField[] }>('/import/fields')
      .then((r) => setFixFields(r.fields))
      .catch(() => {});
  }, [me.role]);

  const asText = (v: unknown) => (v === null || v === undefined ? '' : String(v));

  const startFix = () => {
    if (!data) return;
    const d = data.deal as unknown as Record<string, unknown>;
    const init: Record<string, string> = {};
    for (const f of fixFields) init[f.key] = asText(d[f.key]);
    setDraft(init);
    setFixMsg(null);
    setFixing(true);
  };

  const saveFix = async () => {
    if (!data) return;
    const d = data.deal as unknown as Record<string, unknown>;
    // 変えた項目だけ送る（全項目を送ると「変更なし」でも書き込みになるため）
    const body: Record<string, string> = {};
    for (const f of fixFields) {
      if (draft[f.key] !== asText(d[f.key])) body[f.key] = draft[f.key];
    }
    if (!Object.keys(body).length) {
      setFixMsg({ kind: 'error', text: '変更した項目がありません' });
      return;
    }
    setSaving(true);
    setFixMsg(null);
    try {
      await api(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setFixMsg({ kind: 'ok', text: `${Object.keys(body).length}項目を修正しました` });
      setFixing(false);
      load();
    } catch (e) {
      setFixMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

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

          <div className="section-title">交渉 <RoundStateBadge state={d.r2_state} /></div>
          <dl className="kv">
            <dt>区分</dt><dd>{d.kubun || '未選択'}</dd>
            <dt>目標値上げ単価 ❷</dt><dd>¥{yen(d.r2_target_price)}</dd>
            <dt>合意単価 ❸</dt><dd>{d.r2_agreed_price == null ? '—' : `¥${yen(d.r2_agreed_price)}`}</dd>
            <dt>値上がり単価 ❹</dt>
            <dd>{d.r2_raise_unit == null ? '—' : `¥${yen(d.r2_raise_unit)}`}</dd>
            <dt>適用年月</dt><dd>{d.r2_applied_ym || '—'}</dd>
          </dl>

          <p className="pt-note" style={{ marginTop: 12 }}>
            区分の選択と、合意単価・適用年月・完了の入力は<a href="/deals" onClick={(e) => { e.preventDefault(); navigate('/deals'); }}>案件一覧</a>から行います。
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

      {me.role === 'developer' && (
        <Card title="取込データの修正（開発者のみ）">
          {fixMsg && (
            <div className={`alert ${fixMsg.kind === 'ok' ? 'ok' : 'error'}`} onClick={() => setFixMsg(null)}>
              {fixMsg.text}
            </div>
          )}
          {!fixing ? (
            <>
              <p className="pt-note" style={{ marginTop: 0 }}>
                取込で入った全項目（法人・得意先・器種・単価・支店など）をこの画面で直せます。
                列の取り違えや誤記の修正用です。管理表と食い違わないよう、修正内容は元のExcelにも反映してください。
              </p>
              <button className="btn secondary" onClick={startFix} disabled={!fixFields.length}>
                修正をはじめる
              </button>
            </>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                {fixFields.map((f) => {
                  const orig = asText((d as unknown as Record<string, unknown>)[f.key]);
                  const changed = draft[f.key] !== orig;
                  return (
                    <label key={f.key} style={{ fontSize: 12 }}>
                      <span style={{ color: changed ? 'var(--accent)' : 'var(--muted)', display: 'block', marginBottom: 2 }}>
                        {f.group}｜{f.label}{changed && '（変更）'}
                      </span>
                      <input
                        style={{ width: '100%', borderColor: changed ? 'var(--accent)' : undefined }}
                        value={draft[f.key] ?? ''}
                        inputMode={f.type === 'number' ? 'decimal' : undefined}
                        onChange={(e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      />
                    </label>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button className="btn" onClick={saveFix} disabled={saving}>
                  {saving ? '保存中...' : '変更した項目を保存'}
                </button>
                <button className="btn secondary" onClick={() => setFixing(false)} disabled={saving}>やめる</button>
              </div>
              <p className="pt-note" style={{ marginTop: 10 }}>
                変えた項目だけが保存されます（枠が青くなっている項目）。空欄にすると未設定になります。
              </p>
            </>
          )}
        </Card>
      )}

      <Attachments dealId={d.id} />
    </div>
  );
}

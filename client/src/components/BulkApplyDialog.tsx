import { useEffect, useState } from 'react';
import { api, yen } from '../api';
import type { Meta } from '../types';

interface Preview {
  count: number;
  qty: number;
  targetAmount: number;
}

/**
 * 得意先を選んで対象明細をまとめて申請する。
 * 対象は「目標単価が設定済み」かつ「進行中の申請が無い」明細に限定される（サーバー側で判定）。
 */
export default function BulkApplyDialog({
  round, meta, defaults, onClose, onCreated,
}: {
  round: 1 | 2;
  meta: Meta;
  defaults: { customer: string; equip: string; branch: string; office: string };
  onClose: () => void;
  onCreated: (applicationId: number) => void;
}) {
  const [customer, setCustomer] = useState(defaults.customer);
  const [equip, setEquip] = useState(defaults.equip);
  const [priceType, setPriceType] = useState('');
  const [comment, setComment] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!customer) {
      setPreview(null);
      return;
    }
    const qs = new URLSearchParams({ round: String(round), customer });
    if (equip) qs.set('equip', equip);
    if (defaults.branch) qs.set('branch', defaults.branch);
    if (defaults.office) qs.set('office', defaults.office);
    api<Preview>(`/applications/bulk-preview?${qs}`).then(setPreview).catch(() => setPreview(null));
  }, [customer, equip, round]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const app = await api<{ id: number }>('/applications/bulk', {
        method: 'POST',
        body: JSON.stringify({
          round, customerCode: customer, equip: equip || undefined,
          branch: defaults.branch || undefined, office: defaults.office || undefined,
          price_type_code: priceType ? Number(priceType) : null,
          comment: comment || null,
        }),
      });
      onCreated(app.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>得意先まとめて申請（第{round}弾）</h3>
        <p className="pt-note" style={{ marginBottom: 14 }}>
          選んだ得意先のうち、目標単価が設定済みで、まだ申請していない明細をまとめて1つの申請にします。
          合意単価の初期値は目標単価です（作成後に調整できます）。
        </p>
        {error && <div className="alert error">{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="fld">
            得意先
            <select value={customer} onChange={(e) => setCustomer(e.target.value)}>
              <option value="">選択してください</option>
              {meta.customers.map((c) => (
                <option key={c.code} value={c.code}>{c.name}（{c.count.toLocaleString()}件）</option>
              ))}
            </select>
          </label>
          <label className="fld">
            器具区分で絞る（任意）
            <select value={equip} onChange={(e) => setEquip(e.target.value)}>
              <option value="">すべて</option>
              {meta.equips.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </label>
          <label className="fld">
            マスター単価種別
            <select value={priceType} onChange={(e) => setPriceType(e.target.value)}>
              <option value="">明細の設定を引き継ぐ</option>
              {meta.priceTypes.map((p) => (
                <option key={p.code} value={String(p.code)}>{p.code}. {p.name}（{p.category}）</option>
              ))}
            </select>
          </label>
          <label className="fld">
            申請コメント（任意）
            <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </div>

        {customer && (
          <div className={`alert ${preview && preview.count > 0 ? 'info' : 'error'}`} style={{ marginTop: 14 }}>
            {preview === null ? '対象を確認中...'
              : preview.count === 0
                ? '申請できる明細がありません（目標単価が未設定、または既に申請済みです）'
                : `対象 ${preview.count.toLocaleString()}明細 ・ ${preview.qty.toLocaleString()}台 ・ 目標値上金額 ¥${yen(preview.targetAmount)}`}
          </div>
        )}

        <div className="toolbar" style={{ marginTop: 16, marginBottom: 0 }}>
          <button className="btn secondary" onClick={onClose}>キャンセル</button>
          <div className="grow" />
          <button className="btn" disabled={busy || !preview || preview.count === 0} onClick={create}>
            申請を作成
          </button>
        </div>
      </div>
    </div>
  );
}

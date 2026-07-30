import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, yen, pct } from '../api';
import type { Application, Deal, Meta, Rule } from '../types';
import { Card, RouteBadge } from '../components/ui';

// 提出時はサーバー側で再判定されるが、画面でも同じロジックで事前表示する
function previewRoute(rules: Rule[], rate: number): { route: 'branch' | 'planning'; ruleName: string } {
  for (const r of rules) {
    if (r.active === 0 || r.active === false) continue;
    if (r.min_rate != null && rate < r.min_rate) continue;
    if (r.max_rate != null && rate >= r.max_rate) continue;
    return { route: r.final_step, ruleName: r.name };
  }
  return { route: 'planning', ruleName: '既定（該当ルールなし→営業企画部決裁）' };
}

export default function NewApplication() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state || {}) as { dealIds?: number[]; round?: 1 | 2 };
  const [round, setRound] = useState<1 | 2>(state.round || 1);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [agreed, setAgreed] = useState<Record<number, string>>({});
  const [priceType, setPriceType] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Meta>('/meta').then(setMeta);
    api<Rule[]>('/rules').then(setRules);
    if (state.dealIds?.length) {
      api<{ rows: Deal[] }>(`/deals?ids=${state.dealIds.join(',')}&size=200`).then((r) => {
        setDeals(r.rows);
        const init: Record<number, string> = {};
        for (const d of r.rows) {
          const target = (state.round || 1) === 1 ? d.r1_target_price : d.r2_target_price;
          init[d.id] = target != null ? String(target) : '';
        }
        setAgreed(init);
        // 単価種別の初期値: 明細の推定値（最頻値）
        const counts = new Map<number, number>();
        for (const d of r.rows) if (d.price_type_code) counts.set(d.price_type_code, (counts.get(d.price_type_code) || 0) + 1);
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top) setPriceType(String(top[0]));
      });
    }
  }, []);

  useEffect(() => {
    // 弾を切り替えたら合意単価の初期値も切替
    const init: Record<number, string> = {};
    for (const d of deals) {
      const target = round === 1 ? d.r1_target_price : d.r2_target_price;
      init[d.id] = target != null ? String(target) : '';
    }
    if (deals.length) setAgreed(init);
  }, [round]);

  const calc = useMemo(() => {
    let target = 0;
    let agreedSum = 0;
    for (const d of deals) {
      const base = round === 1 ? d.base_price : (d.r1_agreed_price ?? d.base_price);
      const tp = round === 1 ? d.r1_target_price : d.r2_target_price;
      const ap = Number(agreed[d.id]);
      const qty = d.qty || 0;
      if (tp != null && base != null) target += (tp - base) * qty;
      if (Number.isFinite(ap) && base != null) agreedSum += (ap - base) * qty;
    }
    const rate = target > 0 ? Math.round((agreedSum / target) * 1000) / 10 : 100;
    return { target, agreedSum, rate, ...previewRoute(rules, rate) };
  }, [deals, agreed, round, rules]);

  if (!state.dealIds?.length) {
    return (
      <div>
        <h1 className="page-title">申請作成</h1>
        <div className="alert info">
          案件一覧で対象明細を選択してから「申請作成」を押してください。<br />
          <Link to="/deals">案件一覧へ</Link>
        </div>
      </div>
    );
  }

  const submit = async (alsoSubmit: boolean) => {
    setBusy(true);
    setError('');
    try {
      const app = await api<Application>('/applications', {
        method: 'POST',
        body: JSON.stringify({
          round,
          items: deals.map((d) => ({ deal_id: d.id, agreed_price: Number(agreed[d.id]) })),
          price_type_code: priceType ? Number(priceType) : null,
          comment: comment || null,
        }),
      });
      if (alsoSubmit) await api(`/applications/${app.id}/submit`, { method: 'POST' });
      navigate(`/applications/${app.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const invalid = deals.some((d) => !Number.isFinite(Number(agreed[d.id])) || agreed[d.id] === '');

  return (
    <div>
      <h1 className="page-title">合意価格の申請作成</h1>
      <p className="page-sub">
        {deals[0]?.customer_name} ・ {deals.length}明細 ・ 承認フロー: 営業担当者 → 支店長{calc.route === 'planning' ? ' → 営業企画部' : ''}
      </p>
      {error && <div className="alert error">{error}</div>}

      <Card>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="fld">
            値上げ活動
            <select value={round} onChange={(e) => setRound(Number(e.target.value) as 1 | 2)}>
              <option value={1}>第1弾</option>
              <option value={2}>第2弾</option>
            </select>
          </label>
          <label className="fld" style={{ minWidth: 300 }}>
            マスター単価種別（承認後の登録先。6種類から選択）
            <select value={priceType} onChange={(e) => setPriceType(e.target.value)}>
              <option value="">未設定</option>
              {meta?.priceTypes.map((p) => (
                <option key={p.code} value={String(p.code)}>{p.code}. {p.name}（{p.category}）</option>
              ))}
            </select>
          </label>
          <label className="fld" style={{ flex: 1, minWidth: 240 }}>
            申請コメント
            <input type="text" value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="交渉経緯・条件など" />
          </label>
        </div>
        {priceType && meta && (
          <p className="pt-note">{meta.priceTypes.find((p) => p.code === Number(priceType))?.note}</p>
        )}
      </Card>

      <div className="card tbl-scroll" style={{ padding: 0 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>器種名</th>
              <th>器具区分</th>
              <th className="num">台数</th>
              <th className="num">基準単価{round === 1 ? '❶' : '❸'}</th>
              <th className="num">目標単価{round === 1 ? '❷' : '❻'}</th>
              <th className="num">合意単価</th>
              <th className="num">値上額/台</th>
              <th className="num">値上金額</th>
            </tr>
          </thead>
          <tbody>
            {deals.map((d) => {
              const base = round === 1 ? d.base_price : (d.r1_agreed_price ?? d.base_price);
              const target = round === 1 ? d.r1_target_price : d.r2_target_price;
              const ap = Number(agreed[d.id]);
              const unit = Number.isFinite(ap) && base != null ? ap - base : null;
              return (
                <tr key={d.id}>
                  <td>{d.model_name}</td>
                  <td>{d.equip_name}</td>
                  <td className="num">{d.qty}</td>
                  <td className="num">{yen(base)}</td>
                  <td className="num">{yen(target)}</td>
                  <td className="num">
                    <input type="number" style={{ width: 110, textAlign: 'right' }} value={agreed[d.id] ?? ''}
                      onChange={(e) => setAgreed({ ...agreed, [d.id]: e.target.value })} />
                  </td>
                  <td className="num" style={{ color: unit != null && unit < 0 ? 'var(--critical)' : undefined }}>{unit != null ? yen(unit) : '—'}</td>
                  <td className="num">{unit != null ? yen(unit * (d.qty || 0)) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Card title="申請サマリー（提出時に承認ルールで自動判定）">
        <div className="tiles" style={{ marginBottom: 0 }}>
          <div className="tile">
            <div className="label">目標値上金額</div>
            <div className="value">¥{yen(calc.target)}</div>
          </div>
          <div className="tile">
            <div className="label">申請値上金額</div>
            <div className="value">¥{yen(calc.agreedSum)}</div>
          </div>
          <div className="tile">
            <div className="label">目標達成率</div>
            <div className="value">{pct(calc.rate)}</div>
          </div>
          <div className="tile">
            <div className="label">承認ルート</div>
            <div className="value" style={{ fontSize: 16 }}><RouteBadge route={calc.route} /></div>
            <div className="delta">{calc.ruleName}</div>
          </div>
        </div>
      </Card>

      <div className="toolbar">
        <button className="btn secondary" onClick={() => navigate(-1)}>戻る</button>
        <div className="grow" />
        <button className="btn secondary" disabled={busy || invalid} onClick={() => submit(false)}>下書き保存</button>
        <button className="btn" disabled={busy || invalid} onClick={() => submit(true)}>申請を提出</button>
      </div>
    </div>
  );
}

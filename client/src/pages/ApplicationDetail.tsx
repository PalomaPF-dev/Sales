import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, yen, pct } from '../api';
import type { Application } from '../types';
import { useUser } from '../user';
import { AppStatusBadge, Card, RouteBadge } from '../components/ui';

export default function ApplicationDetail({ onChanged }: { onChanged?: () => void }) {
  const { id } = useParams();
  const [app, setApp] = useState<Application | null>(null);
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const user = useUser();

  const load = () => {
    api<Application>(`/applications/${id}`).then(setApp).catch((e) => setMsg({ kind: 'error', text: e.message }));
  };
  useEffect(load, [id]);

  if (!app) return <p>読み込み中...</p>;

  const act = async (action: 'submit' | 'approve' | 'reject' | 'withdraw') => {
    setBusy(true);
    setMsg(null);
    try {
      const updated = await api<Application>(`/applications/${app.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ comment: comment || null }),
      });
      setApp(updated);
      setComment('');
      onChanged?.();
      const texts = { submit: '申請を提出しました', approve: '承認しました', reject: '差戻しました', withdraw: '取下げました' };
      setMsg({ kind: 'ok', text: texts[action] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // 承認可能か（支店長承認待ち: 同一支店の支店長 / 企画承認待ち: 営業企画部）
  const canApproveNow =
    (app.status === 'pending_branch' && user && (user.role === 'admin' || (user.role === 'branch_manager' && user.branch === app.branch))) ||
    (app.status === 'pending_planning' && user && ['planning', 'admin'].includes(user.role));
  const isApplicant = user && (user.id === app.applicant_id || user.role === 'admin');

  // ワークフロー表示用ステップ
  const steps = [
    { key: 'apply', label: `申請（${app.applicant_name}）` },
    { key: 'branch', label: '支店長承認' },
    ...(app.route === 'planning' || app.status === 'pending_planning' ? [{ key: 'planning', label: '営業企画部承認' }] : []),
    { key: 'done', label: '完了・マスター単価登録' },
  ];
  const stepState = (key: string): string => {
    const order = ['apply', 'branch', 'planning', 'done'];
    const currentIdx =
      app.status === 'draft' ? 0
      : app.status === 'pending_branch' ? 1
      : app.status === 'pending_planning' ? 2
      : app.status === 'approved' ? 4
      : app.status === 'rejected' ? (app.approvals?.some((x) => x.step === 'planning' && x.action === 'rejected') ? 2 : 1)
      : 0;
    const idx = order.indexOf(key);
    if (app.status === 'rejected' && idx === currentIdx) return 'rejected';
    if (idx < currentIdx) return 'done';
    if (idx === currentIdx) return 'now';
    return '';
  };

  return (
    <div>
      <p style={{ marginBottom: 8 }}><Link to="/applications">← 申請一覧へ戻る</Link></p>
      <h1 className="page-title">#{app.id} {app.title}</h1>
      <p className="page-sub">
        第{app.round}弾 ・ {app.customer_name} ・ 申請者 {app.applicant_name}（{app.branch}） <AppStatusBadge status={app.status} />
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <div className="steps">
        {steps.map((s, i) => (
          <span key={s.key} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && <span className="step-arrow" />}
            <span className={`step ${stepState(s.key)}`}>
              <span className="dot">{stepState(s.key) === 'done' ? '✓' : i + 1}</span>
              <span className="lbl">{s.label}</span>
            </span>
          </span>
        ))}
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">目標値上金額</div>
          <div className="value">¥{yen(app.target_amount)}</div>
        </div>
        <div className="tile">
          <div className="label">申請値上金額</div>
          <div className="value">¥{yen(app.agreed_amount)}</div>
        </div>
        <div className="tile">
          <div className="label">目標達成率</div>
          <div className="value">{app.achievement_rate != null ? pct(app.achievement_rate) : '—'}</div>
          <div className="delta">{app.rule_name || '（提出時に判定）'}</div>
        </div>
        <div className="tile">
          <div className="label">承認ルート / 単価種別</div>
          <div className="value" style={{ fontSize: 15, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span><RouteBadge route={app.route} /></span>
            <span style={{ fontWeight: 400, fontSize: 13 }}>
              {app.price_type_code ? `${app.price_type_code}. ${app.price_type_name}（${app.price_type_category}）` : '単価種別 未設定'}
            </span>
          </div>
        </div>
      </div>

      {app.comment && <div className="alert info">申請コメント: {app.comment}</div>}

      <Card title={`対象明細（${app.items?.length}件）`}>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>器種名</th>
                <th>器具区分</th>
                <th>納入先</th>
                <th className="num">台数</th>
                <th className="num">基準単価</th>
                <th className="num">目標単価</th>
                <th className="num">合意単価</th>
                <th className="num">値上金額</th>
                <th className="num">達成率</th>
              </tr>
            </thead>
            <tbody>
              {app.items?.map((it) => {
                const raise = it.base_price != null ? (it.agreed_price - it.base_price) * (it.qty || 0) : null;
                const target = it.base_price != null && it.target_price != null ? (it.target_price - it.base_price) * (it.qty || 0) : null;
                return (
                  <tr key={it.id}>
                    <td><Link to={`/deals/${it.deal_id}`}>{it.model_name}</Link></td>
                    <td>{it.equip_name}</td>
                    <td>{it.delivery_name || '—'}</td>
                    <td className="num">{it.qty}</td>
                    <td className="num">¥{yen(it.base_price)}</td>
                    <td className="num">¥{yen(it.target_price)}</td>
                    <td className="num"><strong>¥{yen(it.agreed_price)}</strong></td>
                    <td className="num">{raise != null ? `¥${yen(raise)}` : '—'}</td>
                    <td className="num">{target && target > 0 && raise != null ? pct((raise / target) * 100) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="承認履歴">
        {app.approvals?.length ? (
          <table className="tbl">
            <thead>
              <tr><th>日時</th><th>ステップ</th><th>担当</th><th>結果</th><th>コメント</th></tr>
            </thead>
            <tbody>
              {app.approvals.map((ap) => (
                <tr key={ap.id}>
                  <td>{ap.acted_at}</td>
                  <td>{ap.step === 'branch' ? '支店長' : '営業企画部'}</td>
                  <td>{ap.approver_name}</td>
                  <td>{ap.action === 'approved' ? <span className="badge green">承認</span> : <span className="badge red">差戻し</span>}</td>
                  <td>{ap.comment || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>まだ承認履歴はありません。</p>
        )}
      </Card>

      <Card title="アクション">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="fld" style={{ flex: 1, minWidth: 240 }}>
            コメント
            <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="承認・差戻し・提出時のコメント" />
          </label>
          {isApplicant && ['draft', 'rejected'].includes(app.status) && (
            <button className="btn" disabled={busy} onClick={() => act('submit')}>申請を提出</button>
          )}
          {canApproveNow && (
            <>
              <button className="btn" disabled={busy} onClick={() => act('approve')}>承認する</button>
              <button className="btn danger" disabled={busy} onClick={() => act('reject')}>差戻す</button>
            </>
          )}
          {isApplicant && ['draft', 'pending_branch', 'pending_planning', 'rejected'].includes(app.status) && (
            <button className="btn secondary" disabled={busy} onClick={() => act('withdraw')}>取下げ</button>
          )}
        </div>
        {app.status === 'approved' && (
          <p className="pt-note" style={{ marginTop: 10 }}>
            この申請は承認済みです。合意単価は案件明細の{app.round === 1 ? '値上後単価（❸）' : '最終確定単価（❼）'}へ反映され、
            単価種別「{app.price_type_code}. {app.price_type_name}」としてマスター単価に登録されます。
          </p>
        )}
      </Card>
    </div>
  );
}

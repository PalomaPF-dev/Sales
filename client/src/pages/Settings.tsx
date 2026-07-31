import { useEffect, useState } from 'react';
import { api, yen } from '../api';
import type { Meta, Rule } from '../types';
import { Card } from '../components/ui';

interface Target {
  scope: 'branch' | 'office' | 'person';
  scope_value: string;
  round: 1 | 2;
  amount: number;
}

export default function Settings() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<Meta | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api<Rule[]>('/rules').then(setRules);
    api<Record<string, string>>('/settings').then(setSettings);
    api<Meta>('/meta').then(setMeta);
    api<Target[]>('/targets').then(setTargets);
  }, []);

  const updTarget = (i: number, patch: Partial<Target>) => {
    setTargets(targets.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  };

  const saveScopedTargets = async () => {
    try {
      const saved = await api<Target[]>('/targets', { method: 'PUT', body: JSON.stringify(targets) });
      setTargets(saved);
      setMsg({ kind: 'ok', text: '個別の目標金額を保存しました' });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  const saveRules = async () => {
    try {
      const saved = await api<Rule[]>('/rules', { method: 'PUT', body: JSON.stringify(rules) });
      setRules(saved);
      setMsg({ kind: 'ok', text: '承認ルールを保存しました' });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  const saveTargets = async () => {
    try {
      const saved = await api<Record<string, string>>('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          r1_target_total: settings.r1_target_total || '0',
          r2_target_total: settings.r2_target_total || '0',
        }),
      });
      setSettings(saved);
      setMsg({ kind: 'ok', text: '目標金額を保存しました' });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  const upd = (i: number, patch: Partial<Rule>) => {
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  return (
    <div>
      <h1 className="page-title">設定</h1>
      <p className="page-sub">承認権限ルール・支店目標金額・マスター単価種別（営業企画部のみ変更可能）</p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <Card title="承認権限ルール（上から順に評価され、最初に該当したルールが適用されます）">
        <div className="alert info">
          申請の「目標達成率」＝ 申請値上金額 ÷ 目標値上金額。達成率がルールの範囲に該当すると、そのルールの決裁者で承認が完結します。
          「支店長決裁」は支店長の承認のみで完結、「営業企画部決裁」は支店長承認の後に営業企画部の承認が必要です。
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>順</th><th>ルール名</th><th className="num">達成率 下限（%以上）</th><th className="num">達成率 上限（%未満）</th><th>最終決裁者</th><th>有効</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><input type="text" style={{ width: '100%', minWidth: 200 }} value={r.name}
                  onChange={(e) => upd(i, { name: e.target.value })} /></td>
                <td className="num"><input type="number" style={{ width: 90 }} value={r.min_rate ?? ''}
                  placeholder="なし" onChange={(e) => upd(i, { min_rate: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                <td className="num"><input type="number" style={{ width: 90 }} value={r.max_rate ?? ''}
                  placeholder="なし" onChange={(e) => upd(i, { max_rate: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                <td>
                  <select value={r.final_step} onChange={(e) => upd(i, { final_step: e.target.value as Rule['final_step'] })}>
                    <option value="branch">支店長決裁</option>
                    <option value="planning">営業企画部決裁</option>
                  </select>
                </td>
                <td><input type="checkbox" checked={r.active !== 0 && r.active !== false}
                  onChange={(e) => upd(i, { active: e.target.checked })} /></td>
                <td><button className="btn secondary sm" onClick={() => setRules(rules.filter((_, j) => j !== i))}>削除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button className="btn secondary sm"
            onClick={() => setRules([...rules, { name: '新しいルール', min_rate: null, max_rate: null, final_step: 'planning', active: true }])}>
            ルールを追加
          </button>
          <div className="grow" />
          <button className="btn" onClick={saveRules}>承認ルールを保存</button>
        </div>
      </Card>

      <Card title="全社の値上げ目標金額（既定値）">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="fld">
            第1弾 目標金額（円）
            <input type="number" value={settings.r1_target_total || ''}
              onChange={(e) => setSettings({ ...settings, r1_target_total: e.target.value })} />
          </label>
          <label className="fld">
            第2弾 目標金額（円）
            <input type="number" value={settings.r2_target_total || ''}
              onChange={(e) => setSettings({ ...settings, r2_target_total: e.target.value })} />
          </label>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            合計 ¥{yen(Number(settings.r1_target_total || 0) + Number(settings.r2_target_total || 0))}
          </span>
          <button className="btn" onClick={saveTargets}>目標金額を保存</button>
        </div>
        <p className="pt-note" style={{ marginTop: 8 }}>
          下の表で支店・営業所の目標を設定すると、そちらが優先されます。
        </p>
      </Card>

      <Card title="支店・営業所・担当者ごとの目標金額">
        <div className="alert info">
          ダッシュボードの絞り込みに応じて目標が切り替わります。
          営業所を指定していればその営業所の目標、支店を指定していれば支店の目標、
          未指定なら支店目標の合計が使われます。
        </div>
        <table className="tbl">
          <thead>
            <tr><th>区分</th><th>対象</th><th>弾</th><th className="num">目標金額（円）</th><th></th></tr>
          </thead>
          <tbody>
            {targets.map((t, i) => (
              <tr key={i}>
                <td>
                  <select value={t.scope} onChange={(e) => updTarget(i, { scope: e.target.value as Target['scope'], scope_value: '' })}>
                    <option value="branch">支店</option>
                    <option value="office">営業所</option>
                    <option value="person">担当者</option>
                  </select>
                </td>
                <td>
                  <select value={t.scope_value} onChange={(e) => updTarget(i, { scope_value: e.target.value })}>
                    <option value="">選択してください</option>
                    {(t.scope === 'branch' ? meta?.branches
                      : t.scope === 'office' ? meta?.offices
                      : meta?.persons)?.map((o) => (
                        <option key={o.name} value={o.name}>{o.name}</option>
                      ))}
                  </select>
                </td>
                <td>
                  <select value={t.round} onChange={(e) => updTarget(i, { round: Number(e.target.value) as 1 | 2 })}>
                    <option value={1}>第1弾</option>
                    <option value={2}>第2弾</option>
                  </select>
                </td>
                <td className="num">
                  <input type="number" style={{ width: 140, textAlign: 'right' }} value={t.amount}
                    onChange={(e) => updTarget(i, { amount: Number(e.target.value) })} />
                </td>
                <td>
                  <button className="btn secondary sm" onClick={() => setTargets(targets.filter((_, j) => j !== i))}>削除</button>
                </td>
              </tr>
            ))}
            {targets.length === 0 && (
              <tr><td colSpan={5} style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>
                個別の目標は未設定です（全社の既定値が使われます）
              </td></tr>
            )}
          </tbody>
        </table>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button className="btn secondary sm"
            onClick={() => setTargets([...targets, { scope: 'branch', scope_value: '', round: 1, amount: 0 }])}>
            目標を追加
          </button>
          <div className="grow" />
          <button className="btn" onClick={saveScopedTargets}>個別目標を保存</button>
        </div>
      </Card>

      <Card title="マスター単価種別（6種類）">
        <table className="tbl">
          <thead>
            <tr><th>No</th><th>種別</th><th>区分</th><th>説明</th></tr>
          </thead>
          <tbody>
            {meta?.priceTypes.map((p) => (
              <tr key={p.code}>
                <td>{p.code}</td>
                <td><strong>{p.name}</strong></td>
                <td>{p.category}</td>
                <td style={{ color: 'var(--ink-2)' }}>{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pt-note" style={{ marginTop: 8 }}>
          目標値上げ単価は承認後、選択された種別でマスター単価に登録されます。
          取込時の初期値は「見積伝票番号あり→⑥見積伝票」「納入先が特定→⑤納入先別単価」「それ以外→④取引先商品」で推定され、案件・申請画面で変更できます。
        </p>
      </Card>
    </div>
  );
}

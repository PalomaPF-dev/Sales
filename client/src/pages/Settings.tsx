import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';
import type { Meta } from '../types';

interface StatusItem {
  key: string;
  name: string;
  ok: boolean;
  detail: string;
  hint: string;
}
interface Status {
  platform: string;
  db: string;
  items: StatusItem[];
}

/** 全国基準価格表の1行（器種 × 区分） */
interface StdRow {
  region: string;
  category: string | null;
  model_gas_code: string | null;
  model_name: string;
  kubun: string;
  current_price: number | null;
  target_price: number;
}
interface StdRes {
  rows: StdRow[];
  kubuns: string[];
  meta: { filename?: string; count?: number; updatedAt?: string } | null;
}

/**
 * 設定。
 * 承認ワークフローを廃止したため、ここは参照用のマスター情報だけを扱う。
 *
 * 加えて、外部連携が本番で効いているかを管理者に見せる。
 * 環境変数はVercelの画面でしか設定できないため、
 * 「設定したはずなのに効いていない」をここで確かめられるようにする。
 */
export default function Settings() {
  const me = useUser();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [std, setStd] = useState<StdRes | null>(null);
  const [stdBusy, setStdBusy] = useState(false);
  const [stdMsg, setStdMsg] = useState('');
  const stdFileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch((e) => setMsg(e.message));
  }, []);

  // 企画も設定画面を開けるが、連携の状況は管理者だけに見せる
  useEffect(() => {
    if (me.role !== 'admin' && me.role !== 'developer') return;
    api<Status>('/admin/status').then(setStatus).catch((e) => setMsg(e.message));
  }, [me.role]);

  const loadStd = () => {
    api<StdRes>('/standard-prices').then(setStd).catch((e) => setMsg(e.message));
  };
  useEffect(loadStd, []);

  /** 基準価格表のExcelを取り込む（マスターを丸ごと差し替える） */
  const importStd = async () => {
    const file = stdFileRef.current?.files?.[0];
    if (!file) { setMsg('ファイルを選択してください'); return; }
    setStdBusy(true);
    setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ count: number; models: number; regions: string[] }>(
        '/admin/standard-prices', { method: 'POST', body: fd });
      setStdMsg(`取り込みました: ${r.models}器種 × 区分 = ${r.count}行（${r.regions.join('・')}）`);
      if (stdFileRef.current) stdFileRef.current.value = '';
      loadStd();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setStdBusy(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">設定</h1>
      <p className="page-sub">マスター単価種別の一覧です。</p>
      {msg && <div className="alert error" onClick={() => setMsg('')}>{msg}</div>}

      {status && (
        <Card title="連携の状況">
          <p className="pt-note" style={{ marginTop: 0 }}>
            いま動いている本番での状態です。設定を変えたあとは、Vercelで再デプロイすると反映されます。
          </p>
          <table className="tbl">
            <thead>
              <tr><th style={{ width: 90 }}>状態</th><th>項目</th><th>内容</th></tr>
            </thead>
            <tbody>
              {status.items.map((it) => (
                <tr key={it.key}>
                  <td>
                    <span className={`badge ${it.ok ? 'green' : 'yellow'}`}>
                      {it.ok ? '有効' : '未設定'}
                    </span>
                  </td>
                  <td><strong>{it.name}</strong></td>
                  <td>
                    {it.detail}
                    {!it.ok && <div className="pt-note" style={{ marginTop: 4 }}>{it.hint}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pt-note" style={{ marginTop: 12 }}>
            稼働先: {status.platform === 'vercel' ? 'Vercel' : '自前サーバー'} ／
            データベース: {status.db === 'postgres' ? 'PostgreSQL' : status.db}
          </p>
        </Card>
      )}

      <Card title="全国基準価格表（マスター）">
        {stdMsg && <div className="alert ok" onClick={() => setStdMsg('')}>{stdMsg}</div>}
        <p className="pt-note" style={{ marginTop: 0 }}>
          器種 × 区分（大手・中規模・小規模）ごとの基準単価です。
          案件一覧で担当者が区分を選ぶと、この表の「値上後単価」がその案件の目標になります。
          {std?.meta?.updatedAt && (
            <>
              {' '}現在: <strong>{std.meta.filename}</strong>
              （{std.meta.count}行 ／ {String(std.meta.updatedAt).slice(0, 16).replace('T', ' ')} 取込）
            </>
          )}
        </p>
        {me.role === 'admin' || me.role === 'developer' ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <input type="file" ref={stdFileRef} accept=".xlsx,.xlsm" disabled={stdBusy} />
            <button className="btn" onClick={importStd} disabled={stdBusy}>
              {stdBusy ? '取込中...' : '基準価格表を取り込む（差し替え）'}
            </button>
          </div>
        ) : null}
        {std && std.rows.length > 0 ? (
          <div className="tbl-scroll" style={{ maxHeight: 420 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>地域</th><th>まとまり</th><th>品名</th>
                  {std.kubuns.map((k) => <th key={k} style={{ textAlign: 'right' }}>{k} 値上後</th>)}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const grouped = new Map<string, { region: string; category: string | null; name: string; t: Record<string, number> }>();
                  for (const r of std.rows) {
                    const key = `${r.region}|${r.model_name}`;
                    if (!grouped.has(key)) grouped.set(key, { region: r.region, category: r.category, name: r.model_name, t: {} });
                    grouped.get(key)!.t[r.kubun] = r.target_price;
                  }
                  return [...grouped.values()].map((g, i) => (
                    <tr key={i}>
                      <td>{g.region}</td>
                      <td style={{ color: 'var(--muted)' }}>{g.category ?? ''}</td>
                      <td><strong>{g.name}</strong></td>
                      {std.kubuns.map((k) => (
                        <td key={k} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {g.t[k] != null ? `¥${g.t[k].toLocaleString()}` : '—'}
                        </td>
                      ))}
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="pt-note">まだ取り込まれていません。基準価格表のExcelを取り込んでください。</p>
        )}
      </Card>

      <Card title={`マスター単価種別（${meta?.priceTypes.length ?? 0}種類）`}>
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
                <td>{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pt-note" style={{ marginTop: 12 }}>
          目標値上げ単価は、承認後にこの種別でマスター単価に登録されます。
          取込時の初期値は「見積伝票番号あり→⑥見積伝票」「納入先が特定→⑤納入先別単価」
          「それ以外→④取引先商品」で推定され、案件一覧から変更できます。
        </p>
      </Card>
    </div>
  );
}

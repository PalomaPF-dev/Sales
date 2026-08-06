import { useEffect, useState } from 'react';
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
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch((e) => setMsg(e.message));
  }, []);

  // 企画も設定画面を開けるが、連携の状況は管理者だけに見せる
  useEffect(() => {
    if (me.role !== 'admin' && me.role !== 'developer') return;
    api<Status>('/admin/status').then(setStatus).catch((e) => setMsg(e.message));
  }, [me.role]);

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

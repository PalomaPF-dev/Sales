import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card } from '../components/ui';
import type { Meta } from '../types';

/**
 * 設定。
 * 承認ワークフローを廃止したため、ここは参照用のマスター情報だけを扱う。
 */
export default function Settings() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch((e) => setMsg(e.message));
  }, []);

  return (
    <div>
      <h1 className="page-title">設定</h1>
      <p className="page-sub">マスター単価種別の一覧です。</p>
      {msg && <div className="alert error" onClick={() => setMsg('')}>{msg}</div>}

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

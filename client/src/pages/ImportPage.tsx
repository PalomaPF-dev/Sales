import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Card } from '../components/ui';

interface Batch {
  id: number;
  filename: string;
  row_count: number;
  imported_by_name: string | null;
  imported_at: string;
}

export default function ImportPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    api<Batch[]>('/import/batches').then(setBatches).catch(() => {});
  };
  useEffect(load, []);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMsg({ kind: 'error', text: 'ファイルを選択してください' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api<{ batchId: number; count: number }>('/import', { method: 'POST', body: fd });
      setMsg({ kind: 'ok', text: `取込完了: ${file.name} → ${res.count.toLocaleString()}行` });
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">Excel取込</h1>
      <p className="page-sub">
        現行の管理表（器具ごとのExcel）をそのまま取り込めます。ヘッダー行（「売上年月」など）を自動検出し、全器具のデータを一元管理します。
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <Card title="管理表ファイルのアップロード">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" ref={fileRef} accept=".xlsx,.xlsm" />
          <button className="btn" onClick={upload} disabled={busy}>
            {busy ? '取込中...' : '取り込む'}
          </button>
        </div>
        <p className="pt-note" style={{ marginTop: 10 }}>
          対応形式: 現行管理表（A列:売上年月 〜 CI列:最終確定値上金額）。器具ごとに分かれたファイルを順に取り込むと1つの一覧に統合されます。
          取込時に交渉ステータスとマスター単価種別が自動判定されます。
        </p>
      </Card>

      <Card title="取込履歴">
        <table className="tbl">
          <thead>
            <tr><th>#</th><th>ファイル名</th><th className="num">行数</th><th>取込者</th><th>取込日時</th></tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>{b.id}</td>
                <td>{b.filename}</td>
                <td className="num">{b.row_count.toLocaleString()}</td>
                <td>{b.imported_by_name || 'CLI'}</td>
                <td>{b.imported_at}</td>
              </tr>
            ))}
            {batches.length === 0 && (
              <tr><td colSpan={5} style={{ color: 'var(--muted)', textAlign: 'center', padding: 24 }}>取込履歴はありません</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

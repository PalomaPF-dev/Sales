import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';

interface Batch {
  id: number;
  filename: string;
  row_count: number;
  imported_by_name: string | null;
  imported_at: string;
}

export default function ImportPage() {
  const me = useUser();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 同じ内容のファイルは既定で止める。意図的に入れ直すときだけ通す
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canDelete = me.role === 'planning' || me.role === 'admin';

  const load = () => {
    api<Batch[]>('/import/batches').then(setBatches).catch(() => {});
  };
  useEffect(load, []);

  const upload = async (force = false) => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMsg({ kind: 'error', text: 'ファイルを選択してください' });
      return;
    }
    setBusy(true);
    setMsg(null);
    if (!force) setDuplicate(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (force) fd.append('force', 'true');
      const res = await api<{ batchId: number; count: number }>('/import', { method: 'POST', body: fd });
      setMsg({ kind: 'ok', text: `取込完了: ${file.name} → ${res.count.toLocaleString()}行` });
      setDuplicate(null);
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (e) {
      const text = (e as Error).message;
      // 二重取込の警告は、そのまま進めるかどうかを選べるように別枠で出す
      if (/既に取り込まれています/.test(text)) setDuplicate(text);
      else setMsg({ kind: 'error', text });
    } finally {
      setBusy(false);
    }
  };

  const removeBatch = async (b: Batch) => {
    const ok = confirm(
      `取込 #${b.id}（${b.filename} / ${b.row_count.toLocaleString()}行）を取り消します。\n`
      + 'この取込で入った明細はすべて削除されます。よろしいですか？'
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ deleted: number }>(`/import/batches/${b.id}`, { method: 'DELETE' });
      setMsg({ kind: 'ok', text: `取込 #${b.id} を取り消しました（${res.deleted.toLocaleString()}行を削除）` });
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

      {duplicate && (
        <div className="alert error">
          {duplicate}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn secondary sm" onClick={() => setDuplicate(null)}>取り込まない</button>
            <button className="btn danger sm" disabled={busy} onClick={() => upload(true)}>
              それでも取り込む
            </button>
          </div>
        </div>
      )}

      <Card title="管理表ファイルのアップロード">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" ref={fileRef} accept=".xlsx,.xlsm" onChange={() => setDuplicate(null)} />
          <button className="btn" onClick={() => upload(false)} disabled={busy}>
            {busy ? '取込中...' : '取り込む'}
          </button>
        </div>
        <p className="pt-note" style={{ marginTop: 10 }}>
          対応形式: 現行管理表（A列:売上年月 〜 CI列:最終確定値上金額）。器具ごとに分かれたファイルを順に取り込むと1つの一覧に統合されます。
          取込時に交渉ステータスとマスター単価種別が自動判定されます。
        </p>
        <p className="pt-note">
          ※ 同じ内容のファイルを取り込もうとすると警告が出ます（明細が二重になり、値上げ金額が二倍になるため）。
        </p>
        <p className="pt-note">
          ※ 約4MBを超えるファイルはこの画面から取り込めません（サーバー側の受信上限）。
          大きい管理表は管理者がコマンド（<code>npm run import</code>）から投入してください。
        </p>
      </Card>

      <Card title="取込履歴">
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th><th>ファイル名</th><th className="num">行数</th><th>取込者</th><th>取込日時</th>
              {canDelete && <th></th>}
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>{b.id}</td>
                <td>{b.filename}</td>
                <td className="num">{b.row_count.toLocaleString()}</td>
                <td>{b.imported_by_name || 'CLI'}</td>
                <td>{b.imported_at}</td>
                {canDelete && (
                  <td>
                    <button className="btn secondary sm" disabled={busy} onClick={() => removeBatch(b)}>
                      取り消し
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {batches.length === 0 && (
              <tr>
                <td colSpan={canDelete ? 6 : 5} style={{ color: 'var(--muted)', textAlign: 'center', padding: 24 }}>
                  取込履歴はありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

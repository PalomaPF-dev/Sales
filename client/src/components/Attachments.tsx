import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Card } from './ui';
import { useUser } from '../user';

interface Attachment {
  id: number;
  filename: string;
  mime_type: string | null;
  size: number;
  uploaded_at: string;
  uploaded_by_name: string | null;
}

const humanSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** 見積書・稟議書類などの添付。案件・申請のどちらにも付けられる */
export default function Attachments({
  dealId, title = '添付ファイル',
}: { dealId: number; title?: string }) {
  const me = useUser();
  const [rows, setRows] = useState<Attachment[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const query = `dealId=${dealId}`;
  const load = () => {
    api<Attachment[]>(`/attachments?${query}`).then(setRows).catch(() => {});
  };
  useEffect(load, [dealId]);

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
      if (dealId) fd.append('dealId', String(dealId));
      await api('/attachments', { method: 'POST', body: fd });
      if (fileRef.current) fileRef.current.value = '';
      setMsg({ kind: 'ok', text: `${file.name} を添付しました` });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Attachment) => {
    if (!confirm(`${a.filename} を削除しますか？`)) return;
    try {
      await api(`/attachments/${a.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <Card title={`${title}（${rows.length}件）`}>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <input type="file" ref={fileRef} />
        <button className="btn sm" onClick={upload} disabled={busy}>
          {busy ? 'アップロード中...' : '添付する'}
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>1ファイル3MBまで</span>
      </div>

      {rows.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>添付ファイルはありません。</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>ファイル名</th><th className="num">サイズ</th><th>登録者</th><th>登録日時</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  <a href={`/api/attachments/${a.id}/download`} target="_blank" rel="noreferrer">{a.filename}</a>
                </td>
                <td className="num">{humanSize(a.size)}</td>
                <td>{a.uploaded_by_name || '—'}</td>
                <td>{a.uploaded_at?.slice(0, 16).replace('T', ' ')}</td>
                <td>
                  {(['planning', 'admin', 'developer'].includes(me.role) || a.uploaded_by_name === me.name) && (
                    <button className="btn secondary sm" onClick={() => remove(a)}>削除</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

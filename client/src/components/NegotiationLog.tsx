import { useEffect, useState } from 'react';
import { api, yen } from '../api';
import { Card } from './ui';
import { useUser } from '../user';

export interface LogEntry {
  id: number;
  deal_id: number;
  user_id: number | null;
  user_name: string | null;
  contact_date: string | null;
  channel: string | null;
  proposed_price: number | null;
  result: string | null;
  note: string;
  created_at: string;
}

const CHANNELS = ['訪問', '電話', 'メール', 'オンライン', '本部商談', 'その他'];
const RESULTS = ['継続交渉', '合意', '保留', '値上げ不可'];

const RESULT_COLOR: Record<string, string> = {
  合意: 'green',
  継続交渉: 'blue',
  保留: 'yellow',
  値上げ不可: 'red',
};

const today = () => new Date().toISOString().slice(0, 10);

/** 案件詳細に表示する交渉履歴。商談のたびに1件追加していく */
export default function NegotiationLog({ dealId }: { dealId: number }) {
  const me = useUser();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [form, setForm] = useState({
    contact_date: today(), channel: '訪問', proposed_price: '', result: '継続交渉', note: '',
  });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<LogEntry[]>(`/deals/${dealId}/logs`).then(setLogs).catch(() => {});
  };
  useEffect(load, [dealId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.note.trim()) {
      setMsg({ kind: 'error', text: '内容を入力してください' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api(`/deals/${dealId}/logs`, { method: 'POST', body: JSON.stringify(form) });
      setForm({ ...form, proposed_price: '', note: '' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm('この履歴を削除しますか？')) return;
    try {
      await api(`/logs/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <Card title={`交渉履歴（${logs.length}件）`}>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <form onSubmit={add} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <label className="fld">
          商談日
          <input type="date" value={form.contact_date}
            onChange={(e) => setForm({ ...form, contact_date: e.target.value })} />
        </label>
        <label className="fld">
          手段
          <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
            {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="fld">
          提示単価
          <input type="number" style={{ width: 110 }} value={form.proposed_price} placeholder="任意"
            onChange={(e) => setForm({ ...form, proposed_price: e.target.value })} />
        </label>
        <label className="fld">
          結果
          <select value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })}>
            {RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="fld" style={{ flex: 1, minWidth: 260 }}>
          内容
          <input type="text" value={form.note} placeholder="先方の反応・次回の宿題など"
            onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </label>
        <button className="btn" type="submit" disabled={busy}>記録する</button>
      </form>

      {logs.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>
          まだ履歴がありません。商談のたびに記録すると、経緯を後から追えるようになります。
        </p>
      ) : (
        <ol className="timeline">
          {logs.map((l) => (
            <li key={l.id}>
              <div className="timeline-head">
                <strong>{l.contact_date || l.created_at.slice(0, 10)}</strong>
                {l.channel && <span className="badge gray">{l.channel}</span>}
                {l.result && <span className={`badge ${RESULT_COLOR[l.result] || 'gray'}`}>{l.result}</span>}
                {l.proposed_price != null && <span className="badge blue">提示 ¥{yen(l.proposed_price)}</span>}
                <span style={{ flex: 1 }} />
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{l.user_name || '—'}</span>
                {(l.user_id === me.id || me.role === 'planning' || me.role === 'admin') && (
                  <button className="btn secondary sm" onClick={() => remove(l.id)}>削除</button>
                )}
              </div>
              <div className="timeline-body">{l.note}</div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../api';
import { useUser } from '../user';
import type { NegotiationLogEntry } from '../types';

const CHANNELS = ['訪問', '電話', 'メール', '本部商談', 'その他'];
const RESULTS = ['継続交渉', '合意', '保留', '不可'];

/**
 * 法人ごとの交渉履歴。
 * 単価は器種ごとでも交渉そのものは法人（本部）単位で進むため、
 * 履歴も法人に紐づけて記録する。
 */
export default function NegotiationLog({ corpCode, corpName }: { corpCode: string; corpName?: string | null }) {
  const me = useUser();
  const [logs, setLogs] = useState<NegotiationLogEntry[]>([]);
  const [form, setForm] = useState({
    contact_date: new Date().toISOString().slice(0, 10),
    channel: CHANNELS[0],
    result: RESULTS[0],
    note: '',
  });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<NegotiationLogEntry[]>(`/corps/${encodeURIComponent(corpCode)}/logs`)
      .then(setLogs)
      .catch((e) => setMsg(e.message));
  };
  useEffect(load, [corpCode]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.note.trim()) { setMsg('内容を入力してください'); return; }
    setBusy(true);
    setMsg('');
    try {
      await api(`/corps/${encodeURIComponent(corpCode)}/logs`, { method: 'POST', body: JSON.stringify(form) });
      setForm({ ...form, note: '' });
      load();
    } catch (err) {
      setMsg((err as Error).message);
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
      setMsg((err as Error).message);
    }
  };

  return (
    <div className="card">
      <h3>交渉履歴{corpName ? ` — ${corpName}` : ''}（{logs.length}件）</h3>
      {msg && <div className="alert error" onClick={() => setMsg('')}>{msg}</div>}

      <form onSubmit={add} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="fld">
          商談日
          <input type="date" value={form.contact_date}
            onChange={(e) => setForm({ ...form, contact_date: e.target.value })} />
        </label>
        <label className="fld">
          手段
          <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
            {CHANNELS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="fld">
          結果
          <select value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })}>
            {RESULTS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label className="fld" style={{ flex: 1, minWidth: 240 }}>
          内容
          <input type="text" value={form.note} placeholder="先方の反応・次回の宿題など"
            onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </label>
        <button className="btn" type="submit" disabled={busy}>記録する</button>
      </form>

      {logs.length === 0 ? (
        <p className="pt-note" style={{ marginTop: 12 }}>
          まだ履歴がありません。商談のたびに記録すると、経緯を後から追えるようになります。
        </p>
      ) : (
        <ul className="timeline" style={{ marginTop: 14 }}>
          {logs.map((l) => (
            <li key={l.id}>
              <div className="timeline-head">
                <strong>{l.contact_date || String(l.created_at).slice(0, 10)}</strong>
                {l.channel && <span className="badge gray">{l.channel}</span>}
                {l.result && <span className="badge blue">{l.result}</span>}
                <span style={{ color: 'var(--muted)' }}>{l.user_name || '—'}</span>
                {(l.user_id === me.id || me.role === 'planning' || me.role === 'admin') && (
                  <button className="btn secondary sm" style={{ marginLeft: 'auto' }}
                    onClick={() => remove(l.id)}>削除</button>
                )}
              </div>
              <div className="timeline-body">{l.note}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

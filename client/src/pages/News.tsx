import { useEffect, useState } from 'react';
import { api, jstDateTime } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';

/**
 * お知らせ（全員への連絡）。
 *
 * お問い合わせが「一人から本社へ」なのに対して、こちらは「本社から全員へ」。
 * 本社（営業部・製品企画部）と管理者が出すと、全員の画面の上に帯が出て、
 * このページで中身を読める。読むと未読の印が消える。
 */

interface Announcement {
  id: number;
  title: string;
  body: string;
  /** info=お知らせ（青） / important=重要（赤） */
  level: string;
  /** 掲載の終わり（YYYY-MM-DD）。空なら消すまで出し続ける */
  ends_at: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string | null;
  /** 本人が読んだ日時。未読なら null */
  read_at: string | null;
  /** 掲載中か（掲載の終わった分は、出した人にだけ見える） */
  live: boolean;
}

const dt = (s: string | null | undefined) => jstDateTime(s);

/** 今日の日付（掲載の終わりの初期値などに使う） */
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const LEVELS = [
  { key: 'info', label: 'お知らせ', badge: 'blue' },
  { key: 'important', label: '重要', badge: 'red' },
];
const levelOf = (v: string) => LEVELS.find((l) => l.key === v) ?? LEVELS[0];

/** 空の入力欄。出したあとと、書き直しをやめたときに戻す */
const EMPTY = { id: 0, title: '', body: '', level: 'info', endsAt: '' };

export default function News({ onUnreadChange }: { onUnreadChange?: (n: number) => void }) {
  const me = useUser();
  const [rows, setRows] = useState<Announcement[]>([]);
  const [canPost, setCanPost] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<{ rows: Announcement[]; unread: number; canPost: boolean }>('/announcements')
      .then((r) => {
        setRows(r.rows);
        setCanPost(r.canPost);
        onUnreadChange?.(r.unread);
      })
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
  };
  useEffect(load, []);

  /** 出す／書き直す。見出しと本文は必須 */
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const body = JSON.stringify({
      title: draft.title, body: draft.body, level: draft.level, endsAt: draft.endsAt,
    });
    try {
      if (draft.id) {
        await api(`/announcements/${draft.id}`, { method: 'PATCH', body });
        setMsg({ kind: 'ok', text: 'お知らせを書き直しました。' });
      } else {
        await api('/announcements', { method: 'POST', body });
        setMsg({ kind: 'ok', text: 'お知らせを出しました。全員の画面に届きます。' });
      }
      setDraft(EMPTY);
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Announcement) => {
    if (!window.confirm(`「${a.title}」を消します。元に戻せません。よろしいですか？`)) return;
    setBusy(true);
    try {
      await api(`/announcements/${a.id}`, { method: 'DELETE' });
      setMsg({ kind: 'ok', text: 'お知らせを消しました。' });
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      if (draft.id === a.id) setDraft(EMPTY);
      load();
      setBusy(false);
    }
  };

  const markRead = async (id: number) => {
    try {
      await api(`/announcements/${id}/read`, { method: 'POST' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  const readAll = async () => {
    try {
      await api('/announcements/read-all', { method: 'POST' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  const unread = rows.filter((a) => a.live && !a.read_at).length;

  return (
    <div>
      <h1 className="page-title">お知らせ</h1>
      <p className="page-sub">
        本社（営業部・製品企画部）・管理者からの<strong>全員へのお知らせ</strong>です。
        未読があるあいだは、どの画面でも上に帯が出ます。
        {canPost && <>　あなたは<strong>お知らせを出せます</strong>。</>}
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      {/* 出す人だけに見える入力欄。書き直しのときは同じ欄を使う */}
      {canPost && (
        <Card title={draft.id ? 'お知らせを書き直す' : 'お知らせを出す（全員に届きます）'}>
          <form onSubmit={save} style={{ maxWidth: 720 }}>
            <p className="pt-note" style={{ marginTop: 0 }}>
              出す人: <strong>{me.name}</strong>。
              <strong>重要</strong>にすると赤い印が付き、一覧の上に出ます。
              出したあとでも書き直せます。消すと全員の画面から消えます。
            </p>
            <label className="fld" style={{ marginBottom: 12 }}>
              見出し（必須）
              <input value={draft.title} required maxLength={120}
                placeholder="例: 8月の価格調査データを取り込みました"
                onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label className="fld" style={{ marginBottom: 12 }}>
              本文（必須）
              <textarea value={draft.body} rows={5} required maxLength={4000}
                style={{ width: '100%', border: '1px solid var(--baseline)', borderRadius: 9,
                         padding: '9px 11px', font: 'inherit', resize: 'vertical' }}
                placeholder="全員に伝えたいことを書いてください"
                onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <label className="fld">
                重み
                <div className="seg" style={{ marginTop: 4 }}>
                  {LEVELS.map((l) => (
                    <button key={l.key} type="button"
                            className={draft.level === l.key ? 'on' : ''}
                            onClick={() => setDraft({ ...draft, level: l.key })}>
                      {l.label}
                    </button>
                  ))}
                </div>
              </label>
              <label className="fld" title="この日を過ぎると一覧から下がります。空なら消すまで出し続けます">
                掲載の終わり（任意）
                <input type="date" value={draft.endsAt} min={today()}
                  onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" type="submit" disabled={busy}>
                {busy ? '送信中...' : draft.id ? '書き直す' : '全員に知らせる'}
              </button>
              {draft.id > 0 && (
                <button className="btn secondary" type="button" disabled={busy}
                        onClick={() => setDraft(EMPTY)}>
                  やめる
                </button>
              )}
            </div>
          </form>
        </Card>
      )}

      <Card title={`お知らせ${unread > 0 ? `（未読 ${unread}件）` : ''}`}>
        {rows.length === 0 ? (
          <p className="pt-note" style={{ margin: 0 }}>お知らせはありません。</p>
        ) : (
          <>
            {unread > 0 && (
              <div style={{ marginBottom: 10 }}>
                <button className="btn secondary sm" onClick={readAll} disabled={busy}>
                  すべて既読にする（{unread}件）
                </button>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {rows.map((a) => (
                <div key={a.id}
                     style={{ border: !a.read_at && a.live
                       ? '2px solid var(--accent)' : '1px solid var(--border)',
                       borderRadius: 10, padding: 12,
                       opacity: a.live ? 1 : 0.6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
                    <span className={`badge ${levelOf(a.level).badge}`}>{levelOf(a.level).label}</span>
                    {!a.read_at && a.live && <span className="badge red">未読</span>}
                    {!a.live && <span className="badge gray">掲載終了</span>}
                    <strong style={{ fontSize: 14 }}>{a.title}</strong>
                    <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
                      {a.created_by_name ?? ''} ・ {dt(a.created_at)}
                      {a.updated_at && `（${dt(a.updated_at)}に書き直し）`}
                    </span>
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{a.body}</p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    {a.ends_at && (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        掲載の終わり: {a.ends_at}
                      </span>
                    )}
                    {!a.read_at && a.live && (
                      <button className="btn secondary sm" disabled={busy}
                              onClick={() => markRead(a.id)}>
                        確認しました（既読にする）
                      </button>
                    )}
                    {canPost && (
                      <>
                        <button className="btn secondary sm" disabled={busy}
                                style={{ marginLeft: 'auto' }}
                                onClick={() => {
                                  setDraft({ id: a.id, title: a.title, body: a.body,
                                    level: a.level, endsAt: a.ends_at ?? '' });
                                  window.scrollTo({ top: 0, behavior: 'smooth' });
                                }}>
                          書き直す
                        </button>
                        <button className="btn danger sm" disabled={busy}
                                title="このお知らせを全員の画面から消します（元に戻せません）"
                                onClick={() => remove(a)}>
                          消す
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {canPost && (
          <p className="pt-note" style={{ marginTop: 12, marginBottom: 0 }}>
            掲載の終わった分は、出せる人にだけ薄く出しています（ほかの人の画面には出ません）。
          </p>
        )}
      </Card>
    </div>
  );
}

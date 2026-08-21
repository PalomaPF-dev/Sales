import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, jstDateTime } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';

/**
 * お問い合わせ（ポータルと同じ仕様）。
 * ログイン中の利用者が本社（営業企画部）へ問い合わせを送り、回答をここで受け取る。
 * 回答が付くと未読になり、開いて「確認しました」で既読になる。
 *
 * 回答担当者（本社・管理者）には、このページに「届いたお問い合わせ」が出る。
 * 通知メールのリンク（/contact?inquiry=12）から開くと、その1件が開いた状態になる。
 */

interface Inquiry {
  id: number;
  login_id: string | null;
  name: string;
  /** 宛先。app=アプリのこと（管理者へ）／sales=営業本部内のこと（営業企画部へ） */
  dest?: string | null;
  category: string;
  message: string;
  status: 'open' | 'resolved';
  reply: string | null;
  replied_by: string | null;
  replied_at: string | null;
  read_at: string | null;
  created_at: string;
}

/**
 * 宛先と分類（サーバーの INQUIRY_DESTS / INQUIRY_CATEGORIES_BY_DEST と一致させる）。
 * アプリの使い方や不具合は管理者、値決めや交渉の進め方は営業企画部が受ける。
 */
const DESTS = [
  {
    key: 'app',
    label: 'アプリのこと',
    to: '管理者',
    note: 'ログイン・不具合・操作方法・機能の要望など、アプリそのものについて',
    categories: [
      'ログインできない',
      'アプリのエラー・不具合',
      'アカウント・権限（支店／営業所／担当）',
      '操作方法について',
      '機能の要望・改善',
      'その他（アプリ）',
    ],
  },
  {
    key: 'sales',
    label: '営業本部内のこと',
    to: '営業企画部',
    note: '価格・単価、交渉の進め方、取込データの中身など、業務そのものについて',
    categories: [
      '価格・単価について',
      '値上げ交渉の進め方',
      '取込データの内容について',
      '集計・数字の見方',
      'その他（営業本部）',
    ],
  },
];
const destOf = (v: string | null | undefined) =>
  DESTS.find((d) => d.key === v) ?? DESTS[0];

const dt = (s: string | null | undefined) => jstDateTime(s);

/** 回答担当。本社（営業企画部）と管理者。サーバーの INQUIRY_ROLES と揃える */
const INQUIRY_STAFF = ['planning', 'admin', 'developer'];

export default function Contact() {
  const me = useUser();
  const staff = INQUIRY_STAFF.includes(me.role);
  const [params, setParams] = useSearchParams();
  // メールのリンクで指定された問い合わせ（その1件を開いて回答欄を出す）
  const picked = Number(params.get('inquiry') || 0) || null;
  const [inbox, setInbox] = useState<Inquiry[]>([]);
  const [replyDraft, setReplyDraft] = useState<Record<number, string>>({});
  const pickedRef = useRef<HTMLDivElement>(null);
  const [dest, setDest] = useState('app');
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [rows, setRows] = useState<Inquiry[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<{ rows: Inquiry[]; unread: number }>('/inquiries/mine')
      .then((r) => setRows(r.rows))
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
  };
  const loadInbox = () => {
    if (!staff) return;
    api<Inquiry[]>('/inquiries').then(setInbox).catch(() => {});
  };
  useEffect(load, []);
  useEffect(loadInbox, [staff]);

  // 通知メールから開いたときは、その問い合わせまで画面を送る
  useEffect(() => {
    if (picked && inbox.length) pickedRef.current?.scrollIntoView({ block: 'center' });
  }, [picked, inbox.length]);

  /** 回答を送る／対応状態を変える（回答すると本人に未読の知らせが出る） */
  const patchInquiry = async (id: number, body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/inquiries/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setReplyDraft((prev) => ({ ...prev, [id]: '' }));
      if ('reply' in body) setMsg({ kind: 'ok', text: '回答しました。送信者の画面に知らせが出ます。' });
      loadInbox();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('/inquiries', { method: 'POST', body: JSON.stringify({ dest, category, message }) });
      setMsg({ kind: 'ok', text: '送信しました。回答はこのページに届きます。' });
      setCategory('');
      setMessage('');
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 問い合わせを消す。戻せないので、押したときに一度だけ確かめる。
   * 送った本人と、受け持ちの回答担当が消せる。
   */
  const remove = async (id: number) => {
    if (!window.confirm('このお問い合わせを消します。元に戻せません。よろしいですか？')) return;
    setBusy(true);
    try {
      await api(`/inquiries/${id}`, { method: 'DELETE' });
      setMsg({ kind: 'ok', text: 'お問い合わせを消しました。' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const markRead = async (id: number) => {
    try {
      await api(`/inquiries/mine/${id}/read`, { method: 'PATCH' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <div>
      <h1 className="page-title">お問い合わせ</h1>
      <p className="page-sub">
        <strong>アプリのこと</strong>は管理者へ、<strong>営業本部内のこと</strong>は営業企画部へ届きます。
        回答はこのページに届きます。
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      {/* 回答担当者（本社 営業企画部・管理者）だけに出る。届いた問い合わせへの回答 */}
      {staff && (
        <Card title={`届いたお問い合わせ（未対応 ${inbox.filter((q) => q.status === 'open').length}件）`}>
          {inbox.length === 0 ? (
            <p className="pt-note" style={{ margin: 0 }}>届いているお問い合わせはありません。</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {inbox.map((q) => (
                <div key={q.id} ref={q.id === picked ? pickedRef : undefined}
                     style={{ border: q.id === picked ? '2px solid var(--accent)' : '1px solid var(--border)',
                              borderRadius: 10, padding: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
                    <span className="badge violet">{destOf(q.dest).label}</span>
                    <span className="badge blue">{q.category}</span>
                    {q.status === 'resolved'
                      ? <span className="badge green">対応済み</span>
                      : <span className="badge yellow">未対応</span>}
                    <strong>{q.name}</strong>
                    <span style={{ color: 'var(--muted)' }}>{q.login_id ?? 'IDなし'} ・ {dt(q.created_at)}</span>
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{q.message}</p>
                  {q.reply && (
                    <div style={{ marginTop: 10, background: 'var(--accent-soft)', borderRadius: 8, padding: '10px 12px' }}>
                      <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 700 }}>
                        回答済み{q.replied_by ? `（${q.replied_by}）` : ''}
                        {q.replied_at && <span style={{ fontWeight: 400, marginLeft: 8, color: 'var(--muted)' }}>{dt(q.replied_at)}</span>}
                        {!q.read_at && <span className="badge gray" style={{ marginLeft: 8 }}>本人未読</span>}
                      </div>
                      <p style={{ margin: '6px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{q.reply}</p>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <textarea rows={2} value={replyDraft[q.id] ?? ''} disabled={busy}
                      placeholder={q.reply ? '回答を書き直す' : '回答を入力（送信者の画面に届きます）'}
                      style={{ flex: '1 1 320px', minWidth: 220, border: '1px solid var(--baseline)',
                               borderRadius: 9, padding: '8px 10px', font: 'inherit', resize: 'vertical' }}
                      onChange={(e) => setReplyDraft((prev) => ({ ...prev, [q.id]: e.target.value }))} />
                    <button className="btn sm" disabled={busy || !(replyDraft[q.id] ?? '').trim()}
                      onClick={() => patchInquiry(q.id, { reply: (replyDraft[q.id] ?? '').trim() })}>
                      回答する
                    </button>
                    <button className="btn secondary sm" disabled={busy}
                      onClick={() => patchInquiry(q.id, { status: q.status === 'open' ? 'resolved' : 'open' })}>
                      {q.status === 'open' ? '対応済みにする' : '未対応に戻す'}
                    </button>
                    {/* 済んだやり取りを片づける。戻せないので押したときに確かめる */}
                    <button className="btn secondary sm" disabled={busy}
                      title="このお問い合わせを消します（元に戻せません）"
                      onClick={() => remove(q.id)}>
                      消す
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="pt-note" style={{ marginTop: 12 }}>
            ログイン画面から届く「ログインできない」もここに入ります。
            パスワードを忘れた方には、「設定」のユーザー一覧で「PW再設定」を押して未設定に戻し、
            本人にログイン画面の「パスワード設定」から決め直すよう回答してください。
          </p>
          {picked && (
            <p className="pt-note" style={{ marginBottom: 0 }}>
              メールから開いたため、1件を枠で示しています。
              <button className="btn secondary sm" style={{ marginLeft: 8 }}
                onClick={() => { params.delete('inquiry'); setParams(params, { replace: true }); }}>
                すべて表示
              </button>
            </p>
          )}
        </Card>
      )}

      <Card title="お問い合わせを送る">
        <form onSubmit={send} style={{ maxWidth: 640 }}>
          <p className="pt-note" style={{ marginTop: 0 }}>
            送信者: <strong>{me.name}</strong>{me.loginId ? `（${me.loginId}）` : ''}
          </p>
          {/* 宛先。話の中身で届く先が変わるので、いちばん上で選んでもらう */}
          <label className="fld" style={{ marginBottom: 12 }}>
            お問い合わせ先（必須）
            <div className="seg" style={{ marginTop: 4 }}>
              {DESTS.map((d) => (
                <button key={d.key} type="button" title={d.note}
                        className={dest === d.key ? 'on' : ''}
                        onClick={() => { setDest(d.key); setCategory(''); }}>
                  {d.label} → {d.to}
                </button>
              ))}
            </div>
          </label>
          <p className="pt-note" style={{ marginTop: -4 }}>{destOf(dest).note}</p>
          <label className="fld" style={{ marginBottom: 12 }}>
            お問い合わせ分類（必須）
            <select value={category} required onChange={(e) => setCategory(e.target.value)}>
              <option value="" disabled>選択してください</option>
              {destOf(dest).categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="fld" style={{ marginBottom: 14 }}>
            お問い合わせ内容（必須）
            <textarea value={message} rows={5} maxLength={2000} required
              style={{ width: '100%', border: '1px solid var(--baseline)', borderRadius: 9,
                       padding: '9px 11px', font: 'inherit', resize: 'vertical' }}
              placeholder="困っていること・起きたこと・要望などをご記入ください"
              onChange={(e) => setMessage(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? '送信中...' : `${destOf(dest).to}へ送信`}
          </button>
        </form>
      </Card>

      <Card title="お問い合わせ履歴">
        {rows.length === 0 ? (
          <p className="pt-note" style={{ margin: 0 }}>これまでのお問い合わせはありません。</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.map((r) => (
              <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
                  <span className="badge violet">{destOf(r.dest).label}</span>
                  <span className="badge blue">{r.category}</span>
                  {r.status === 'resolved'
                    ? <span className="badge green">対応済み</span>
                    : <span className="badge yellow">対応中</span>}
                  {r.reply && !r.read_at && <span className="badge red">未読の回答</span>}
                  <span style={{ color: 'var(--muted)' }}>{dt(r.created_at)}</span>
                  {/* 済んだやり取りは自分で片づけられる（戻せないので確かめる） */}
                  <button className="btn secondary sm" style={{ marginLeft: 'auto' }} disabled={busy}
                          title="このお問い合わせを履歴から消します（元に戻せません）"
                          onClick={() => remove(r.id)}>
                    消す
                  </button>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{r.message}</p>
                {r.reply && (
                  <div style={{ marginTop: 10, background: 'var(--accent-soft)', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 700 }}>
                      回答{r.replied_by ? `（${r.replied_by}）` : ''}
                      {r.replied_at && <span style={{ fontWeight: 400, marginLeft: 8, color: 'var(--muted)' }}>{dt(r.replied_at)}</span>}
                    </div>
                    <p style={{ margin: '6px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{r.reply}</p>
                    {!r.read_at && (
                      <button className="btn secondary sm" style={{ marginTop: 8 }} onClick={() => markRead(r.id)}>
                        確認しました（既読にする）
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

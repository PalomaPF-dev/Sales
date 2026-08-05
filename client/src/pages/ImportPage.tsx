import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ApiError } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';
import { parseFile, uploadInChunks } from '../importClient';
import type { FieldDef, ParsedFile } from '../importClient';

interface Batch {
  id: number;
  filename: string;
  row_count: number;
  imported_by_name: string | null;
  imported_at: string;
}

interface Warning { column: string; label: string; count: number; samples: string[] }

/** 取込データの点検結果（数字だけになっている名前欄） */
interface Finding { column: string; label: string; param: string; value: string; deals: number }

/**
 * 選んだファイル1つぶんの状態。
 * 複数ファイルをまとめて選べるため、解析・対応づけ・取込の進みを
 * ファイルごとに持ち、他のファイルの失敗に引きずられないようにする。
 */
interface Entry {
  key: number;
  filename: string;
  status: 'parsing' | 'needs-mapping' | 'ready' | 'importing' | 'done' | 'duplicate' | 'error';
  parsed?: ParsedFile;
  mapping: Record<string, number>;
  message?: string;
  result?: { added: number; updated: number; unchanged: number };
  progress?: { sent: number; total: number };
  warnings?: Warning[];
}

const STATUS_LABEL: Record<Entry['status'], { text: string; badge: string }> = {
  'parsing': { text: '読み取り中…', badge: 'gray' },
  'needs-mapping': { text: '列の対応が必要', badge: 'red' },
  'ready': { text: '取込待ち', badge: 'blue' },
  'importing': { text: '取込中…', badge: 'violet' },
  'done': { text: '取込完了', badge: 'green' },
  'duplicate': { text: '二重の疑い', badge: 'yellow' },
  'error': { text: 'エラー', badge: 'red' },
};

export default function ImportPage() {
  const me = useUser();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [chunkRows, setChunkRows] = useState(500);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [showAllFields, setShowAllFields] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canDelete = ['planning', 'admin', 'developer'].includes(me.role);
  const canCheck = me.role === 'admin' || me.role === 'developer';
  const navigate = useNavigate();
  const [findings, setFindings] = useState<Finding[]>([]);

  const load = () => {
    api<Batch[]>('/import/batches').then(setBatches).catch(() => {});
    // 取込のたびに点検し直す（列ズレの値が入ったらすぐ気づけるように）
    if (canCheck) {
      api<{ findings: Finding[] }>('/admin/data-check')
        .then((r) => setFindings(r.findings))
        .catch(() => {});
    }
  };
  useEffect(() => {
    load();
    api<{ fields: FieldDef[]; chunkRows: number }>('/import/fields')
      .then((r) => { setFields(r.fields); setChunkRows(r.chunkRows); })
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, []);

  const patch = (key: number, p: Partial<Entry>) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...p } : e)));
  };

  const missingOf = (mapping: Record<string, number>) =>
    fields.filter((f) => f.required && mapping[f.key] == null);

  const reset = () => {
    setEntries([]);
    setSelectedKey(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // 選んだ時点でブラウザ側で全ファイルを解析し、一覧に状態を出す
  const onPick = async () => {
    const picked = [...(fileRef.current?.files ?? [])];
    setMsg(null);
    if (!picked.length) { reset(); return; }
    setBusy(true);
    const initial: Entry[] = picked.map((f, i) => ({
      key: i, filename: f.name, status: 'parsing', mapping: {},
    }));
    setEntries(initial);
    setSelectedKey(null);

    // 同じ内容のファイルを2回選んでいないかを、送る前に手元で見つける
    const seen = new Map<string, string>(); // dataHash → filename
    const statuses: Entry['status'][] = [];
    for (let i = 0; i < picked.length; i++) {
      try {
        const p = await parseFile(picked[i], fields);
        const dupOf = seen.get(p.dataHash);
        if (dupOf !== undefined) {
          statuses[i] = 'duplicate';
          patch(i, {
            status: 'duplicate', parsed: p, mapping: p.mapping,
            message: `「${dupOf}」と同じ内容です。まとめて取込では飛ばします`,
          });
        } else {
          seen.set(p.dataHash, picked[i].name);
          const st = missingOf(p.mapping).length ? 'needs-mapping' : 'ready';
          statuses[i] = st;
          patch(i, { status: st, parsed: p, mapping: p.mapping });
        }
      } catch (e) {
        statuses[i] = 'error';
        patch(i, { status: 'error', message: (e as Error).message });
      }
    }
    // 直す必要があるファイルがあればそれを、なければ先頭を選んで対応表を出す
    const attention = statuses.findIndex((s) => s === 'needs-mapping');
    setSelectedKey(attention >= 0 ? attention : statuses.length ? 0 : null);
    setBusy(false);
  };

  /** 1ファイルを取り込む。まとめて取込からも、個別の再取込からも使う */
  const runOne = async (
    entry: Entry, force: boolean
  ): Promise<{ status: Entry['status']; added: number; updated: number }> => {
    if (!entry.parsed) return { status: entry.status, added: 0, updated: 0 };
    patch(entry.key, {
      status: 'importing', message: undefined,
      progress: { sent: 0, total: entry.parsed.rows.length },
    });
    try {
      const res = await uploadInChunks(entry.parsed, entry.mapping, {
        force, chunkRows,
        onProgress: (p) => patch(entry.key, { progress: p }),
      });
      patch(entry.key, {
        status: 'done',
        result: { added: res.added, updated: res.updated, unchanged: res.unchanged },
        warnings: res.skipped, progress: undefined,
      });
      return { status: 'done', added: res.added, updated: res.updated };
    } catch (e) {
      const err = e as ApiError;
      const status: Entry['status'] = err.duplicate ? 'duplicate' : 'error';
      patch(entry.key, { status, message: err.message, progress: undefined });
      return { status, added: 0, updated: 0 };
    }
  };

  /** 取込待ちのファイルを順に取り込む。1つの失敗で残りを止めない */
  const runAll = async () => {
    const targets = entries.filter((e) => e.status === 'ready');
    if (!targets.length) return;
    setBusy(true);
    setMsg(null);
    let done = 0, added = 0, updated = 0, dup = 0, err = 0;
    for (const entry of targets) {
      const r = await runOne(entry, false);
      if (r.status === 'done') { done += 1; added += r.added; updated += r.updated; }
      else if (r.status === 'duplicate') dup += 1;
      else err += 1;
    }
    const parts = [`取込完了 ${done}ファイル`];
    if (dup) parts.push(`二重の疑い ${dup}`);
    if (err) parts.push(`エラー ${err}`);
    setMsg({
      kind: err ? 'error' : dup ? 'info' : 'ok',
      text: `${parts.join(' ／ ')}`
        + (done ? `（追加 ${added.toLocaleString()}行 ／ 更新 ${updated.toLocaleString()}行）` : ''),
    });
    setBusy(false);
    load();
    if (fileRef.current) fileRef.current.value = '';
  };

  /** 二重の疑いのファイルを、確認のうえ個別に取り込む */
  const forceOne = async (entry: Entry) => {
    setBusy(true);
    setMsg(null);
    await runOne(entry, true);
    setBusy(false);
    load();
  };

  const removeBatch = async (b: Batch) => {
    const ok = confirm(
      `取込 #${b.id}（${b.filename} / ${b.row_count.toLocaleString()}行）を取り消します。\n`
      + 'この取込で「追加」された明細が削除されます（上書き更新された行は元に戻りません）。よろしいですか？'
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

  const ready = entries.filter((e) => e.status === 'ready');
  const readyRows = ready.reduce((a, e) => a + (e.parsed?.rows.length ?? 0), 0);
  const needFix = entries.filter((e) => e.status === 'needs-mapping');
  const doneWarnings = entries.filter((e) => e.status === 'done' && (e.warnings?.length ?? 0) > 0);

  const selected = entries.find((e) => e.key === selectedKey);
  const canEditMapping = selected && (selected.status === 'ready' || selected.status === 'needs-mapping');
  const missing = selected ? missingOf(selected.mapping) : [];
  const shown = selected
    ? (showAllFields ? fields : fields.filter((f) => f.required || selected.mapping[f.key] != null))
    : [];
  const usedCols = new Set(selected ? Object.values(selected.mapping) : []);
  const ignored = selected?.parsed ? selected.parsed.headers
    .map((h, i) => ({ header: h, index: i }))
    .filter((c) => c.header && !usedCols.has(c.index)) : [];

  return (
    <div>
      <h1 className="page-title">Excel取込</h1>
      <p className="page-sub">
        現行の管理表（器具ごとのExcel）をそのまま取り込めます。
        <strong>複数のファイルをまとめて選べます</strong>（CtrlキーやShiftキーを押しながら選択）。
        見出し行を自動で探し、列の項目名で対応づけます。
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      {doneWarnings.length > 0 && (
        <div className="alert info">
          <strong>数値として読めなかった値がありました（未設定として取り込んでいます）</strong>
          {doneWarnings.map((e) => (
            <div key={e.key} style={{ marginTop: 4, fontSize: 12.5 }}>
              {e.filename}:{' '}
              {(e.warnings ?? []).map((w) => `${w.label} ${w.count.toLocaleString()}件（例: ${w.samples.join(' / ')}）`).join('、')}
            </div>
          ))}
        </div>
      )}

      <Card title="管理表ファイルの取込">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="file" ref={fileRef} multiple
            accept=".xlsx,.xlsm,.xls,.csv" onChange={onPick} disabled={busy}
          />
          {ready.length > 0 && (
            <button className="btn" onClick={runAll} disabled={busy}>
              {busy ? '取込中...' : `${ready.length}ファイル（${readyRows.toLocaleString()}行）をまとめて取り込む`}
            </button>
          )}
          {entries.length > 0 && (
            <button className="btn secondary" onClick={reset} disabled={busy}>選び直す</button>
          )}
        </div>

        {needFix.length > 0 && (
          <div className="alert error" style={{ marginTop: 12 }}>
            列の対応が必要なファイルが {needFix.length} つあります。
            下の一覧で「列の対応」を押して、必須の項目に列を割り当ててください。
            対応しないままだと、そのファイルだけ取込の対象から外れます。
          </div>
        )}

        {entries.length > 0 && (
          <div className="tbl-scroll" style={{ marginTop: 12 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th><th>ファイル名</th><th className="num">行数</th><th>状態</th><th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const s = STATUS_LABEL[e.status];
                  const pct = e.progress && e.progress.total
                    ? Math.round((e.progress.sent / e.progress.total) * 100) : null;
                  return (
                    <tr
                      key={e.key}
                      style={e.key === selectedKey ? { background: 'rgba(59,130,246,.06)' } : undefined}
                    >
                      <td>{e.key + 1}</td>
                      <td>{e.filename}</td>
                      <td className="num">{e.parsed ? e.parsed.rows.length.toLocaleString() : '—'}</td>
                      <td>
                        <span className={`badge ${s.badge}`}>{s.text}</span>
                        {e.status === 'importing' && pct != null && (
                          <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--muted)' }}>
                            {e.progress!.sent.toLocaleString()} / {e.progress!.total.toLocaleString()}行（{pct}%）
                          </span>
                        )}
                        {e.status === 'done' && e.result && (
                          <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--muted)' }}>
                            追加 {e.result.added.toLocaleString()} ／ 更新 {e.result.updated.toLocaleString()}
                            {e.result.unchanged > 0 && ` ／ 変更なし ${e.result.unchanged.toLocaleString()}`}
                          </span>
                        )}
                        {e.message && (
                          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>{e.message}</div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {e.parsed && (e.status === 'ready' || e.status === 'needs-mapping') && (
                          <button className="btn secondary sm" disabled={busy} onClick={() => setSelectedKey(e.key)}>
                            列の対応
                          </button>
                        )}
                        {e.status === 'duplicate' && e.parsed && (
                          <button className="btn danger sm" disabled={busy} onClick={() => forceOne(e)}>
                            それでも取り込む
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="pt-note" style={{ marginTop: 10 }}>
          ファイルはブラウザ側で読み取り、行データだけを{chunkRows}行ずつ順に送ります。
          <strong>ファイルの数や大きさによる上限はありません。</strong>
        </p>
        <p className="pt-note">
          ※ <strong>既に取り込んだ明細（売上伝票NOが同じ行）は上書き更新され、新しい行だけ追加されます。</strong>
          更新しても明細は二重になりません。値がまったく同じ行は書き込みません。
        </p>
        <p className="pt-note">
          ※ 中身が前回とまったく同じファイルは「二重の疑い」で止まります。
          「それでも取り込む」で流せますが、すべて変更なしになるだけです。
        </p>
      </Card>

      {canCheck && findings.length > 0 && (
        <Card title="取込データの点検">
          <div className="alert error" style={{ marginTop: 0 }}>
            名前が入るはずの欄に、数字だけの値が入っている明細があります。
            取込時の列ズレか入力ミスの可能性が高く、絞り込みの選択肢にも紛れ込みます。
          </div>
          <table className="tbl">
            <thead>
              <tr><th>欄</th><th>入っている値</th><th className="num">件数</th><th></th></tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={`${f.column}:${f.value}`}>
                  <td>{f.label}</td>
                  <td><strong>{f.value}</strong></td>
                  <td className="num">{f.deals.toLocaleString()}</td>
                  <td>
                    <button
                      className="btn secondary sm"
                      onClick={() => navigate(`/deals?${f.param}=${encodeURIComponent(f.value)}`)}
                    >
                      該当の案件を見る
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pt-note" style={{ marginTop: 10 }}>
            {me.role === 'developer'
              ? '案件一覧の「入力」か、案件を開いて「取込データの修正」で正しい値に直せます。'
              : '修正には開発者の権限が必要です。開発者アカウントでログインして直してください。'}
            直すべき値が分かっている場合は、修正した管理表を取り込み直しても直せます（伝票NOが同じ行は上書きされます）。
          </p>
        </Card>
      )}

      {selected?.parsed && canEditMapping && (
        <Card title={`列の対応（${selected.filename}／見出しは${selected.parsed.headerRow + 1}行目）`}>
          {missing.length > 0 && (
            <div className="alert error">
              必須の項目が対応づけられていません: {missing.map((f) => f.label).join(' / ')}。
              下の表で、該当する列を選んでください。
            </div>
          )}

          <div className="toolbar" style={{ marginBottom: 10 }}>
            <span className="count">
              自動で対応づけ <b>{Object.keys(selected.mapping).length}</b> 項目 ／
              取り込まない列 <b>{ignored.length}</b>
            </span>
            <div className="grow" />
            <div className="seg">
              <button className={showAllFields ? '' : 'on'} onClick={() => setShowAllFields(false)}>
                対応済み・必須のみ
              </button>
              <button className={showAllFields ? 'on' : ''} onClick={() => setShowAllFields(true)}>
                すべての項目
              </button>
            </div>
          </div>

          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>区分</th>
                  <th>取り込む項目</th>
                  <th>ファイルの列</th>
                  <th>データの例</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => {
                  const idx = selected.mapping[f.key];
                  const sample = idx == null ? [] : selected.parsed!.preview
                    .map((r) => r?.[idx])
                    .filter((v) => v !== null && v !== undefined && String(v) !== '')
                    .slice(0, 2)
                    .map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v)));
                  return (
                    <tr key={f.key}>
                      <td style={{ color: 'var(--muted)' }}>{f.group}</td>
                      <td>
                        {f.label}
                        {f.required && <span className="badge red" style={{ marginLeft: 6 }}>必須</span>}
                      </td>
                      <td>
                        <select
                          value={idx ?? ''}
                          disabled={busy}
                          style={{ minWidth: 220, borderColor: f.required && idx == null ? 'var(--critical)' : undefined }}
                          onChange={(ev) => {
                            const v = ev.target.value;
                            const next = { ...selected.mapping };
                            if (v === '') delete next[f.key];
                            else next[f.key] = Number(v);
                            patch(selected.key, {
                              mapping: next,
                              status: missingOf(next).length ? 'needs-mapping' : 'ready',
                            });
                          }}
                        >
                          <option value="">（取り込まない）</option>
                          {selected.parsed!.headers.map((h, i) => (
                            h ? <option key={i} value={i}>{colName(i)}列: {h}</option> : null
                          ))}
                        </select>
                      </td>
                      <td style={{ color: 'var(--muted)', fontSize: 11.5 }}>{sample.join(' / ') || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {ignored.length > 0 && (
            <p className="pt-note" style={{ marginTop: 12 }}>
              取り込まない列（{ignored.length}）: {ignored.map((c) => c.header).join('、')}
            </p>
          )}
        </Card>
      )}

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

/** 0 → A, 25 → Z, 26 → AA（Excelの列名） */
function colName(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
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

export default function ImportPage() {
  const me = useUser();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [chunkRows, setChunkRows] = useState(500);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [showAllFields, setShowAllFields] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canDelete = me.role === 'planning' || me.role === 'admin';

  const load = () => {
    api<Batch[]>('/import/batches').then(setBatches).catch(() => {});
  };
  useEffect(() => {
    load();
    api<{ fields: FieldDef[]; chunkRows: number }>('/import/fields')
      .then((r) => { setFields(r.fields); setChunkRows(r.chunkRows); })
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, []);

  const reset = () => {
    setParsed(null);
    setMapping({});
    setProgress(null);
    setDuplicate(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // ファイルを選んだ時点でブラウザ側で解析し、列の対応を見せる
  const onPick = async () => {
    const file = fileRef.current?.files?.[0];
    setMsg(null);
    setDuplicate(null);
    setWarnings([]);
    if (!file) { setParsed(null); return; }
    setBusy(true);
    try {
      const p = await parseFile(file, fields);
      setParsed(p);
      setMapping(p.mapping);
    } catch (e) {
      setParsed(null);
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const run = async (force = false) => {
    if (!parsed) return;
    setBusy(true);
    setMsg(null);
    if (!force) setDuplicate(null);
    setProgress({ sent: 0, total: parsed.rows.length });
    try {
      const res = await uploadInChunks(parsed, mapping, {
        force,
        chunkRows,
        onProgress: setProgress,
      });
      setMsg({ kind: 'ok', text: `取込完了: ${parsed.filename} → ${res.count.toLocaleString()}行` });
      setWarnings(res.skipped);
      reset();
      load();
    } catch (e) {
      const text = (e as Error).message;
      if (/既に取り込まれています/.test(text)) setDuplicate(text);
      else setMsg({ kind: 'error', text });
      setProgress(null);
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

  const missing = fields.filter((f) => f.required && mapping[f.key] == null);
  const shown = showAllFields ? fields : fields.filter((f) => f.required || mapping[f.key] != null);
  const usedCols = new Set(Object.values(mapping));
  const ignored = parsed ? parsed.headers
    .map((h, i) => ({ header: h, index: i }))
    .filter((c) => c.header && !usedCols.has(c.index)) : [];

  return (
    <div>
      <h1 className="page-title">Excel取込</h1>
      <p className="page-sub">
        現行の管理表（器具ごとのExcel）をそのまま取り込めます。見出し行を自動で探し、列の項目名で対応づけます。
        列の並びや見出しがファイルごとに違っても、対応づけを直せば取り込めます。
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      {duplicate && (
        <div className="alert error">
          {duplicate}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn secondary sm" onClick={() => setDuplicate(null)}>取り込まない</button>
            <button className="btn danger sm" disabled={busy} onClick={() => run(true)}>それでも取り込む</button>
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="alert info">
          <strong>数値として読めなかった値がありました（未設定として取り込んでいます）</strong>
          {warnings.map((w) => (
            <div key={w.column} style={{ marginTop: 4, fontSize: 12.5 }}>
              {w.label}: {w.count.toLocaleString()}件（例: {w.samples.join(' / ')}）
            </div>
          ))}
        </div>
      )}

      <Card title="管理表ファイルの取込">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" ref={fileRef} accept=".xlsx,.xlsm,.xls,.csv" onChange={onPick} disabled={busy} />
          {parsed && (
            <>
              <button className="btn" onClick={() => run(false)} disabled={busy || missing.length > 0}>
                {busy ? '取込中...' : `${parsed.rows.length.toLocaleString()}行を取り込む`}
              </button>
              <button className="btn secondary" onClick={reset} disabled={busy}>やめる</button>
            </>
          )}
        </div>

        {progress && (
          <div style={{ marginTop: 12 }}>
            <div className="meter" style={{ marginTop: 0 }}>
              <span style={{
                width: `${progress.total ? (progress.sent / progress.total) * 100 : 0}%`,
                background: 'var(--accent)',
              }} />
            </div>
            <p className="pt-note" style={{ marginTop: 6 }}>
              {progress.sent.toLocaleString()} / {progress.total.toLocaleString()}行を送信しました
            </p>
          </div>
        )}

        <p className="pt-note" style={{ marginTop: 10 }}>
          ファイルはブラウザ側で読み取り、行データだけを{chunkRows}行ずつ送ります。
          <strong>ファイルの大きさによる上限はありません。</strong>
        </p>
        <p className="pt-note">
          ※ 同じ内容のファイルを取り込もうとすると警告が出ます（明細が二重になり、値上げ金額が二倍になるため）。
        </p>
      </Card>

      {parsed && (
        <Card title={`列の対応（${parsed.filename}／見出しは${parsed.headerRow + 1}行目）`}>
          {missing.length > 0 && (
            <div className="alert error">
              必須の項目が対応づけられていません: {missing.map((f) => f.label).join(' / ')}。
              下の表で、該当する列を選んでください。
            </div>
          )}

          <div className="toolbar" style={{ marginBottom: 10 }}>
            <span className="count">
              自動で対応づけ <b>{Object.keys(mapping).length}</b> 項目 ／
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
                  const idx = mapping[f.key];
                  const sample = idx == null ? [] : parsed.preview
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
                          style={{ minWidth: 220, borderColor: f.required && idx == null ? 'var(--critical)' : undefined }}
                          onChange={(e) => {
                            const v = e.target.value;
                            setMapping((prev) => {
                              const next = { ...prev };
                              if (v === '') delete next[f.key];
                              else next[f.key] = Number(v);
                              return next;
                            });
                          }}
                        >
                          <option value="">（取り込まない）</option>
                          {parsed.headers.map((h, i) => (
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

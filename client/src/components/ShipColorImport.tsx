import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, jstDateTime } from '../api';
import { Card, nums } from './ui';
import type { ShipBatch, ShipRules, ShipRulesRes } from '../shipColor';
import type { ReferenceParsed, ShipParsed } from '../shipColorClient';

// Excelの部品は大きいので、ファイルを選んだときだけ読み込む
const client = () => import('../shipColorClient');

/** 1回で送る行数。1日ぶん（千数百行）なら1〜2回で送り終わる */
const CHUNK = 1500;

const readBuf = async (file: File) => {
  const { readFileBuffer } = await import('../aggImportClient');
  return readFileBuffer(file);
};

/**
 * 出荷実績の色分けの取込と判定条件。本社（営業部・製品企画部）と管理者が使う。
 *
 * ①色塗り資料（基準価格・先方契約済物件・期間指定）
 * ②毎日の出荷データ（1シート＝1日。色塗り済みのファイルなら色も読む）
 * ③取込済みの日（判定し直す・削除）
 * ④判定条件（まとめシートの条件。画面で直せる）
 */
export default function ShipColorImport({ info, canEdit, onChanged }: {
  info: ShipRulesRes | null;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [batches, setBatches] = useState<ShipBatch[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  const loadBatches = () => {
    api<{ rows: ShipBatch[] }>('/ship-color/batches').then((r) => setBatches(r.rows)).catch(() => {});
  };
  useEffect(loadBatches, []);

  /** 指定した日から後の日を、古い順に判定し直す（後の日は前の日の結果を使うため） */
  const reclassify = async (fromDate = '') => {
    const targets = [...batches]
      .filter((b) => b.status === 'done' && (!fromDate || b.data_date >= fromDate))
      .sort((a, b) => a.data_date.localeCompare(b.data_date));
    if (!targets.length) return;
    setMsg(null);
    try {
      for (let i = 0; i < targets.length; i++) {
        setBusy(`判定し直しています... ${i + 1} / ${targets.length}日（${targets[i].data_date}）`);
        await api(`/ship-color/batches/${targets[i].id}/classify`, { method: 'POST' });
      }
      setMsg({ kind: 'ok', text: `${targets.length}日ぶんを判定し直しました。` });
      loadBatches();
      onChanged();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy('');
    }
  };

  const remove = async (b: ShipBatch) => {
    if (!window.confirm(`${b.data_date} の出荷データ（${b.row_count.toLocaleString()}行）を削除します。よろしいですか？`)) return;
    try {
      await api(`/ship-color/batches/${b.id}`, { method: 'DELETE' });
      loadBatches();
      onChanged();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <div>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}
      {busy && <div className="alert info">{busy}</div>}

      {canEdit && (
        <>
          <ReferenceCard info={info} onDone={(t) => { setMsg({ kind: 'ok', text: t }); onChanged(); }} />
          <ShipImportCard
            info={info}
            importedDates={new Set(batches.filter((b) => b.status === 'done').map((b) => b.data_date))}
            onDone={(t) => { setMsg({ kind: 'ok', text: t }); loadBatches(); onChanged(); }}
            onError={(t) => { setMsg({ kind: 'error', text: t }); loadBatches(); }} />
        </>
      )}

      <Card title="取込済みの出荷データ">
        {batches.length === 0 ? (
          <p className="pt-note" style={{ marginTop: 0 }}>まだ取り込まれていません。</p>
        ) : (
          <>
            {canEdit && (
              <div className="toolbar">
                <span className="pt-note" style={{ margin: 0 }}>
                  判定条件・基準価格を直したときや、明細で区分を手で直したあとは判定し直してください
                  （後の日は前の日の結果を「過去の色塗り」として使うため、古い日から順に判定します）。
                </span>
                <span className="grow" />
                <button className="btn sm" disabled={!!busy} onClick={() => reclassify()}>
                  すべての日を判定し直す
                </button>
              </div>
            )}
            <div className="tbl-scroll">
              <table className="tbl nowrap">
                <thead>
                  <tr>
                    <th>データの日付</th><th>売上日</th><th>ファイル / シート</th>
                    <th className="num">行数</th><th className="num">色つき</th>
                    <th>取込</th><th>判定</th>{canEdit && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <strong>{b.data_date}</strong>
                        {b.status !== 'done' && <span className="badge orange" style={{ marginLeft: 6 }}>取込途中</span>}
                      </td>
                      <td>{b.min_sale && b.min_sale !== b.max_sale ? `${b.min_sale}〜${b.max_sale}` : (b.max_sale ?? '—')}</td>
                      <td>{b.filename}<span className="sub2">{b.sheet}</span></td>
                      <td className="num">{b.row_count.toLocaleString()}</td>
                      <td className="num">{b.colored_count ? b.colored_count.toLocaleString() : '—'}</td>
                      <td>{jstDateTime(b.taken_at)}<span className="sub2">{b.taken_by_name}</span></td>
                      <td>{b.classified_at ? jstDateTime(b.classified_at) : '—'}</td>
                      {canEdit && (
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn secondary sm" disabled={!!busy || b.status !== 'done'}
                                    title="この日と、これより後の日を判定し直します"
                                    onClick={() => reclassify(b.data_date)}>ここから判定し直す</button>
                            <button className="btn secondary sm" disabled={!!busy} onClick={() => remove(b)}>削除</button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <RulesCard info={info} canEdit={canEdit} onSaved={(t) => { setMsg({ kind: 'ok', text: t }); onChanged(); }} />
    </div>
  );
}

/** ① 色塗り資料（基準価格・先方契約済物件・期間指定）の取込 */
function ReferenceCard({ info, onDone }: { info: ShipRulesRes | null; onDone: (text: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ p: ReferenceParsed; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const pick = async () => {
    const file = fileRef.current?.files?.[0];
    setParsed(null);
    setErr('');
    if (!file) return;
    setBusy(true);
    try {
      const p = (await client()).parseReferenceWorkbook(await readBuf(file));
      if (!p.basePrices && !p.contracts && !p.periodCustomers) {
        throw new Error('「基準価格」「先方契約済物件」「期間指定」のシートが見つかりません');
      }
      setParsed({ p, name: file.name });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!parsed) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ basePrices?: number; contracts?: number; periodCustomers?: number }>(
        '/ship-color/reference', {
          method: 'POST',
          body: JSON.stringify({
            ...(parsed.p.basePrices ? { basePrices: parsed.p.basePrices } : {}),
            ...(parsed.p.contracts ? { contracts: parsed.p.contracts } : {}),
            ...(parsed.p.periodCustomers ? { periodCustomers: parsed.p.periodCustomers } : {}),
          }),
        });
      setParsed(null);
      if (fileRef.current) fileRef.current.value = '';
      onDone([
        r.basePrices != null && `基準価格 ${r.basePrices.toLocaleString()}件`,
        r.contracts != null && `先方契約済物件 ${r.contracts.toLocaleString()}件`,
        r.periodCustomers != null && `期間指定 ${r.periodCustomers.toLocaleString()}件`,
      ].filter(Boolean).join('・') + 'を取り込みました。取込済みの日に反映するには「判定し直す」を押してください。');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const r = info?.rules;
  return (
    <Card title="① 判定条件のファイル（色塗り資料）">
      <p className="pt-note" style={{ marginTop: 0 }}>
        色塗り資料の <strong>「基準価格」「先方契約済物件」「期間指定」</strong> のシートを読み取ります。
        入っているシートだけ置き換わります（無いシートは今のまま）。
        先方契約済物件は、<strong>iZの見積リスト</strong>（「見積伝票番号」の列があるファイル）からも取り込めます。
        その場合は見積伝票番号の一覧だけが置き換わります。
        期間指定の「9月末まで」などの書き込みは、下の行へ引き継いで期限の日付にします。
      </p>
      <div className="kv" style={{ marginBottom: 10 }}>
        <span>基準価格</span>
        <span>{info ? `${info.basePrices.count.toLocaleString()}件` : '—'}
          {info?.basePrices.updatedAt && <span className="pt-note">（{jstDateTime(info.basePrices.updatedAt)} 取込）</span>}</span>
        <span>先方契約済物件</span><span>{r ? `${r.contractQuotes.length.toLocaleString()}件` : '—'}</span>
        <span>期間指定</span><span>{r ? `${r.periodCustomers.length.toLocaleString()}件` : '—'}</span>
      </div>
      <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls" onChange={pick} disabled={busy} />
      {err && <div className="alert error" style={{ marginTop: 10 }}>{err}</div>}
      {parsed && (
        <div style={{ marginTop: 12 }}>
          <table className="tbl" style={{ maxWidth: 520 }}>
            <tbody>
              <tr><td>基準価格</td><td className="num">{parsed.p.basePrices ? `${parsed.p.basePrices.length.toLocaleString()}行` : '（シートなし）'}</td></tr>
              <tr><td>先方契約済物件</td><td className="num">{parsed.p.contracts ? `${parsed.p.contracts.length.toLocaleString()}件` : '（シートなし）'}</td></tr>
              <tr><td>期間指定</td><td className="num">{parsed.p.periodCustomers ? `${parsed.p.periodCustomers.length.toLocaleString()}件` : '（シートなし）'}</td></tr>
            </tbody>
          </table>
          {parsed.p.periodCustomers && (
            <p className="pt-note">
              期間指定の期限：{[...new Set(parsed.p.periodCustomers.map((x) => x.until || '期限なし'))].join('・')}
            </p>
          )}
          <button className="btn" style={{ marginTop: 8 }} disabled={busy} onClick={run}>
            {busy ? '取込中...' : `${parsed.name} を取り込む`}
          </button>
        </div>
      )}
    </Card>
  );
}

/** ② 毎日の出荷データの取込 */
function ShipImportCard({ info, importedDates, onDone, onError }: {
  info: ShipRulesRes | null;
  importedDates: Set<string>;
  onDone: (text: string) => void;
  onError: (text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ p: ShipParsed; name: string } | null>(null);
  const [pickDays, setPickDays] = useState<Set<string>>(new Set());
  const [useColors, setUseColors] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState('');
  const targets = info?.rules.targetCategories ?? [];

  const pick = async () => {
    const file = fileRef.current?.files?.[0];
    setParsed(null);
    setErr('');
    if (!file) return;
    setBusy(true);
    setProgress('ファイルを読み取っています...（1か月分のファイルは数十秒かかることがあります）');
    try {
      await new Promise((r) => setTimeout(r, 50));
      const p = (await client()).parseShipWorkbook(await readBuf(file), {
        fileName: file.name, targetCategories: targets,
      });
      setParsed({ p, name: file.name });
      // まだ取り込んでいない日だけを選んでおく（月全体のファイルを毎日取り込む運用のため）。
      // 取込済みの日も、選び直せば取り込み直せる
      setPickDays(new Set(p.sheets.filter((s) => !importedDates.has(s.dataDate)).map((s) => s.key)));
      setUseColors(p.sheets.some((s) => s.colored > 0));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const run = async () => {
    if (!parsed) return;
    const days = parsed.p.sheets.filter((s) => pickDays.has(s.key));
    setBusy(true);
    setErr('');
    const done: string[] = [];
    try {
      for (let d = 0; d < days.length; d++) {
        const s = days[d];
        const head = `${s.dataDate}（${d + 1} / ${days.length}日）`;
        setProgress(`${head}を取り込んでいます...`);
        const { batchId } = await api<{ batchId: number }>('/ship-color/import/start', {
          method: 'POST',
          body: JSON.stringify({ filename: parsed.name, sheet: s.sheet, dataDate: s.dataDate }),
        });
        const rows = useColors ? s.rows : s.rows.map((r) => ({ ...r, file_cat: '' }));
        for (let i = 0; i < rows.length; i += CHUNK) {
          setProgress(`${head} ${Math.min(i + CHUNK, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}行を送信中...`);
          await api(`/ship-color/import/${batchId}/rows`, {
            method: 'POST', body: JSON.stringify({ rows: rows.slice(i, i + CHUNK) }),
          });
        }
        setProgress(`${head}を判定しています...`);
        const r = await api<{ rows: number; counts: Record<string, number>; replaced: number }>(
          `/ship-color/import/${batchId}/finish`, { method: 'POST' });
        done.push(`${s.dataDate}（${r.rows.toLocaleString()}行${r.replaced ? '・置き換え' : ''}）`);
      }
      setParsed(null);
      if (fileRef.current) fileRef.current.value = '';
      onDone(`出荷データを取り込み、判定しました：${done.join('、')}`);
    } catch (e) {
      onError(`${(e as Error).message}${done.length ? `（取り込めた日：${done.join('、')}）` : ''}`);
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const p = parsed?.p;
  const colored = p?.sheets.some((s) => s.colored > 0);
  const pickedRows = p ? p.sheets.filter((s) => pickDays.has(s.key)).reduce((n, s) => n + s.rows.length, 0) : 0;
  const setAll = (keys: string[]) => setPickDays(new Set(keys));
  return (
    <Card title="② 出荷データ（MBの出荷明細）">
      <p className="pt-note" style={{ marginTop: 0 }}>
        MBからダウンロードした出荷明細を取り込むと、判定条件に沿って自動で区分けします。
        <strong>1か月分が1シートに入ったファイル</strong>も、<strong>日ごとにシートを分けたファイル</strong>も取り込めます。
        どちらも<strong>売上日ごとに分けて</strong>、古い日から1日ずつ取り込みます（前の日の結果を「過去の色塗り」として次の日の判定に使うため）。
        <br />
        判定の対象は、カテゴリー名大が <strong>{targets.length ? targets.join('・') : 'すべて'}</strong> の明細だけです
        （ロードヒーター・ビルトインなどは取り込みません。対象は判定条件で変えられます）。
        同じ日を取り込み直すと置き換わり、画面で手で決めた区分は残ります。原価・粗利の列は取り込みません。
        <br />
        手作業で<strong>色塗りした後のファイル</strong>（過去色塗り表など）は、出荷単価のセルの色を区分として読み取ります。
        Excel（.xlsx）のほか、CSVも読めます。
      </p>
      <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={pick} disabled={busy} />
      {progress && <div className="alert info" style={{ marginTop: 10 }}>{progress}</div>}
      {err && <div className="alert error" style={{ marginTop: 10 }}>{err}</div>}
      {p && (
        <div style={{ marginTop: 12 }}>
          {p.brokenSlips > 0 && (
            <div className="alert error">
              売上伝票NOが「2.6E+11」のように崩れている明細が {p.brokenSlips.toLocaleString()}行 あります。
              CSVをExcelで開いて保存し直すと、こうなります。取り込みはできます（中身から明細を見分けます）が、
              手で決めた区分を取り込み直しで引き継ぐため、<strong>MBからダウンロードしたままのファイル</strong>を使ってください。
            </div>
          )}
          <p className="pt-note" style={{ marginTop: 0 }}>
            対象の明細 {p.sheets.reduce((n, s) => n + s.rows.length, 0).toLocaleString()}行（売上日 {p.sheets[0].dataDate}〜{p.sheets[p.sheets.length - 1].dataDate}、{p.sheets.length}日）
            {p.otherSkipped > 0 && (
              <>。対象外のカテゴリーで読み飛ばした明細 {p.otherSkipped.toLocaleString()}行
                （{Object.entries(p.otherCats).sort((a, b) => b[1] - a[1]).slice(0, 6)
                  .map(([k, n]) => `${k} ${n.toLocaleString()}`).join('・')}{Object.keys(p.otherCats).length > 6 ? ' ほか' : ''}）</>
            )}
            {p.noDate > 0 && `。売上日が無く読み飛ばした明細 ${p.noDate.toLocaleString()}行`}
          </p>
          <div className="toolbar" style={{ marginBottom: 8 }}>
            <button className="btn secondary sm" disabled={busy}
                    onClick={() => setAll(p.sheets.filter((s) => !importedDates.has(s.dataDate)).map((s) => s.key))}>
              まだ取り込んでいない日だけ
            </button>
            <button className="btn secondary sm" disabled={busy} onClick={() => setAll(p.sheets.map((s) => s.key))}>
              すべての日
            </button>
            <button className="btn secondary sm" disabled={busy} onClick={() => setAll([])}>選択を外す</button>
          </div>
          <div className="tbl-scroll" style={{ maxHeight: 360 }}>
            <table className="tbl nowrap" style={{ maxWidth: 760 }}>
              <thead>
                <tr>
                  <th></th><th>売上日</th><th>状態</th><th>シート</th>
                  <th className="num">行数</th><th className="num">色つき</th>
                </tr>
              </thead>
              <tbody>
                {p.sheets.map((s) => (
                  <tr key={s.key}>
                    <td>
                      <input type="checkbox" checked={pickDays.has(s.key)} disabled={busy}
                             onChange={(e) => setPickDays((cur) => {
                               const next = new Set(cur);
                               if (e.target.checked) next.add(s.key); else next.delete(s.key);
                               return next;
                             })} />
                    </td>
                    <td><strong>{s.dataDate}</strong></td>
                    <td>{importedDates.has(s.dataDate)
                      ? <span className="badge gray">取込済み（選ぶと置き換え）</span>
                      : <span className="badge blue">未取込</span>}</td>
                    <td>{s.sheet}</td>
                    <td style={nums}>{s.rows.length.toLocaleString()}</td>
                    <td style={nums}>{s.colored ? s.colored.toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.ignored.length > 0 && (
            <p className="pt-note">見出しが無いため読まなかったシート：{p.ignored.join('、')}</p>
          )}
          {colored && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0', fontSize: 13 }}>
              <input type="checkbox" checked={useColors} disabled={busy} onChange={(e) => setUseColors(e.target.checked)} />
              ファイルの色を区分として使う（色塗り済みのファイル。自動判定より優先します）
            </label>
          )}
          {pickDays.size === 0 && (
            <p className="pt-note">取り込む日が選ばれていません（すべて取込済みです）。取り込み直す日を選んでください。</p>
          )}
          <button className="btn" style={{ marginTop: 8 }} disabled={busy || pickDays.size === 0} onClick={run}>
            {busy ? '取込中...' : `選んだ ${pickDays.size}日（${pickedRows.toLocaleString()}行）を取り込む`}
          </button>
        </div>
      )}
    </Card>
  );
}

/** 1行に1つの一覧 ⇔ テキスト */
const linesOf = (v: string[]) => v.join('\n');
const listOf = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
/** 「コード, 期限, 名前」の一覧 ⇔ テキスト */
const codeLines = (v: { code: string; name: string; until: string }[]) =>
  v.map((x) => [x.code, x.until, x.name].join(', ')).join('\n');
const codeListOf = (s: string) => listOf(s).map((line) => {
  const [code = '', until = '', ...rest] = line.split(/[,，\t]/).map((x) => x.trim());
  return { code, until, name: rest.join(' ') };
});

/** 判定条件の1段。描画のたびに作り直すと入力中の欄が外れるため、外に置く */
function Step({ no, title, children }: { no: string; title: string; children: ReactNode }) {
  return (
    <div style={{ borderTop: '1px solid var(--grid)', padding: '12px 0' }}>
      <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>{no}. {title}</div>
      {children}
    </div>
  );
}

/** ④ 判定条件（色塗り資料のまとめシート） */
function RulesCard({ info, canEdit, onSaved }: {
  info: ShipRulesRes | null; canEdit: boolean; onSaved: (text: string) => void;
}) {
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const toForm = (r: ShipRules) => ({
    targetCategories: linesOf(r.targetCategories ?? []),
    excludeCorps: linesOf(r.excludeCorps),
    pinkCorps: linesOf(r.pinkCorps),
    pinkPrefixes: linesOf(r.pinkPrefixes),
    pinkExcept: linesOf(r.pinkExcept),
    pinkSuffixes: linesOf(r.pinkSuffixes),
    greenCorpCodes: codeLines(r.greenCorpCodes),
    periodCustomers: codeLines(r.periodCustomers),
    orderCutoff: r.orderCutoff,
    historyFrom: r.historyFrom ?? '',
    kettleCategory: r.kettleCategory,
    grayKeywords: linesOf(r.grayKeywords),
    grayModels: linesOf(r.grayModels),
    grayPrefixes: linesOf(r.grayPrefixes),
    contractQuotes: linesOf(r.contractQuotes),
  });
  useEffect(() => { if (info) setForm(toForm(info.rules)); }, [info]);

  if (!info || !form) return null;
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('/ship-color/rules', {
        method: 'PUT',
        body: JSON.stringify({
          rules: {
            targetCategories: listOf(form.targetCategories),
            excludeCorps: listOf(form.excludeCorps),
            pinkCorps: listOf(form.pinkCorps),
            pinkPrefixes: listOf(form.pinkPrefixes),
            pinkExcept: listOf(form.pinkExcept),
            pinkSuffixes: listOf(form.pinkSuffixes),
            greenCorpCodes: codeListOf(form.greenCorpCodes),
            periodCustomers: codeListOf(form.periodCustomers),
            orderCutoff: form.orderCutoff,
            historyFrom: form.historyFrom,
            kettleCategory: form.kettleCategory,
            grayKeywords: listOf(form.grayKeywords),
            grayModels: listOf(form.grayModels),
            grayPrefixes: listOf(form.grayPrefixes),
            contractQuotes: listOf(form.contractQuotes),
          },
        }),
      });
      onSaved('判定条件を保存しました。取込済みの日に反映するには「判定し直す」を押してください。');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const area = (k: string, rows = 3, placeholder = '') => (
    <textarea value={form[k]} onChange={set(k)} rows={rows} readOnly={!canEdit} placeholder={placeholder}
              style={{ width: '100%', fontSize: 13, fontFamily: 'inherit' }} />
  );
  const two = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 } as const;
  const lbl = (t: string) => <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{t}</span>;

  return (
    <Card title={canEdit ? '④ 判定条件（色塗り資料のまとめシート）' : '判定条件（色塗り資料のまとめシート）'}>
      <p className="pt-note" style={{ marginTop: 0 }}>
        上から順に当てはめ、原則として後の条件では上書きしません（7だけは例外的に上書きします）。
        どれにも当たらない行は「未判定（目視確認）」になり、明細の画面で区分を選べます。
        一覧は<strong>1行に1つ</strong>。表記の全角・半角（㈱と(株)、＋と+など）と空白の違いは無視して比べます。
      </p>
      <Step no="0" title="判定の対象にするカテゴリー（カテゴリー名大）">
        {area('targetCategories', 4)}
        <p className="pt-note" style={{ margin: 0 }}>
          ここにあるカテゴリーの明細だけを取り込みます（MBの月全体のファイルに入っているロードヒーター・ビルトインなどは読み飛ばします）。
          空にするとすべて取り込みます。
        </p>
      </Step>
      <Step no="1" title="対象外にする法人名（輸出など）">{area('excludeCorps', 2)}</Step>
      <Step no="2" title="基準価格との比較（値上済・水色）">
        <p className="pt-note" style={{ margin: 0 }}>
          器種コードと基準価格シートの商品コード（中5桁）が一致し、出荷単価が基準価格（Q列）以上なら値上済。
          基準価格は ① のファイルから取り込みます（いま {info.basePrices.count.toLocaleString()}件）。
        </p>
      </Step>
      <Step no="3" title="特定条件（値上単価未締結・ピンク）">
        <div style={two}>
          <label>{lbl('法人名')}{area('pinkCorps')}</label>
          <label>{lbl('器種名の先頭')}{area('pinkPrefixes')}</label>
          <label>{lbl('先頭の条件から除く器種名')}{area('pinkExcept')}</label>
          <label>{lbl('器種名の末尾')}{area('pinkSuffixes')}</label>
        </div>
      </Step>
      <Step no="4" title="先方契約済物件（見積伝票番号・黄色）">
        {area('contractQuotes', 4)}
        <p className="pt-note" style={{ margin: 0 }}>{listOf(form.contractQuotes).length.toLocaleString()}件。① のファイルからまとめて入れ替えられます。</p>
      </Step>
      <Step no="5" title="過去の色塗り（得意先・納入先・器種・ガス・出荷単価がすべて一致）">
        <p className="pt-note" style={{ margin: 0 }}>
          前の日までに取り込んだ出荷データの区分（手で決めた区分・ファイルの色・自動判定）を引き継ぎます。
          過去色塗り表は ② から取り込めます（出荷単価のセルの色を読みます）。
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 6 }}>
          売上日が
          <input type="date" value={form.historyFrom} onChange={set('historyFrom')} readOnly={!canEdit} />
          以降の出荷データを「過去の色塗り」に使う（条件5・7。空欄はすべて）
        </label>
      </Step>
      <Step no="6" title="特定コード・期間指定（受注分・緑）">
        <p className="pt-note" style={{ marginTop: 0 }}>
          1行に「コード, 期限（YYYY-MM-DD。空欄は期限なし）, 名前」。期限は受注日で見ます（売上日では見ません。期限があって受注日が無い行は当てず、未判定にします）。
        </p>
        <div style={two}>
          <label>{lbl('法人コード（出荷明細のB列）')}{area('greenCorpCodes', 3, 'M0817, , アイエスジー')}</label>
          <label>{lbl('期間指定（得意先コード）')}{area('periodCustomers', 5, 'T02187350, 2026-09-30, ㈱ＴＯＫＡＩ福島支店')}</label>
        </div>
      </Step>
      <Step no="7" title="過去の最大単価を上回る（値上済・水色。例外的に上書き）">
        <p className="pt-note" style={{ margin: 0 }}>
          得意先・納入先・器種・ガスが一致する過去の出荷データの最大単価を上回れば値上済にします。
        </p>
      </Step>
      <Step no="8" title="受注日による判定（受注分・緑）">
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          受注日が
          <input type="date" value={form.orderCutoff} onChange={set('orderCutoff')} readOnly={!canEdit} />
          以前なら受注分
        </label>
      </Step>
      <Step no="9" title="特殊条件">
        <div style={two}>
          <label>{lbl('9-1. 黄色を色なしに戻すカテゴリー（カテゴリー名大）')}
            <input type="text" value={form.kettleCategory} onChange={set('kettleCategory')} readOnly={!canEdit} />
          </label>
          <label>{lbl('9-2. 器種名に含まれたら その他（灰色）')}{area('grayKeywords')}</label>
          <label>{lbl('9-3. 対象機種（器種名が一致）')}{area('grayModels', 4)}</label>
          <label>{lbl('9-3. 対象機種（器種名の先頭）')}{area('grayPrefixes')}</label>
        </div>
      </Step>
      {err && <div className="alert error">{err}</div>}
      {canEdit && (
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" disabled={busy} onClick={save}>{busy ? '保存中...' : '判定条件を保存'}</button>
          <button className="btn secondary" disabled={busy} onClick={() => setForm(toForm(info.rules))}>元に戻す</button>
        </div>
      )}
    </Card>
  );
}

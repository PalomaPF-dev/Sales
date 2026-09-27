import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Card, nums } from '../components/ui';
import ShipColorImport from '../components/ShipColorImport';
import { useUser } from '../user';
import { SOURCE_LABELS, allCategories } from '../shipColor';
import type { ShipCategory, ShipRulesRes } from '../shipColor';

/** 集計のまとめ方 */
const GROUPS = [
  { key: 'cat_large', label: 'カテゴリー別', head: 'カテゴリー' },
  { key: 'equip', label: '器具区分別', head: '器具区分' },
  { key: 'branch', label: '支店別', head: '支店' },
  { key: 'corp', label: '法人別', head: '法人' },
  { key: 'day', label: '日別', head: '売上日' },
] as const;
type Group = typeof GROUPS[number]['key'];

const METRICS = [
  { key: 'n', label: '件数' },
  { key: 'qty', label: '数量' },
  { key: 'amount', label: '出荷金額' },
] as const;
type Metric = typeof METRICS[number]['key'];

interface Agg { cat: string; n: number; qty: number | null; amount: number | null }
interface SummaryRes {
  group: Group;
  totals: Agg[];
  cross: (Agg & { name: string })[];
  sources: { source: string; n: number }[];
  range: { min_sale: string | null; max_sale: string | null; last_data: string | null } | null;
}

interface ShipRowView {
  id: number; slip_no: string; sale_date: string | null; order_date: string | null;
  corp_code: string | null; corp_name: string | null;
  customer_code: string | null; customer_name: string | null;
  delivery_code: string | null; delivery_name: string | null;
  equip_name: string | null; cat_large: string | null;
  model_code: string | null; gas_code: string | null; model_name: string | null; gas_type: string | null;
  qty: number | null; price: number | null; amount: number | null; quote_no: string | null;
  branch: string | null; office: string | null; person: string | null;
  file_cat: string | null; auto_cat: string | null; auto_rule: string | null;
  manual_cat: string | null; manual_by: string | null; manual_at: string | null;
  cat: string; source: string; base_price: number | null; data_date: string;
}

const HQ = ['planning', 'admin', 'developer'];
const PAGE = 100;
const val = (a: Agg | undefined, m: Metric) => Number(a?.[m] ?? 0);
const fmt = (v: number) => Math.round(v).toLocaleString();
const pctOf = (v: number, total: number) => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '—');

/** 月初（YYYY-MM-01） */
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;

/**
 * 出荷実績（色分け）。
 *
 * 毎日の出荷データを、これまでExcelで色塗りしていた区分
 * （値上済・受注分・先方契約済物件リスト分・値上単価未締結・非ポジ/長期在庫・その他）
 * に自動で分けて集計する。判定に当たらなかった行は「未判定（目視確認）」として
 * 明細に残し、本社が区分を選ぶ。
 *
 * 既存の案件一覧・ダッシュボード（価格調査・売上高の実績）とは別の見方で、
 * そちらの数字には影響しない。
 */
export default function ShipColor() {
  const me = useUser();
  const canEdit = HQ.includes(me.role);
  const [tab, setTab] = useState<'summary' | 'rows' | 'import'>('summary');
  const [info, setInfo] = useState<ShipRulesRes | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [group, setGroup] = useState<Group>('cat_large');
  const [metric, setMetric] = useState<Metric>('amount');
  const [summary, setSummary] = useState<SummaryRes | null>(null);
  const [inited, setInited] = useState(false);
  const [reload, setReload] = useState(0);
  // 明細の絞り込み（集計の表から開いたときは、まとめ方の値と区分が入る）
  const [rowFilter, setRowFilter] = useState<{ group?: Group; name?: string; cat?: string }>({});

  const loadInfo = () => api<ShipRulesRes>('/ship-color/rules').then(setInfo).catch(() => {});
  useEffect(() => { loadInfo(); }, []);

  const cats = useMemo(() => allCategories(info?.categories ?? []), [info]);
  const catOf = useCallback((k: string): ShipCategory =>
    cats.find((c) => c.key === k) ?? { key: k, label: k, color: '#fff' }, [cats]);

  // 最初は「最新のデータの月（月初〜最新日）」を出す
  useEffect(() => {
    api<SummaryRes>('/ship-color/summary?group=cat_large')
      .then((r) => {
        const max = r.range?.max_sale;
        if (max) { setFrom(monthStart(max)); setTo(max); }
        setInited(true);
      })
      .catch(() => setInited(true));
  }, [reload]);

  useEffect(() => {
    if (!inited) return;
    const qs = new URLSearchParams({ group, ...(from ? { from } : {}), ...(to ? { to } : {}) });
    api<SummaryRes>(`/ship-color/summary?${qs}`).then(setSummary).catch(() => setSummary(null));
  }, [inited, from, to, group, reload]);

  const onChanged = () => { loadInfo(); setReload((k) => k + 1); };

  const range = summary?.range;
  const presets = range?.max_sale ? [
    { label: '最新の日', f: range.max_sale, t: range.max_sale },
    { label: '当月（最新の月）', f: monthStart(range.max_sale), t: range.max_sale },
    { label: 'すべて', f: '', t: '' },
  ] : [];

  const openRows = (f: { group?: Group; name?: string; cat?: string }) => {
    setRowFilter(f);
    setTab('rows');
  };

  return (
    <div>
      <h1 className="page-title">出荷実績（色分け）</h1>
      <p className="page-sub">
        毎日の出荷データ（MBの出荷明細）を、これまでExcelで色塗りしていた区分に<strong>自動で分けて</strong>集計します。
        判定条件は色塗り資料（まとめシート）と同じです。条件に当たらなかった行は
        <strong>「未判定（目視確認）」</strong>として明細に残るので、そこだけ確認して区分を選んでください。
        案件一覧・ダッシュボードの数字には影響しません。
      </p>

      <div className="toolbar">
        <div className="seg">
          <button className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>集計</button>
          <button className={tab === 'rows' ? 'on' : ''} onClick={() => setTab('rows')}>明細</button>
          <button className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')}>
            {canEdit ? '取込・判定条件' : '判定条件'}
          </button>
        </div>
      </div>

      {tab !== 'import' && (
        <div className="filters">
          <label className="fld">
            <span>売上日（から）</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="fld">
            <span>売上日（まで）</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {presets.map((p) => (
              <button key={p.label} className="btn secondary sm"
                      onClick={() => { setFrom(p.f); setTo(p.t); }}>{p.label}</button>
            ))}
          </div>
          {range?.last_data && (
            <span className="pt-note" style={{ margin: 0 }}>
              取込済み：売上日 {range.min_sale}〜{range.max_sale}
            </span>
          )}
        </div>
      )}

      {tab === 'summary' && (
        <SummaryView summary={summary} cats={cats}
                     group={group} setGroup={setGroup} metric={metric} setMetric={setMetric}
                     onOpen={openRows} onImport={() => setTab('import')} canEdit={canEdit} />
      )}
      {tab === 'rows' && (
        <RowsView from={from} to={to} filter={rowFilter} setFilter={setRowFilter}
                  cats={cats} catOf={catOf} info={info} canEdit={canEdit} reload={reload}
                  onChanged={() => setReload((k) => k + 1)} />
      )}
      {tab === 'import' && <ShipColorImport info={info} canEdit={canEdit} onChanged={onChanged} />}
    </div>
  );
}

/** 集計。区分ごとのタイルと、まとめ方 × 区分の表 */
function SummaryView({ summary, cats, group, setGroup, metric, setMetric, onOpen, onImport, canEdit }: {
  summary: SummaryRes | null;
  cats: ShipCategory[];
  group: Group; setGroup: (g: Group) => void;
  metric: Metric; setMetric: (m: Metric) => void;
  onOpen: (f: { group?: Group; name?: string; cat?: string }) => void;
  onImport: () => void;
  canEdit: boolean;
}) {
  if (!summary) return <p style={{ color: 'var(--muted)' }}>読み込み中...</p>;
  if (!summary.range?.max_sale) {
    return (
      <Card title="まだ出荷データがありません">
        <p className="pt-note" style={{ marginTop: 0 }}>
          {canEdit ? '「取込・判定条件」から、色塗り資料（判定条件）と毎日の出荷データを取り込んでください。'
            : '本社が出荷データを取り込むと、ここに区分ごとの集計が出ます。'}
        </p>
        {canEdit && <button className="btn" onClick={onImport}>取込へ</button>}
      </Card>
    );
  }

  const byCat = new Map(summary.totals.map((t) => [t.cat, t]));
  // 対象外（輸出）は構成比の分母に入れない
  const target = summary.totals.filter((t) => t.cat !== 'excluded');
  const totalOf = (m: Metric) => target.reduce((s, t) => s + val(t, m), 0);
  const shown = cats.filter((c) => byCat.has(c.key));
  const colCats = cats.filter((c) => c.key !== 'excluded' && summary.cross.some((x) => x.cat === c.key));

  // まとめ方ごとの行
  const names = new Map<string, Map<string, Agg>>();
  for (const x of summary.cross) {
    if (x.cat === 'excluded') continue;
    if (!names.has(x.name)) names.set(x.name, new Map());
    names.get(x.name)!.set(x.cat, x);
  }
  const rowTotal = (m: Map<string, Agg>) => [...m.values()].reduce((s, a) => s + val(a, metric), 0);
  const rows = [...names.entries()].sort((a, b) => (group === 'day'
    ? b[0].localeCompare(a[0])
    : rowTotal(b[1]) - rowTotal(a[1]) || a[0].localeCompare(b[0], 'ja')));
  const unset = byCat.get('unset');
  const manual = summary.sources.find((s) => s.source === 'manual')?.n ?? 0;
  const head = GROUPS.find((g) => g.key === group)!.head;

  return (
    <>
      {unset && unset.n > 0 && (
        <div className="alert info" style={{ cursor: 'pointer' }} onClick={() => onOpen({ cat: 'unset' })}>
          <strong>未判定（目視確認）が {unset.n.toLocaleString()}件</strong> あります。
          ここを押すと明細を開きます{canEdit ? '（区分を選ぶと、次の日からの判定にも使われます）' : ''}。
        </div>
      )}
      <div className="tiles">
        {shown.map((c) => {
          const a = byCat.get(c.key);
          return (
            <div key={c.key} className="tile" style={{ borderLeft: `6px solid ${c.color === '#FFFFFF' ? '#cccccc' : c.color}`, cursor: 'pointer' }}
                 onClick={() => onOpen({ cat: c.key })} title="押すと明細を開きます">
              <div className="label">{c.label}</div>
              <div className="value">{fmt(val(a, metric))}<small> {metric === 'n' ? '件' : metric === 'qty' ? '台' : '円'}</small></div>
              <div className="delta">
                {c.key === 'excluded' ? '構成比の対象外'
                  : `構成比 ${pctOf(val(a, metric), totalOf(metric))}`}
                {metric !== 'n' && `・${fmt(val(a, 'n'))}件`}
              </div>
            </div>
          );
        })}
      </div>

      <Card>
        <div className="toolbar">
          <div className="seg">
            {GROUPS.map((g) => (
              <button key={g.key} className={group === g.key ? 'on' : ''} onClick={() => setGroup(g.key)}>{g.label}</button>
            ))}
          </div>
          <span className="grow" />
          <div className="seg">
            {METRICS.map((m) => (
              <button key={m.key} className={metric === m.key ? 'on' : ''} onClick={() => setMetric(m.key)}>{m.label}</button>
            ))}
          </div>
        </div>
        <div className="legend">
          {colCats.map((c) => (
            <span key={c.key}><i style={{ background: c.color, border: '1px solid #ccc' }} />{c.label}</span>
          ))}
        </div>
        <div className="tbl-scroll" style={{ maxHeight: 620 }}>
          <table className="tbl nowrap">
            <thead>
              <tr>
                <th>{head}</th>
                <th style={{ minWidth: 160 }}>構成</th>
                {colCats.map((c) => (
                  <th key={c.key} className="num" style={{ borderTop: `4px solid ${c.color === '#FFFFFF' ? '#cccccc' : c.color}` }}>{c.label}</th>
                ))}
                <th className="num">合計</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, m]) => {
                const tot = rowTotal(m);
                return (
                  <tr key={name}>
                    <td><strong>{name || '(空白)'}</strong></td>
                    <td>
                      <div style={{ display: 'flex', height: 12, borderRadius: 3, overflow: 'hidden', background: '#f3f3f3' }}>
                        {colCats.map((c) => {
                          const v = val(m.get(c.key), metric);
                          return v > 0 && tot > 0 ? (
                            <span key={c.key} title={`${c.label} ${pctOf(v, tot)}`}
                                  style={{ width: `${(v / tot) * 100}%`, background: c.color === '#FFFFFF' ? '#e0e0e0' : c.color }} />
                          ) : null;
                        })}
                      </div>
                    </td>
                    {colCats.map((c) => {
                      const v = val(m.get(c.key), metric);
                      return (
                        <td key={c.key} className="num" style={{ cursor: v ? 'pointer' : undefined }}
                            onClick={() => v && onOpen({ group, name: name || '(空白)', cat: c.key })}>
                          {v ? fmt(v) : <span style={{ color: '#ccc' }}>—</span>}
                          {v > 0 && <span className="sub2">{pctOf(v, tot)}</span>}
                        </td>
                      );
                    })}
                    <td className="num" style={{ cursor: 'pointer' }}
                        onClick={() => onOpen({ group, name: name || '(空白)' })}><strong>{fmt(tot)}</strong></td>
                  </tr>
                );
              })}
              <tr style={{ background: '#fafafa' }}>
                <td><strong>合計</strong></td>
                <td />
                {colCats.map((c) => (
                  <td key={c.key} className="num"><strong>{fmt(val(byCat.get(c.key), metric))}</strong>
                    <span className="sub2">{pctOf(val(byCat.get(c.key), metric), totalOf(metric))}</span></td>
                ))}
                <td className="num"><strong>{fmt(totalOf(metric))}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="pt-note">
          数字を押すとその明細を開きます。輸出（対象外）は表と構成比に含めません。
          {manual > 0 && ` 手で区分を決めた明細 ${manual.toLocaleString()}件を含みます。`}
        </p>
      </Card>
    </>
  );
}

/** 明細。区分・判定理由の確認と、目視確認の結果（区分）の入力 */
function RowsView({ from, to, filter, setFilter, cats, catOf, info, canEdit, reload, onChanged }: {
  from: string; to: string;
  filter: { group?: Group; name?: string; cat?: string };
  setFilter: (f: { group?: Group; name?: string; cat?: string }) => void;
  cats: ShipCategory[];
  catOf: (k: string) => ShipCategory;
  info: ShipRulesRes | null;
  canEdit: boolean;
  reload: number;
  onChanged: () => void;
}) {
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [source, setSource] = useState('');
  const [rule, setRule] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: ShipRowView[] } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const [exporting, setExporting] = useState(false);
  const [tick, setTick] = useState(0);

  const params = useCallback((extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (filter.cat) p.set('cat', filter.cat);
    if (filter.group && filter.name != null) { p.set('group', filter.group); p.set('name', filter.name); }
    if (q) p.set('q', q);
    if (source) p.set('source', source);
    if (rule) p.set('rule', rule);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }, [from, to, filter, q, source, rule]);

  useEffect(() => { setPage(1); }, [from, to, filter, q, source, rule]);
  useEffect(() => {
    api<{ total: number; rows: ShipRowView[] }>(`/ship-color/rows?${params({ page: String(page), size: String(PAGE) })}`)
      .then((r) => { setData(r); setChecked(new Set()); })
      .catch((e) => setErr((e as Error).message));
  }, [params, page, reload, tick]);

  const setCat = async (slips: string[], category: string) => {
    setErr('');
    try {
      await api('/ship-color/overrides', { method: 'PUT', body: JSON.stringify({ slips, category: category || null }) });
      setTick((t) => t + 1);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const exportXlsx = async () => {
    setExporting(true);
    setErr('');
    try {
      const all: ShipRowView[] = [];
      for (let p = 1; ; p++) {
        const r = await api<{ total: number; rows: ShipRowView[] }>(`/ship-color/rows?${params({ page: String(p), size: '5000' })}`);
        all.push(...r.rows);
        if (all.length >= r.total || !r.rows.length) break;
      }
      const XLSX = await import('xlsx');
      const labels = info?.ruleLabels ?? {};
      const aoa = [[
        '区分', '判定', '判定理由', '自動判定', '売上日', '受注日', '法人コード', '法人名', '得意先コード', '得意先名',
        '納入先コード', '納入先名', '器具区分名', 'カテゴリー名大', '器種コード', 'ガスコード', '器種名', 'ガス種',
        '出荷数', '出荷単価', '出荷金額', '基準価格', '見積伝票番号', '売上伝票NO', '売上担当者支店名', '売上担当者営業所名', '売上担当者名',
      ], ...all.map((r) => [
        catOf(r.cat).label, SOURCE_LABELS[r.source] ?? r.source, r.auto_rule ? (labels[r.auto_rule] ?? r.auto_rule) : '',
        r.auto_cat ? catOf(r.auto_cat).label : '未判定',
        r.sale_date, r.order_date, r.corp_code, r.corp_name, r.customer_code, r.customer_name,
        r.delivery_code, r.delivery_name, r.equip_name, r.cat_large, r.model_code, r.gas_code, r.model_name, r.gas_type,
        r.qty, r.price, r.amount, r.base_price, r.quote_no, r.slip_no, r.branch, r.office, r.person,
      ])];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '出荷実績（色分け）');
      const buf: ArrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });
      // 案件一覧の書き出しと同じ渡し方（ファイル名が日本語でもそのまま付くように）
      const url = URL.createObjectURL(new Blob([buf],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `出荷実績_色分け_${from || '最初'}_${to || '最新'}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const rows = data?.rows ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const ruleLabels = info?.ruleLabels ?? {};
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.slip_no));
  const groupHead = GROUPS.find((g) => g.key === filter.group)?.head;

  return (
    <>
      <div className="filters">
        <label className="fld">
          <span>区分</span>
          <select value={filter.cat ?? ''} onChange={(e) => setFilter({ ...filter, cat: e.target.value || undefined })}>
            <option value="">すべて</option>
            {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>判定の元</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">すべて</option>
            {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>判定理由（自動）</span>
          <select value={rule} onChange={(e) => setRule(e.target.value)}>
            <option value="">すべて</option>
            {Object.entries(ruleLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="fld" style={{ flex: 1, minWidth: 200 }}>
          <span>検索（法人・得意先・納入先・器種・伝票番号）</span>
          <input type="text" value={qInput} onChange={(e) => setQInput(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') setQ(qInput.trim()); }}
                 onBlur={() => setQ(qInput.trim())} placeholder="Enterで検索" />
        </label>
        {filter.group && filter.name != null && (
          <span className="badge blue" style={{ cursor: 'pointer', alignSelf: 'center' }}
                onClick={() => setFilter({ cat: filter.cat })} title="押すと外します">
            {groupHead}：{filter.name} ✕
          </span>
        )}
      </div>

      {err && <div className="alert error" onClick={() => setErr('')}>{err}</div>}

      <div className="toolbar">
        <span className="count"><b>{(data?.total ?? 0).toLocaleString()}</b>件</span>
        {canEdit && checked.size > 0 && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            選んだ {checked.size}件を
            <select defaultValue="" onChange={(e) => {
              const v = e.target.value;
              e.target.value = '';
              if (v) void setCat([...checked], v === '-' ? '' : v);
            }}>
              <option value="">区分を選ぶ...</option>
              {cats.filter((c) => c.key !== 'unset' && c.key !== 'excluded').map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              <option value="-">手動の指定を外す</option>
            </select>
          </label>
        )}
        <span className="grow" />
        <button className="btn secondary sm" disabled={exporting || !data?.total} onClick={exportXlsx}>
          {exporting ? '書き出し中...' : 'Excelに書き出す'}
        </button>
      </div>

      <div className="card tbl-scroll" style={{ maxHeight: 700 }}>
        <table className="tbl nowrap">
          <thead>
            <tr>
              {canEdit && (
                <th>
                  <input type="checkbox" checked={allChecked}
                         onChange={(e) => setChecked(e.target.checked ? new Set(rows.map((r) => r.slip_no)) : new Set())} />
                </th>
              )}
              <th>区分</th><th>判定</th><th>売上日</th><th>受注日</th><th>法人</th><th>得意先 / 納入先</th>
              <th>器種名</th><th className="num">数量</th><th className="num">出荷単価</th><th className="num">基準価格</th>
              <th>見積伝票</th><th>支店</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = catOf(r.cat);
              return (
                <tr key={r.id}>
                  {canEdit && (
                    <td>
                      <input type="checkbox" checked={checked.has(r.slip_no)}
                             onChange={(e) => {
                               const next = new Set(checked);
                               if (e.target.checked) next.add(r.slip_no); else next.delete(r.slip_no);
                               setChecked(next);
                             }} />
                    </td>
                  )}
                  <td>
                    {canEdit ? (
                      <select value={r.manual_cat ?? ''} style={{ background: c.color, fontSize: 12.5, padding: '4px 6px' }}
                              onChange={(e) => void setCat([r.slip_no], e.target.value)}
                              title={r.manual_cat ? `手動で指定（${r.manual_by ?? ''}）` : 'ここで選ぶと手動で区分を決められます'}>
                        <option value="">{r.manual_cat ? '（手動の指定を外す）' : `${c.label}`}</option>
                        {cats.filter((x) => x.key !== 'unset' && x.key !== 'excluded').map((x) => (
                          <option key={x.key} value={x.key}>{x.label}{r.manual_cat === x.key ? '（手動）' : ''}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="badge" style={{ background: c.color, color: '#333', borderColor: '#ddd' }}>{c.label}</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${r.source === 'manual' ? 'violet' : r.source === 'file' ? 'blue' : 'gray'}`}>
                      {SOURCE_LABELS[r.source] ?? r.source}
                    </span>
                    <span className="sub2">
                      {r.auto_rule ? (ruleLabels[r.auto_rule] ?? r.auto_rule) : '条件に当たらず'}
                      {r.source !== 'auto' && `（自動：${r.auto_cat ? catOf(r.auto_cat).label : '未判定'}）`}
                    </span>
                  </td>
                  <td>{r.sale_date}</td>
                  <td>{r.order_date || '—'}</td>
                  <td>{r.corp_name}<span className="sub2">{r.corp_code}</span></td>
                  <td>{r.customer_name}<span className="sub2">{r.delivery_name}</span></td>
                  <td>{r.model_name}<span className="sub2">{r.model_code}-{r.gas_code} {r.cat_large}</span></td>
                  <td style={nums}>{r.qty?.toLocaleString()}</td>
                  <td style={{ ...nums, background: c.color, fontWeight: 700 }}>{r.price?.toLocaleString()}</td>
                  <td style={nums}>
                    {r.base_price != null ? r.base_price.toLocaleString() : <span style={{ color: '#ccc' }}>—</span>}
                  </td>
                  <td>{r.quote_no || '—'}</td>
                  <td>{r.branch}<span className="sub2">{r.office}</span></td>
                </tr>
              );
            })}
            {data && rows.length === 0 && (
              <tr><td colSpan={canEdit ? 13 : 12} style={{ color: 'var(--muted)' }}>該当する明細はありません。</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <button className="btn secondary sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>前へ</button>
        <span>{page} / {pages}ページ</span>
        <button className="btn secondary sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>次へ</button>
      </div>
    </>
  );
}

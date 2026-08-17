import * as XLSX from 'xlsx';
import { api } from './api';

/**
 * 出荷実績（月別履歴）の取込。案件一覧の土台になる。
 *
 * 法人グループ×品目の単位で、期間全体の平均出荷単価と数量合計を取り込み、
 * その単位で案件の行を作る。マスタ登録（A基準）はあとから重ねる。
 */

export interface HistRow {
  ent_cd: string;
  corp_name: string;
  model_code: string;
  model_name: string;
  equip_name: string;
  avg_price: unknown;
  qty: unknown;
}

export interface HistParsed {
  corps: [string, string][];   // [法人グループコード, 法人名]
  rows: HistRow[];
  period: string;              // 例: 2025/07〜2026/06
  months: number;              // 対象の月数（数量の月平均を出すのに使う）
  skippedBlank: number;        // 法人名が空で取り込まなかった行
}

/**
 * 法人名が実質「空」かどうか。
 *
 * 実績ファイルは集計ソフトの出力で、法人グループが付いていない行は
 * コードも名前も「(空白)」という文字で入ってくる。空文字と同じ扱いにする。
 */
const BLANK_CORP = /^[（(]?\s*(空白|blank)\s*[)）]?$|^[-－―ー\s]+$/i;
export const isBlankCorp = (s: string): boolean => !s.trim() || BLANK_CORP.test(s.trim());

export async function parseHistFile(file: File): Promise<HistParsed> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (grid.length < 3) throw new Error('シートにデータがありません');

  // 月の見出しは同じ月が複数列（平均単価と売上数など）に付くため、重複を除いて数える。
  // そのまま数えると月数が2倍になり、「月あたり」の金額が半分に出てしまう
  const months = [...new Set(
    (grid[0] ?? []).map((v) => String(v ?? '')).filter((v) => /^\d{4}\/\d{2}$/.test(v))
  )].sort();
  const row0 = (grid[0] ?? []).map((v) => String(v ?? ''));
  const heads = (grid[1] ?? []).map((v) => String(v ?? ''));
  const cd = heads.findIndex((h) => h === 'i_ent_gr_cd');
  const nameCol = heads.findIndex((h) => h.includes('店コードマスタ'));
  const equipCol = heads.findIndex((h) => h.includes('器具区分'));
  const prod = heads.findIndex((h) => h === 'i_product_cd');
  const prodName = heads.findIndex((h) => h === 'i_product_name');
  const totalAvg = row0.findIndex((h) => h.includes('全体') && h.includes('平均単価'));
  const totalQty = row0.findIndex((h) => h.includes('全体') && h.includes('売上数'));

  // 「全体」の列が無い形式（月ごとの 平均単価・売上数 のペアだけ）にも対応する。
  // その場合は月ごとの値から、数量の合計と数量で重み付けした平均単価を計算する
  const monthPairs: { price: number; qty: number }[] = [];
  if (totalAvg < 0 || totalQty < 0) {
    for (let i = 0; i < heads.length - 1; i++) {
      if (!/^\d{4}\/\d{2}$/.test(row0[i] ?? '')) continue;
      if (heads[i] === '平均単価' && heads[i + 1] === '売上数') {
        monthPairs.push({ price: i, qty: i + 1 });
      }
    }
  }
  if (cd < 0 || nameCol < 0 || prod < 0 || ((totalAvg < 0 || totalQty < 0) && !monthPairs.length)) {
    throw new Error('見出しが見つかりません。i_ent_gr_cd・i_product_cd と、'
      + '「全体の 平均単価/売上数」または月ごとの「平均単価/売上数」のあるファイルが必要です');
  }

  const corps = new Map<string, string>();
  const rows: HistRow[] = [];
  const seen = new Set<string>();
  let skippedBlank = 0;
  for (let i = 2; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const code = String(r[cd] ?? '').trim();
    const product = String(r[prod] ?? '').trim();
    if (!code || !product) continue;
    const corpName = String(r[nameCol] ?? '').trim();
    // 法人名が空・「(空白)」の行は取り込まない（一覧で行き先の分からない行になるため）
    if (isBlankCorp(corpName) || isBlankCorp(code)) { skippedBlank += 1; continue; }
    if (!corps.has(code)) corps.set(code, corpName);
    const key = `${code}|${product}`;
    if (seen.has(key)) continue;   // 同じ法人×品目が重複していたら最初の行を使う
    seen.add(key);

    // 実績（平均単価・数量）。「全体」列があればそのまま、
    // 無い形式では月ごとの値から合計と加重平均を計算する
    let avgPrice: unknown;
    let qty: unknown;
    if (totalAvg >= 0 && totalQty >= 0) {
      avgPrice = r[totalAvg];
      qty = r[totalQty];
    } else {
      let qtySum = 0;        // 数量の合計（単価の無い月の数量も含める）
      let weightedQty = 0;   // 加重平均の分母（単価と数量が揃っている月だけ）
      let amount = 0;        // Σ 単価×数量
      let has = false;
      for (const mp of monthPairs) {
        const q = Number(r[mp.qty] ?? NaN);
        const p = Number(r[mp.price] ?? NaN);
        if (Number.isFinite(q) && q !== 0) {
          qtySum += q;
          has = true;
          if (Number.isFinite(p)) { weightedQty += q; amount += p * q; }
        }
      }
      qty = has ? qtySum : null;
      avgPrice = weightedQty > 0 ? amount / weightedQty : null;
    }

    rows.push({
      ent_cd: code,
      corp_name: corpName,
      model_code: product,
      model_name: String(r[prodName] ?? '').trim(),
      equip_name: equipCol >= 0 ? String(r[equipCol] ?? '').trim() : '',
      avg_price: avgPrice,
      qty,
    });
  }
  if (!rows.length) throw new Error('取り込める行がありません');
  const period = months.length ? `${months[0]}〜${months[months.length - 1]}` : '';
  return { corps: [...corps.entries()], rows, period, months: months.length, skippedBlank };
}

const CHUNK = 500;

export interface HistResult {
  rows: number;      // 送って取り込んだ行
  removed: number;   // 今回の実績に無くなって消えた行
  total: number;     // 案件の総数
}

export async function sendHistImport(
  parsed: HistParsed,
  filename: string,
  onProgress?: (done: number, total: number) => void
): Promise<HistResult> {
  const { batch } = await api<{ batch: string }>('/hist-import/start', {
    method: 'POST',
    body: JSON.stringify({
      filename, period: parsed.period, months: parsed.months, corps: parsed.corps,
    }),
  });
  let sent = 0;
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    const r = await api<{ rows: number }>('/hist-import/chunk', {
      method: 'POST',
      body: JSON.stringify({ batch, rows: parsed.rows.slice(i, i + CHUNK) }),
    });
    sent += r.rows;
    onProgress?.(Math.min(i + CHUNK, parsed.rows.length), parsed.rows.length);
  }
  const fin = await api<{ removed: number; total: number }>('/hist-import/finish', {
    method: 'POST', body: JSON.stringify({ batch }),
  });
  return { rows: sent, removed: fin.removed, total: fin.total };
}

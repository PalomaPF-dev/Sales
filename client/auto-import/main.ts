/**
 * 自動取込（社内PCで動かすスクリプト）。
 *
 * 社内の共有フォルダに置かれた 出荷明細・売上高（日次・月次）のファイルを、
 * 画面と同じ読み取りコードで読み、画面と同じ取込のAPIへ送る。
 * Windowsのタスクスケジューラで平日の昼に動かす想定（使い方は README.md）。
 *
 *   node auto-import.mjs            取り込む
 *   node auto-import.mjs --check    取り込まずに、つながるか・何を取り込むかだけ見る
 *   node auto-import.mjs --config <設定ファイル>
 *
 * 取り込んだファイルは中身のハッシュで覚えておき（auto-import.state.json）、
 * 同じ中身のファイルは二度取り込まない。結果はアプリへ送り、管理者へメールで知らせる。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, connect, type Connection } from './nodeApi';
import { parseShipWorkbook, sendShipDays, type ShipSheet } from '../src/shipColorClient';
import {
  parseSurveyFile, sendSurveyImport, type SurveyMode, type SurveyParsed,
} from '../src/surveyImportClient';
import { dataDateOf } from '../src/planMonths';

/** 組み立てた日と版（build.mjs が埋め込む）。古いスクリプトが動いていないかを見分けるため */
declare const __AUTO_IMPORT_VERSION__: string;
const VERSION = typeof __AUTO_IMPORT_VERSION__ === 'string' ? __AUTO_IMPORT_VERSION__ : 'dev';

type Kind = 'ship' | 'salesDaily' | 'salesMonthly';

interface Config extends Connection {
  /** 見に行く共有フォルダ。無い種類は取り込まない */
  folders?: Partial<Record<Kind, string>>;
  /** always … 毎回メールで知らせる（既定） / error … 取り込めなかったときだけ */
  notify?: 'always' | 'error';
  /** これより古い（更新日が前の）ファイルは見ない。初回に過去のファイルをまとめて取り込まないため */
  lookbackDays?: number;
}

/** 読むファイルの種類。画面で選べるものと同じ */
const EXT: Record<Kind, RegExp> = {
  ship: /\.(xlsx|xlsm|xls|csv)$/i,
  salesDaily: /\.(xlsx|xlsm)$/i,
  salesMonthly: /\.(xlsx|xlsm)$/i,
};

interface Candidate {
  kind: Kind;
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  sha: string;
  buf?: Buffer;
}

interface State {
  /** 取り込み済みのファイル（「種類:中身のハッシュ」→ ファイル名・取り込んだ日時） */
  done: Record<string, { name: string; at: string }>;
  /** ハッシュの控え（パス → 大きさ・更新日時・ハッシュ）。毎回ファイルを読み直さないため */
  seen: Record<string, { size: number; mtimeMs: number; sha: string }>;
}

// ───────── 小物 ─────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;
const p2 = (n: number) => String(n).padStart(2, '0');
/** 日本時間の日付（YYYY-MM-DD） */
const jstDay = (ms = Date.now()) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const jstStamp = () => new Date(Date.now() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
/** 「2026-10-09」→「10/9」 */
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const monthEnd = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${p2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};
const n = (v: number) => Math.round(v).toLocaleString('ja-JP');
const msgOf = (e: unknown) => (e as Error)?.message ?? String(e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Nodeの Buffer を、画面のコードが受け取る ArrayBuffer にする */
const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

let logFile = '';
function log(msg: string) {
  const line = `[${jstStamp()}] ${msg}`;
  console.log(line);
  if (!logFile) return;
  try { appendFileSync(logFile, line + os.EOL, 'utf8'); } catch { /* ログが書けなくても取込は続ける */ }
}

/** 実行1回ぶんの結果。最後にアプリへ送ってメールにする */
const report = { lines: [] as string[], errors: [] as string[] };
const line = (t: string) => { report.lines.push(t); log(t); };
const fail = (t: string) => { report.errors.push(t); log(`エラー: ${t}`); };

// ───────── 設定・記録 ─────────

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadConfig(file: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`設定ファイルが見つかりません: ${file}`
      + '（auto-import.config.example.json をコピーして auto-import.config.json を作ってください）');
  }
  let cfg: Config;
  try {
    cfg = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`設定ファイルの書き方が正しくありません（${msgOf(e)}）。`
      + 'フォルダの「\\」は「\\\\」と2つ重ねて書いてください');
  }
  // 鍵は環境変数でも渡せる（設定ファイルに書きたくないとき）
  if (process.env.AUTO_IMPORT_KEY) cfg.key = process.env.AUTO_IMPORT_KEY;
  if (!/^https?:\/\//.test(String(cfg.appUrl ?? ''))) throw new Error('設定ファイルの appUrl（アプリのURL）を入れてください');
  if (!String(cfg.key ?? '').trim() || /ここに/.test(cfg.key)) throw new Error('設定ファイルの key（自動取込の鍵）を入れてください');
  const folders = Object.entries(cfg.folders ?? {}).filter(([, v]) => String(v ?? '').trim() && !/ここに/.test(String(v)));
  if (!folders.length) throw new Error('設定ファイルの folders に、見に行くフォルダを1つ以上入れてください');
  cfg.folders = Object.fromEntries(folders);
  return cfg;
}

async function loadState(file: string): Promise<State> {
  try {
    const s = JSON.parse(await readFile(file, 'utf8')) as Partial<State>;
    return { done: s.done ?? {}, seen: s.seen ?? {} };
  } catch {
    return { done: {}, seen: {} };
  }
}

async function saveState(file: string, s: State) {
  // 古い記録は落とす（ファイルが増え続けないように）
  const old = Date.now() - 400 * DAY_MS;
  for (const [k, v] of Object.entries(s.done)) if (Date.parse(v.at) < old) delete s.done[k];
  for (const [k, v] of Object.entries(s.seen)) if (v.mtimeMs < old) delete s.seen[k];
  // 書いている途中で止まっても記録が壊れないよう、別名で書いてから置き換える
  await writeFile(`${file}.tmp`, JSON.stringify(s, null, 1), 'utf8');
  await rename(`${file}.tmp`, file);
}

// ───────── フォルダ ─────────

/** フォルダのファイル（更新日の古い順）。一時ファイル・古いファイルは除く */
async function listFiles(kind: Kind, dir: string, lookbackDays: number) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new Error(`フォルダを開けません: ${dir}（${code ?? msgOf(e)}）。`
      + 'タスクを動かすWindowsの利用者が、このフォルダを読めるか確かめてください'
      + '（ドライブ文字ではなく \\\\サーバー名\\共有名 の形で書いてください）');
  }
  const since = Date.now() - lookbackDays * DAY_MS;
  const out: Omit<Candidate, 'sha'>[] = [];
  for (const name of names) {
    // 「~$」で始まるのはExcelが開いている間だけできる一時ファイル
    if (name.startsWith('~$') || name.startsWith('.') || !EXT[kind].test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = await stat(p);
      if (st.isFile() && st.mtimeMs >= since) out.push({ kind, path: p, name, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* 消えた・読めないファイルは飛ばす */ }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** 書き込みの途中のファイルを読まないよう、更新されたばかりなら大きさが落ち着くまで待つ */
async function waitStable(f: Omit<Candidate, 'sha'>) {
  if (Date.now() - f.mtimeMs > 120_000) return;
  log(`「${f.name}」は更新されたばかりなので、書き込みが終わるのを待ちます`);
  for (let i = 0; i < 20; i++) {
    await sleep(15_000);
    const st = await stat(f.path);
    if (st.size === f.size && st.mtimeMs === f.mtimeMs) return;
    f.size = st.size;
    f.mtimeMs = st.mtimeMs;
  }
  throw new Error(`「${f.name}」の書き込みが5分たっても終わりません`);
}

/** 中身のハッシュ。前に見たときから変わっていなければ控えを使う（大きいファイルを毎回読まないため） */
async function withHash(f: Omit<Candidate, 'sha'>, state: State): Promise<Candidate> {
  const seen = state.seen[f.path];
  if (seen && seen.size === f.size && seen.mtimeMs === f.mtimeMs) return { ...f, sha: seen.sha };
  await waitStable(f);
  const buf = await readFile(f.path);
  const sha = createHash('sha256').update(buf).digest('hex');
  state.seen[f.path] = { size: f.size, mtimeMs: f.mtimeMs, sha };
  return { ...f, sha, buf };
}

const doneKey = (f: Candidate) => `${f.kind}:${f.sha}`;
const isDone = (f: Candidate, state: State) => Boolean(state.done[doneKey(f)]);
const markDone = (f: Candidate, state: State) => {
  state.done[doneKey(f)] = { name: f.name, at: new Date().toISOString() };
};
async function contents(f: Candidate) {
  f.buf ??= await readFile(f.path);
  return f.buf;
}

/** フォルダの中の、まだ取り込んでいないファイル（古い順） */
async function newFiles(kind: Kind, dir: string, cfg: Config, state: State) {
  const out: Candidate[] = [];
  for (const f of await listFiles(kind, dir, cfg.lookbackDays ?? 10)) {
    const c = await withHash(f, state);
    if (!isDone(c, state)) out.push(c);
  }
  return out;
}

// ───────── 出荷明細 ─────────

/**
 * 出荷明細。まだ取り込んでいない日を、古い日から1日ずつ取り込む（画面の既定と同じ）。
 * 最後に取り込んだ日は、新しいファイルに載っていれば取り込み直す
 * （月の途中のファイルで、その日の分がまだ出そろっていなかったときのため）。
 * 同じ日が複数のファイルにあれば、新しいファイルのものを使う。
 */
async function runShip(dir: string, cfg: Config, state: State, check: boolean) {
  const files = await newFiles('ship', dir, cfg, state);
  if (!files.length) { line('出荷明細: 新しいファイルはありません'); return; }

  const info = await api<{ rules: { targetCategories?: string[] } }>('/ship-color/rules');
  const batches = await api<{ rows: { data_date: string; status: string }[] }>('/ship-color/batches');
  const imported = new Set(batches.rows.filter((b) => b.status === 'done').map((b) => b.data_date));
  const lastImported = [...imported].sort().pop() ?? '';

  const byDay = new Map<string, { file: Candidate; sheet: ShipSheet }>();
  const parsed: Candidate[] = [];
  for (const f of files) {
    try {
      log(`出荷明細「${f.name}」を読み取っています...`);
      const p = parseShipWorkbook(toArrayBuffer(await contents(f)), {
        fileName: f.name, targetCategories: info.rules.targetCategories ?? [],
      });
      for (const s of p.sheets) byDay.set(s.dataDate, { file: f, sheet: s });
      parsed.push(f);
      if (p.brokenSlips > 0) {
        line(`出荷明細「${f.name}」: 売上伝票NOが崩れている明細が${n(p.brokenSlips)}行あります`
          + '（CSVをExcelで保存し直したファイルです。MBからダウンロードしたままのファイルを置いてください）');
      }
    } catch (e) {
      fail(`出荷明細「${f.name}」: ${msgOf(e)}`);
    }
  }
  const days = [...byDay.values()]
    .filter(({ sheet }) => !imported.has(sheet.dataDate) || sheet.dataDate >= lastImported)
    .sort((a, b) => a.sheet.dataDate.localeCompare(b.sheet.dataDate));

  if (!days.length) {
    if (byDay.size) {
      const all = [...byDay.keys()].sort();
      line(`出荷明細: 取り込んでいない日はありません（${md(all[0])}〜${md(all[all.length - 1])} は取込済み）`);
    }
    if (!check) for (const f of parsed) markDone(f, state);
    return;
  }
  if (check) {
    for (const { file, sheet } of days) {
      line(`出荷明細: ${md(sheet.dataDate)}（${n(sheet.rows.length)}行）を「${file.name}」から取り込みます`
        + (imported.has(sheet.dataDate) ? '（取込済みの日を置き換え）' : ''));
    }
    return;
  }

  // 同じファイルが続く日はまとめて送る（送り方は画面と同じ sendShipDays）
  const groups: { file: Candidate; sheets: ShipSheet[] }[] = [];
  for (const d of days) {
    const last = groups[groups.length - 1];
    if (last && last.file === d.file) last.sheets.push(d.sheet);
    else groups.push({ file: d.file, sheets: [d.sheet] });
  }
  const done: string[] = [];
  let unset = 0;
  try {
    for (const g of groups) {
      await sendShipDays(g.file.name, g.sheets, {
        onProgress: (t) => log(`出荷明細: ${t}`),
        onDayDone: (r) => {
          done.push(`${md(r.dataDate)}（${n(r.rows)}行${r.replaced ? '・置き換え' : ''}）`);
          unset += r.counts.unset ?? 0;
        },
      });
    }
  } catch (e) {
    fail(`出荷明細: ${msgOf(e)}${done.length ? `（取り込めた日: ${done.join('、')}）` : ''}`);
    return;   // ファイルは取込済みにしない。次の実行で、残りの日から続ける
  }
  for (const f of parsed) markDone(f, state);
  line(`出荷明細: ${done.join('、')} を取り込み、判定しました`
    + (unset ? `。未判定（目視確認）${n(unset)}行` : ''));
}

// ───────── 売上高 ─────────

interface SurveyJob {
  file: Candidate;
  parsed: SurveyParsed;
  mode: SurveyMode;
  /** データの日付。日次はいつまでの累計か、月次は月の末日 */
  asOf: string;
  /** 取込済みの日次を、月次のあとに入れ直すとき */
  again?: boolean;
}

/**
 * 売上高。案件の実績は「最後に取り込んだ売上高」になるため、順番が大事になる。
 *   ・日次は累計なので、フォルダのいちばん新しいファイルだけを使う
 *   ・データの日付の古い順に取り込む（同じ月の日次と月次なら月次を後にして確定させる）
 *   ・前の月の月次を取り込んだら、最新の日次を入れ直す（実績が前の月に戻ったままにしない）
 */
async function runSurvey(cfg: Config, state: State, check: boolean) {
  const jobs: SurveyJob[] = [];
  const dailyDir = cfg.folders?.salesDaily;
  const monthlyDir = cfg.folders?.salesMonthly;

  if (monthlyDir) {
    try {
      const files = await newFiles('salesMonthly', monthlyDir, cfg, state);
      if (!files.length) line('売上高（月次）: 新しいファイルはありません');
      for (const f of files) {
        try {
          log(`売上高（月次）「${f.name}」を読み取っています...`);
          // 「9月数量」の形式のファイルで、9月が何年かの手がかり（画面ではマスタ登録の当月）
          const parsed = await parseSurveyFile(new File([toArrayBuffer(await contents(f))], f.name), jstDay().slice(0, 7));
          jobs.push({ file: f, parsed, mode: 'monthly', asOf: monthEnd(parsed.ym) });
        } catch (e) {
          fail(`売上高（月次）「${f.name}」: ${msgOf(e)}`);
        }
      }
    } catch (e) {
      fail(`売上高（月次）: ${msgOf(e)}`);
    }
  }

  if (dailyDir) {
    try {
      const list = await listFiles('salesDaily', dailyDir, cfg.lookbackDays ?? 10);
      const newest = list.length ? await withHash(list[list.length - 1], state) : null;
      if (!newest) {
        line('売上高（日次）: 新しいファイルはありません');
      } else {
        // 売上高のファイルは前日までの累計。ファイルを作った日（更新日）の前の日をデータの日付にする
        const asOf = dataDateOf(jstDay(newest.mtimeMs));
        const isNew = !isDone(newest, state);
        const needAgain = !isNew && jobs.some((j) => j.asOf < asOf);
        if (!isNew && !needAgain) {
          line('売上高（日次）: 新しいファイルはありません');
        } else {
          try {
            log(`売上高（日次）「${newest.name}」を読み取っています...`);
            const parsed = await parseSurveyFile(new File([toArrayBuffer(await contents(newest))], newest.name), asOf.slice(0, 7));
            if (parsed.ym !== asOf.slice(0, 7)) {
              throw new Error(`ファイルの月（${parsed.ym}）と、更新日から見たデータの日付（${asOf}）の月が違います。`
                + '当月の累計のファイルか確かめてください');
            }
            jobs.push({ file: newest, parsed, mode: 'daily', asOf, again: !isNew });
          } catch (e) {
            fail(`売上高（日次）「${newest.name}」: ${msgOf(e)}`);
          }
        }
      }
    } catch (e) {
      fail(`売上高（日次）: ${msgOf(e)}`);
    }
  }

  jobs.sort((a, b) => a.asOf.localeCompare(b.asOf)
    || (a.mode === b.mode ? 0 : a.mode === 'daily' ? -1 : 1));

  for (const j of jobs) {
    const kind = j.mode === 'daily' ? '売上高（日次）' : '売上高（月次）';
    const what = j.mode === 'daily'
      ? `${md(j.asOf)}時点の当月累計（${Number(j.parsed.ym.slice(5))}月）`
      : `${Number(j.parsed.ym.slice(5))}月の確定`;
    if (check) {
      line(`${kind}「${j.file.name}」を ${what} として取り込みます（${n(j.parsed.rows.length)}行）`
        + (j.again ? '。月次のあとに入れ直します' : ''));
      continue;
    }
    try {
      let next = 0;
      const r = await sendSurveyImport(j.parsed, j.file.name, {
        mode: j.mode,
        asOf: j.mode === 'daily' ? j.asOf : undefined,
        onProgress: (sent, total) => {
          if (sent < next && sent < total) return;
          next = sent + Math.ceil(total / 5);
          log(`${kind}: ${n(sent)} / ${n(total)}行を送りました`);
        },
      });
      markDone(j.file, state);
      const pr = r.progress;
      line(`${kind}「${j.file.name}」を ${what} として取り込みました。`
        + `案件 ${n(r.covered)} / ${n(r.total)}件に実績`
        + (pr ? `・金額 ¥${n(pr.amount)}` : '')
        + (r.unmatched ? `・取り込めない行 ${n(r.unmatched)}` : '')
        + (j.again ? '（月次のあとに、最新の日次を入れ直しました）' : ''));
    } catch (e) {
      fail(`${kind}「${j.file.name}」: ${msgOf(e)}`);
    }
  }
}

// ───────── 本体 ─────────

async function main() {
  const check = process.argv.includes('--check');
  const cfgPath = path.resolve(argValue('--config') ?? path.join(HERE, 'auto-import.config.json'));
  const baseDir = path.dirname(cfgPath);
  try {
    mkdirSync(path.join(baseDir, 'logs'), { recursive: true });
    logFile = path.join(baseDir, 'logs', `auto-import-${jstDay().slice(0, 7)}.log`);
  } catch { /* ログのフォルダが作れなくても画面には出す */ }

  log(`自動取込を始めます（版 ${VERSION}${check ? '・確認だけ' : ''}）`);
  const cfg = await loadConfig(cfgPath);
  connect(cfg);
  const who = await api<{ user: { loginId: string; name: string }; mail: boolean; mailTo: number }>('/auto-import/check');
  log(`アプリにつながりました: ${cfg.appUrl}（取込者: ${who.user.name}・${who.user.loginId}）`
    + `。通知メール: ${who.mail ? `${who.mailTo}件の宛先へ送ります` : '送りません（RESEND_API_KEY が未設定）'}`);

  const statePath = path.join(baseDir, 'auto-import.state.json');
  const state = await loadState(statePath);

  if (cfg.folders?.ship) {
    try {
      await runShip(cfg.folders.ship, cfg, state, check);
    } catch (e) {
      fail(`出荷明細: ${msgOf(e)}`);
    }
  }
  if (cfg.folders?.salesDaily || cfg.folders?.salesMonthly) await runSurvey(cfg, state, check);

  if (check) {
    log('確認だけのため、取り込みも記録もしていません');
    return report.errors.length ? 1 : 0;
  }
  await saveState(statePath, state);
  try {
    const r = await api<{ mailed: boolean; to?: number; error?: string }>('/auto-import/report', {
      method: 'POST',
      body: JSON.stringify({
        ok: report.errors.length === 0, lines: report.lines, errors: report.errors,
        host: `${os.hostname()}（版 ${VERSION}）`, notify: cfg.notify ?? 'always',
      }),
    });
    log(r.mailed ? `結果をメールで知らせました（${r.to}件）`
      : `結果はアプリに記録しました${r.error ? `（メールは送れませんでした: ${r.error}）` : ''}`);
  } catch (e) {
    log(`結果をアプリへ送れませんでした: ${msgOf(e)}`);
  }
  log(report.errors.length ? `終わりました（取り込めなかったもの ${report.errors.length}件）` : '終わりました');
  return report.errors.length ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    log(`止まりました: ${msgOf(e)}`);
    process.exitCode = 2;
  },
);

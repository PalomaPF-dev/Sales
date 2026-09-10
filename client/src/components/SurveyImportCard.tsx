import { useEffect, useRef, useState } from 'react';
import { Card } from './ui';
import { api } from '../api';
import type { SurveyMode, SurveyParsed, SurveyResult } from '../surveyImportClient';

// Excelの読み書きの部品は大きい（数百KB）。最初の画面表示に含めると
// ログインまで遅くなるため、ファイルを選んだ時にだけ読み込む。
const surveyClient = () => import('../surveyImportClient');

/** 今日（日本時間）と、その n 日前（YYYY-MM-DD） */
const jstDate = (daysAgo = 0) =>
  new Date(Date.now() + 9 * 3600 * 1000 - daysAgo * 86400000).toISOString().slice(0, 10);

/** 「2026-09-10」→「9/10」 */
const mdLabel = (d: string) =>
  (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : d);

/**
 * 売上高の取込カード。管理者・開発者だけに出す。
 *
 * mode で取り方が変わる（同じファイル形式を、同じ突合の決まりで取り込む）。
 *   monthly … 月次（確定）。月まるごとの実績。これまでどおり
 *   daily   … 日次（当月の累計）。「その日までの当月の合計」のファイルを毎日取り込み、
 *             月の中で実績が積み上がっていく様子（進捗）を見る。
 *             データの日付と、その日までの稼働日（計画の日量換算のもと）を添えて送る。
 *             月末に月次を取り込めば、同じ月の数字がそのまま確定に置き換わる。
 */
export default function SurveyImportCard({ mode = 'monthly', anchorYm, onDone }:
  { mode?: SurveyMode; anchorYm?: string; onDone?: () => void }) {
  const daily = mode === 'daily';
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [parsed, setParsed] = useState<{ p: SurveyParsed; name: string } | null>(null);
  const [result, setResult] = useState<SurveyResult | null>(null);
  const [err, setErr] = useState('');
  // 日次: データの日付（いつまでの累計か）。売上高のファイルはふつう前日までの
  // 結果なので、既定は昨日。過去の日付のファイルを取り込み直して進捗を埋めることもできる
  const [asOf, setAsOf] = useState(() => jstDate(1));
  // 日次: その日までの稼働日。サーバーが暦から見込んだ数を出し、営業部の稼働日に合わせて直せる
  const [days, setDays] = useState<{ workDays: number | null; elapsedDays: number | null } | null>(null);
  const [elapsed, setElapsed] = useState('');

  // データの日付を変えるたびに、その日までの稼働日の見込みを取り直す
  useEffect(() => {
    if (!daily || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { setDays(null); return; }
    let alive = true;
    api<{ workDays: number | null; elapsedDays: number | null }>(
      `/survey-import/workdays?asOf=${asOf}`)
      .then((r) => { if (alive) { setDays(r); setElapsed(r.elapsedDays == null ? '' : String(r.elapsedDays)); } })
      .catch(() => { if (alive) setDays(null); });
    return () => { alive = false; };
  }, [daily, asOf]);

  const onPick = async () => {
    const file = fileRef.current?.files?.[0];
    setParsed(null);
    setResult(null);
    setErr('');
    if (!file) return;
    setBusy(true);
    const mb = Math.round(file.size / 1048576);
    setProgress(`ファイルを読み取っています...（${mb}MB。数十MBのファイルは1〜2分かかります。`
      + 'この間ブラウザが固まって見えますが、タブを閉じずにお待ちください）');
    try {
      // 描画を止めないよう、読み取り前に一呼吸置く
      await new Promise((r) => setTimeout(r, 50));
      // 「9月」が何年かの手がかり。日次はデータの日付の月、月次はマスタ登録の当月
      const anchor = daily && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf.slice(0, 7) : anchorYm;
      const p = await (await surveyClient()).parseSurveyFile(file, anchor);
      setParsed({ p, name: file.name });
      setProgress('');
    } catch (e) {
      setErr((e as Error).message);
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  // 日次: ファイルの月とデータの日付の月が食い違っていたら止める
  // （先月のファイルを今日の日付で取り込むと、進捗の記録がずれるため）
  const monthMismatch = daily && parsed && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    && asOf.slice(0, 7) !== parsed.p.ym;
  const elapsedNum = Number(elapsed);
  const elapsedBad = daily && elapsed !== ''
    && (!Number.isInteger(elapsedNum) || elapsedNum < 1
      || (days?.workDays != null && elapsedNum > days.workDays));

  const run = async () => {
    if (!parsed) return;
    setBusy(true);
    setErr('');
    setResult(null);
    try {
      const r = await (await surveyClient()).sendSurveyImport(parsed.p, parsed.name, {
        onProgress: (done, total) =>
          setProgress(`${done.toLocaleString()} / ${total.toLocaleString()}行を取込中...`),
        mode,
        asOf: daily ? asOf : undefined,
        elapsedDays: daily && elapsed !== '' ? elapsedNum : null,
      });
      setResult(r);
      setProgress('');
      setParsed(null);
      if (fileRef.current) fileRef.current.value = '';
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  const title = daily
    ? `③ 売上高（日次・当月の累計）の取込${parsed ? `：${parsed.p.monthLabel} ${mdLabel(asOf)}時点` : ''}`
    : `② 売上高（月次・確定）の取込${parsed ? `：売上高（${parsed.p.monthLabel}）` : ''}`;
  const yen = (v: number) => `¥${Math.round(v).toLocaleString()}`;

  return (
    <Card title={title}>
      {err && <div className="alert error" onClick={() => setErr('')}>{err}</div>}
      {result && (
        <div className="alert ok" onClick={() => setResult(null)}>
          売上高を突合しました: 案件 {result.covered.toLocaleString()} / {result.total.toLocaleString()}件にその月の実績が入りました
          （読み取れた行 {result.matched.toLocaleString()}
          {result.unmatched > 0 && ` ・ 取り込めない行 ${result.unmatched.toLocaleString()}`}）
          {result.progress && (
            <>
              <br />
              {result.progress.final
                ? `${Number(result.progress.ym.slice(5, 7))}月の総額（確定）`
                : `${mdLabel(result.progress.asOf)}時点の当月累計`}
              : 金額 <strong>{yen(result.progress.amount)}</strong>
              ・数量 {Math.round(result.progress.qty).toLocaleString()}
              ・{result.progress.deals.toLocaleString()}件
              {!result.progress.final && result.progress.elapsedDays != null && (
                ` ・ 稼働日 ${result.progress.elapsedDays}${result.progress.workDays ? ` / ${result.progress.workDays}` : ''}日`
              )}
              {result.progress.gainAmount != null && (
                <> ・ 売上改善額（マスタ） <strong>{yen(result.progress.gainAmount)}</strong></>
              )}
              。下の「売上高（当月）の進捗」に記録しました
            </>
          )}
        </div>
      )}
      {daily ? (
        <p className="pt-note" style={{ marginTop: 0 }}>
          <strong>当月の累計</strong>（月初からその日までの合計）の売上高ファイルを
          <strong>毎日</strong>取り込みます。売上高（価格実績）のファイル
          （「対象年月」「数量（合計）」「単価（マスタ）」「売上改善額（マスタ）」の列）をそのまま使えます
          （月次と同じ「9月数量」形式のファイルでも取り込めます）。
          <strong>売上改善額（マスタ）</strong>はファイルの値をそのまま取り込み、
          画面の売上改善額はこの値で出します。
          取り込むたびに<strong>その月の実績がその日までの累計に置き換わり</strong>、
          月の中でいくら積み上がってきたかが下の「売上高（当月）の進捗」に残ります。
          月末に<strong>②月次（確定）</strong>を取り込むと、同じ月の数字がそのまま確定の総額に置き換わります
          （日次と月次で表が分かれることはありません）。
          計画の<strong>稼働日での日量換算</strong>は、月まるごとではなく
          <strong>データの日付までの稼働日</strong>で割ります（月の途中の実績を月の稼働日で割ると、計画が実態より低く出るため）。
        </p>
      ) : (
        <p className="pt-note" style={{ marginTop: 0 }}>
          <strong>その月の売上高</strong>（「7月数量」「7月単価」の列。名称は取込月で変わります）と、
          <strong>過去最新単価</strong>（値上げ前）を取り込みます。
          単価が「マスタ／見積／合計」に分かれたファイルでは、
          <strong>マスタ単価</strong>（値決めの単価）と<strong>実単価</strong>（金額÷数量）の
          両方を取り込みます。
          ファイルは 得意先×納入先×商品 の細かい単位なので、
          <strong>得意先×商品へ集約（数量で加重平均）します</strong>。
          取り込むと<strong>ベース（価格調査（毎日更新））へ単価・数量を突合</strong>して重なり、
          突合で当たらないベースの品目は「実績無し」になります。
          <strong>売上高にだけある行も案件として残る</strong>ため、売上高の合計は必ずファイルと一致します
          （商談結果など画面で入れた値はそのまま残ります）。
          月の途中の進捗を見たいときは、下の<strong>③日次</strong>で当月の累計を毎日取り込んでください。
        </p>
      )}
      {daily && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
          <label className="fld" style={{ maxWidth: 220 }}
                 title="ファイルが「いつまでの累計」か。売上高のファイルはふつう前日までの結果なので、既定は昨日です">
            <span style={{ fontSize: 12.5 }}>データの日付（いつまでの累計か）</span>
            <input type="date" value={asOf} max={jstDate()} disabled={busy}
                   onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <label className="fld" style={{ maxWidth: 220 }}
                 title={'その日までの稼働日。計画の日量換算のもとになります。'
                   + '暦（平日）から見込んだ数を出しているので、営業部の稼働日に合わせて直せます'}>
            <span style={{ fontSize: 12.5 }}>
              その日までの稼働日{days?.workDays ? `（${asOf.slice(5, 7).replace(/^0/, '')}月は ${days.workDays}日）` : ''}
            </span>
            <input type="number" min={1} max={days?.workDays ?? undefined} step={1}
                   value={elapsed} disabled={busy}
                   placeholder={days?.elapsedDays == null ? '（換算なし）' : String(days.elapsedDays)}
                   onChange={(e) => setElapsed(e.target.value)} />
          </label>
          {days && days.workDays == null && (
            <span className="pt-note" style={{ margin: 0, fontSize: 12 }}>
              この月の稼働日が登録されていないため、計画の日量換算は行いません
            </span>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" ref={fileRef} accept=".xlsx,.xlsm" onChange={onPick} disabled={busy} />
        {parsed && (
          <>
            <span style={{ fontSize: 13 }}>
              {parsed.p.rows.length.toLocaleString()}行（{parsed.p.ym} の実績
              {daily ? `・${mdLabel(asOf)}時点の累計として取り込みます` : ''}）
              {parsed.p.hasPast
                ? ' ・ 過去最新単価と比べて、実際に上がった分を出します'
                : ' ・ 過去最新単価の列が無いため、値上がりの比較は出ません'}
              {parsed.p.hasMasterPrice
                ? ' ・ マスタ単価と実単価を分けて取り込みます'
                : ' ・ マスタ単価の列が無いため、当月単価をマスタ単価として扱います'}
              {parsed.p.hasCorpGroup
                ? ' ・ 企業グループ名を法人として取り込みます'
                : ' ・ 企業グループ名の列が無いため、得意先を法人として扱います'}
              {parsed.p.hasGain
                ? ' ・ 売上改善額（マスタ）はファイルの値をそのまま使います'
                : ' ・ 売上改善額の列が無いため、（マスタ単価 − 過去最新単価）× マスタ分の数量 で出します'}
              {parsed.p.monthFrom === 'target_ym' && ' ・ 月は「対象年月」の列から読みました'}
              {parsed.p.skippedRows > 0 && ` ・ 読めない行 ${parsed.p.skippedRows}件`}
            </span>
            {monthMismatch && (
              <span className="alert error" style={{ margin: 0, padding: '4px 8px' }}>
                ファイルの月（{parsed.p.monthLabel}）とデータの日付（{mdLabel(asOf)}）の月が違います。
                当月の累計のファイルか、日付を確かめてください
              </span>
            )}
            {elapsedBad && (
              <span className="alert error" style={{ margin: 0, padding: '4px 8px' }}>
                稼働日は 1〜{days?.workDays ?? '月の稼働日'} の整数で入れてください
              </span>
            )}
            <button className="btn" onClick={run} disabled={busy || Boolean(monthMismatch) || elapsedBad}>
              取り込む
            </button>
          </>
        )}
      </div>
      {progress && <p className="pt-note">{progress}</p>}
    </Card>
  );
}

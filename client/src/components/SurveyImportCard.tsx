import { useRef, useState } from 'react';
import { Card } from './ui';
import type { SurveyParsed, SurveyResult } from '../surveyImportClient';

// Excelの読み書きの部品は大きい（数百KB）。最初の画面表示に含めると
// ログインまで遅くなるため、ファイルを選んだ時にだけ読み込む。
const surveyClient = () => import('../surveyImportClient');

/**
 * 価格調査（実単価）の取込カード。管理者・開発者だけに出す。
 *
 * 「売上単価4月」「売上単価5月」…のような月ごとの実際の単価を取り込み、
 * A基準（値上げの計画）に対して実際いくらで出たのかを並べて見られるようにする。
 */
export default function SurveyImportCard({ anchorYm, onDone }:
  { anchorYm?: string; onDone?: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [parsed, setParsed] = useState<{ p: SurveyParsed; name: string } | null>(null);
  const [result, setResult] = useState<SurveyResult | null>(null);
  const [err, setErr] = useState('');

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
      const p = await (await surveyClient()).parseSurveyFile(file, anchorYm);
      setParsed({ p, name: file.name });
      setProgress('');
    } catch (e) {
      setErr((e as Error).message);
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!parsed) return;
    setBusy(true);
    setErr('');
    setResult(null);
    try {
      const r = await (await surveyClient()).sendSurveyImport(parsed.p, parsed.name, {
        onProgress: (done, total) =>
          setProgress(`${done.toLocaleString()} / ${total.toLocaleString()}行を取込中...`),
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

  return (
    <Card title={`② 売上高（月次）の取込${parsed ? `：売上高（${parsed.p.monthLabel}）` : ''}`}>
      {err && <div className="alert error" onClick={() => setErr('')}>{err}</div>}
      {result && (
        <div className="alert ok" onClick={() => setResult(null)}>
          売上高を突合しました: 案件 {result.covered.toLocaleString()} / {result.total.toLocaleString()}件にその月の実績が入りました
          （読み取れた行 {result.matched.toLocaleString()}
          {result.unmatched > 0 && ` ・ 取り込めない行 ${result.unmatched.toLocaleString()}`}）
        </div>
      )}
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
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" ref={fileRef} accept=".xlsx,.xlsm" onChange={onPick} disabled={busy} />
        {parsed && (
          <>
            <span style={{ fontSize: 13 }}>
              {parsed.p.rows.length.toLocaleString()}行（{parsed.p.ym} の実績）
              {parsed.p.hasPast
                ? ' ・ 過去最新単価と比べて、実際に上がった分を出します'
                : ' ・ 過去最新単価の列が無いため、値上がりの比較は出ません'}
              {parsed.p.hasMasterPrice
                ? ' ・ マスタ単価と実単価を分けて取り込みます'
                : ' ・ マスタ単価の列が無いため、当月単価をマスタ単価として扱います'}
              {parsed.p.hasCorpGroup
                ? ' ・ 企業グループ名を法人として取り込みます'
                : ' ・ 企業グループ名の列が無いため、得意先を法人として扱います'}
              {parsed.p.skippedRows > 0 && ` ・ 読めない行 ${parsed.p.skippedRows}件`}
            </span>
            <button className="btn" onClick={run} disabled={busy}>取り込む</button>
          </>
        )}
      </div>
      {progress && <p className="pt-note">{progress}</p>}
    </Card>
  );
}

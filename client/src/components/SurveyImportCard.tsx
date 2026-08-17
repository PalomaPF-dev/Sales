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
    setProgress('ファイルを読み取っています...（十数万行のファイルは1分ほどかかります）');
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
    <Card title="価格調査（実単価）の取込">
      {err && <div className="alert error" onClick={() => setErr('')}>{err}</div>}
      {result && (
        <div className="alert ok" onClick={() => setResult(null)}>
          実単価を重ねました: 案件 {result.covered.toLocaleString()} / {result.total.toLocaleString()}件に実単価が入りました
          （法人を照合できた行 {result.matched.toLocaleString()}
          {result.unmatched > 0 && ` ・ 実績に無い法人の行 ${result.unmatched.toLocaleString()}`}）
        </div>
      )}
      <p className="pt-note" style={{ marginTop: 0 }}>
        <strong>月ごとの実際の単価</strong>（「売上単価4月」などの列）を取り込みます。
        A基準は<strong>値上げの計画</strong>、こちらは<strong>実際いくらで出たか</strong>なので、
        ダッシュボードの「まとめ」で計画と実績を月の流れで比べられます。
        価格調査は 得意先×納入先×商品 の細かい単位なので、
        <strong>法人×品目へ集約（数量で加重平均）して</strong>案件に重ねます。
        取り込むたびに前回の実単価は入れ替わります（月を足したファイルをそのまま取り込めます）。
        先に「出荷実績」を取り込んでおいてください。
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" ref={fileRef} accept=".xlsx,.xlsm" onChange={onPick} disabled={busy} />
        {parsed && (
          <>
            <span style={{ fontSize: 13 }}>
              実単価のある行 {parsed.p.rows.length.toLocaleString()}件
              （{parsed.p.months[0]} 〜 {parsed.p.months[parsed.p.months.length - 1]}
              の{parsed.p.months.length}か月）
              {parsed.p.hasQty ? '' : ' ・ 売上数の列が無いため単純平均で集約します'}
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

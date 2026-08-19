import { useRef, useState } from 'react';
import { Card } from './ui';
import type { AggParsed, AggResult } from '../aggImportClient';

// Excelの読み書きの部品は大きい（数百KB）。最初の画面表示に含めると
// ログインまで遅くなるため、ファイルを選んだ時にだけ読み込む。
const aggClient = () => import('../aggImportClient');

/**
 * マスタ登録（値上げ結果の集約表）の取込カード。管理者・開発者だけに出す。
 *
 * 取り込むと案件は 得意先×納入先×商品 の単位になり、
 * 出荷単価・数量・A基準（向こう3か月の申請単価）が入る。
 * 2回目からは同じ単位の行を上書きし、区分・合意・交渉の入力値は残す。
 */
export default function AggImportCard({ onDone }: { onDone?: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [parsed, setParsed] = useState<{ p: AggParsed; name: string } | null>(null);
  const [result, setResult] = useState<AggResult | null>(null);
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
      const p = await (await aggClient()).parseAggFile(file);
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
      const r = await (await aggClient()).sendAggImport(parsed.p, parsed.name, {
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
    <Card title="② マスタ登録（A基準）の取込">
      {err && <div className="alert error" onClick={() => setErr('')}>{err}</div>}
      {result && (
        <div className="alert ok" onClick={() => setResult(null)}>
          A基準を重ねました: 案件 {result.covered.toLocaleString()} / {result.total.toLocaleString()}件にA基準が入りました
          （読み取れた行 {result.matched.toLocaleString()}
          {result.added > 0 && ` ・ 実績に無い品目を案件として追加 ${result.added.toLocaleString()}件`}
          {result.unmatched > 0 && ` ・ 取り込めない行 ${result.unmatched.toLocaleString()}`}）
        </div>
      )}
      <p className="pt-note" style={{ marginTop: 0 }}>
        <strong>A基準（向こう3か月の申請単価）</strong>を取り込みます。
        マスタ登録は 得意先×納入先×商品 の細かい単位なので、
        <strong>法人×品目へ集約して</strong>、案件に重ねます。
        A基準・目標値は<strong>リストの単価をそのまま</strong>使います
        （加重平均はしません。数量は月あたりの値上げ額の計算にだけ使います）。
        「登録日」のあるファイルなら、A基準それぞれの<strong>承認日</strong>も一緒に入ります
        （まとまりの中で一番新しい日）。「ＷＦ申請番号」の列があれば<strong>稟議No</strong>も入り、
        案件一覧のA基準にカーソルを合わせると見えます。
        先に「価格調査（実単価）」を取り込んでおいてください（案件の土台になります）。
        商談結果など画面で入れた値は、ファイル側に値が無ければ残ります。
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" ref={fileRef} accept=".xlsx,.xlsm" onChange={onPick} disabled={busy} />
        {parsed && (
          <>
            <span style={{ fontSize: 13 }}>
              {parsed.p.rows.length.toLocaleString()}行
              （{[parsed.p.meta.m0, parsed.p.meta.m1, parsed.p.meta.m2, parsed.p.meta.m3]
                .filter(Boolean).join('・')} ／ 出荷単価 {parsed.p.meta.basePeriod}）
              {parsed.p.hasDates ? ' ・ 承認日あり' : ' ・ 承認日なし（登録日の列がありません）'}
              {parsed.p.hasRingi ? ' ・ 稟議Noあり' : ''}
              {parsed.p.skippedRows > 0
                && ` ・ 読めない行 ${parsed.p.skippedRows}件`
                  + `（得意先コード空 ${parsed.p.skippedNoCust}件`
                  + ` / 商品コード空 ${parsed.p.skippedNoModel}件）`}
            </span>
            <button className="btn" onClick={run} disabled={busy}>取り込む</button>
          </>
        )}
      </div>
      {progress && <p className="pt-note">{progress}</p>}
    </Card>
  );
}

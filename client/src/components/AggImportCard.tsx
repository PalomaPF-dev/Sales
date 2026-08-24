import { useRef, useState } from 'react';
import { Card } from './ui';
import type { AggParsed, AggResult } from '../aggImportClient';

// Excelの読み書きの部品は大きい（数百KB）。最初の画面表示に含めると
// ログインまで遅くなるため、ファイルを選んだ時にだけ読み込む。
const aggClient = () => import('../aggImportClient');

/** 今日（日本時間）。取込日に明日以降を選べないようにするため */
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

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
  // この取込に限り、商談結果・最終確定日・最終確定単価をファイルの値で入れ直す。
  // 既定は上書きしない（値上げ交渉の記録は営業担当者がアプリで入れるため）
  const [overwriteNego, setOverwriteNego] = useState(false);
  // 値上げ額の履歴に残す取込日。空なら今日。
  // 前回のファイルを取り込み直して前日比を埋めるときだけ日付を入れる
  const [takenOn, setTakenOn] = useState('');

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
        overwriteNego,
        takenOn,
      });
      setResult(r);
      setProgress('');
      setParsed(null);
      setTakenOn('');
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
    <Card title="① 価格調査（毎日更新）の取込">
      {err && <div className="alert error" onClick={() => setErr('')}>{err}</div>}
      {result && (
        <div className="alert ok" onClick={() => setResult(null)}>
          取り込みました: 案件 {result.covered.toLocaleString()} / {result.total.toLocaleString()}件にマスタ登録単価が入りました
          （読み取れた行 {result.matched.toLocaleString()}
          {result.added > 0 && ` ・ 新しい品目を案件として追加 ${result.added.toLocaleString()}件`}
          {result.unmatched > 0 && ` ・ 取り込めない行 ${result.unmatched.toLocaleString()}`}）
        </div>
      )}
      <p className="pt-note" style={{ marginTop: 0 }}>
        <strong>この取込が案件一覧の常のベースです。</strong>
        <strong>マスタ登録単価（当月（本日時点）・翌月・翌々月・3か月後の申請単価）</strong>と
        出荷単価・売上数を取り込みます。
        ファイルは 得意先×納入先×商品 の細かい単位なので<strong>法人×品目へ集約</strong>し、
        マスタ登録単価・目標単価は<strong>リストの単価をそのまま</strong>使います
        （加重平均はしません。数量は月あたりの値上げ額の計算にだけ使います）。
        「登録日」のあるファイルなら各月の<strong>承認日</strong>も一緒に入ります
        （まとまりの中で一番新しい日）。「ＷＦ申請番号」の列があれば<strong>稟議No</strong>も入ります。
        <strong>「マスター単価（4月実績）」…の列</strong>があれば、そのまま月別の実績履歴として入ります。
        <strong>毎日取り込み直す</strong>と当月の履歴が最新の値で上書きされ、
        「取り込んだ前日まで」の値が残ります（実績列の無いファイルでは当月単価を記録します）。
        <strong>目標単価</strong>の列があるファイルでは、その内容を正として入れ直します
        （ファイルで空欄の品目は空に戻ります）。列の無いファイルでは今の値を残します。
        <strong>値上げ交渉の記録（商談結果・最終確定日・最終確定単価）は取り込みません。</strong>
        営業担当者がアプリで入れた値がそのまま残ります
        （毎日の取込で更新されるのはマスタ登録単価などのマスタ側の項目だけです）。
        ファイル側でまとめて直したときは、ファイルを選んだあとに出る
        <strong>「ファイルの値で入れ直す」に印</strong>を付けると入れ直せます。
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" ref={fileRef} accept=".xlsx,.xlsm" onChange={onPick} disabled={busy} />
        {parsed && (
          <>
            <span style={{ fontSize: 13 }}>
              {parsed.p.rows.length.toLocaleString()}行
              （{[parsed.p.meta.m0, parsed.p.meta.m1, parsed.p.meta.m2, parsed.p.meta.m3]
                .filter(Boolean).join('・')}
              {parsed.p.meta.basePeriod ? ` ／ 出荷単価 ${parsed.p.meta.basePeriod}` : ''}）
              {parsed.p.hasDates ? ' ・ 承認日あり' : ' ・ 承認日なし（登録日の列がありません）'}
              {parsed.p.hasRingi ? ' ・ 稟議Noあり' : ''}
              {parsed.p.histMonths.length > 0
                ? <span title={`実績として読んだ列: ${parsed.p.histHeads.join(' / ')}`}>
                    {` ・ マスタ単価実績 ${parsed.p.histMonths[0]}〜${parsed.p.histMonths[parsed.p.histMonths.length - 1]}`}
                    {`（${parsed.p.histMonths.length}か月）`}
                  </span>
                : <strong style={{ color: 'var(--critical)' }}>
                    {' ・ マスタ単価実績の列が見つかりません（「マスター単価（4月実績）」のような見出しの列）'}
                  </strong>}
              {/* 交渉まわりの列の検出状況。見つからない列は取込で変更されないため、
                  最終確定日などが合わないときはまずここを確認してもらう */}
              {(() => {
                const miss = [
                  !parsed.p.hasM0 && '当月（本日時点）のマスタ単価',
                  !parsed.p.hasDelivery && '納入先名',
                  !parsed.p.negoCols.target && '目標単価',
                  !parsed.p.negoCols.nego && '商談結果',
                  !parsed.p.negoCols.finalDate && '最終確定日',
                  !parsed.p.negoCols.finalPrice && '最終確定単価',
                ].filter(Boolean);
                return miss.length
                  ? <strong style={{ color: 'var(--critical)' }}>{` ・ 見つからない列: ${miss.join('・')}`}</strong>
                  : ' ・ 交渉列（目標単価・商談結果・最終確定日・最終確定単価）あり';
              })()}
              {parsed.p.skippedRows > 0
                && ` ・ 読めない行 ${parsed.p.skippedRows}件`
                  + `（得意先コード空 ${parsed.p.skippedNoCust}件`
                  + ` / 商品コード空 ${parsed.p.skippedNoModel}件）`}
            </span>
            <button className="btn" onClick={run} disabled={busy}>取り込む</button>
          </>
        )}
      </div>
      {/* 交渉の記録は既定で取り込まない。ファイル側を正として入れ直したいときだけ、
          この印を付ける。取込ごとの選択で、次の取込には持ち越さない */}
      {parsed && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 12.5 }}>
          <input type="checkbox" checked={overwriteNego} disabled={busy}
            onChange={(e) => setOverwriteNego(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <strong>商談結果・最終確定日・最終確定単価もファイルの値で入れ直す</strong>
            （通常は印を付けません）。
            <br />
            <span style={{ color: 'var(--muted)' }}>
              値上げ交渉の記録は営業担当者がアプリで入れるため、毎日の取込では変えません。
              ファイル側でまとめて直したときだけ印を付けてください
              （ファイルで空欄の品目は今の値が残ります）。
              商談メモはファイルに無いため、印の有無にかかわらず変わりません。
              新しく追加される案件には、印の有無にかかわらずファイルの値が入ります。
              この選択は今回の取込にだけ効きます。
            </span>
          </span>
        </label>
      )}
      {/* 過去のファイルを取り込み直して、値上げ額の推移（前日比）を埋めるための欄。
          ふだんは空のまま＝今日の日付で記録する */}
      {parsed && (
        <label className="fld" style={{ marginTop: 10, maxWidth: 460 }}>
          <span style={{ fontSize: 12.5 }}>
            値上げ額の履歴に残す<strong>取込日</strong>（ふだんは空のまま）
          </span>
          <input type="date" value={takenOn} max={today()} disabled={busy}
                 onChange={(e) => setTakenOn(e.target.value)} />
          <span style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            空なら今日の日付で記録します。
            <strong>前回のファイルを取り込み直して前日比を埋めたいとき</strong>だけ、
            そのファイルの日付を入れてください
            （そのあと必ず<strong>最新のファイルを取り込み直して</strong>ください。
            案件の単価は最後に取り込んだファイルの内容になります）。
          </span>
        </label>
      )}
      {progress && <p className="pt-note">{progress}</p>}
    </Card>
  );
}

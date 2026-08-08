import { useRef, useState } from 'react';
import { Card } from './ui';
import type { HistParsed, HistResult } from '../histImportClient';

// Excelの読み書きの部品は大きい（数百KB）。最初の画面表示に含めると
// ログインまで遅くなるため、ファイルを選んだ時にだけ読み込む。
const histClient = () => import('../histImportClient');

/**
 * 出荷実績（月別履歴）の取込カード。管理者・開発者だけに出す。
 *
 * 法人グループ×商品の単位で、期間全体の平均単価と数量合計を
 * 案件の参照列（出荷実績）として付ける。法人は名前の照合で
 * マスタ登録の法人へ対応づけ、品目は商品コードで一致させる。
 */
export default function HistImportCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [parsed, setParsed] = useState<{ p: HistParsed; name: string } | null>(null);
  const [result, setResult] = useState<HistResult | null>(null);
  const [err, setErr] = useState('');

  const onPick = async () => {
    const file = fileRef.current?.files?.[0];
    setParsed(null);
    setResult(null);
    setErr('');
    if (!file) return;
    setBusy(true);
    setProgress('ファイルを読み取っています...');
    try {
      await new Promise((r) => setTimeout(r, 50));
      const p = await (await histClient()).parseHistFile(file);
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
    try {
      const r = await (await histClient()).sendHistImport(parsed.p, parsed.name, (done, total) =>
        setProgress(`${done.toLocaleString()} / ${total.toLocaleString()}行を反映中...`));
      setResult(r);
      setProgress('');
      setParsed(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (e) {
      setErr((e as Error).message);
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="出荷実績（月別履歴）の取込">
      {err && <div className="alert error" onClick={() => setErr('')}>{err}</div>}
      {result && (
        <div className="alert ok" onClick={() => setResult(null)}>
          取り込みました: {result.rows.toLocaleString()}件
          {result.removed > 0 && ` ・ 今回の実績に無い行を ${result.removed.toLocaleString()}件削除`}
          （案件 {result.total.toLocaleString()}件）
        </div>
      )}
      <p className="pt-note" style={{ marginTop: 0 }}>
        <strong>案件一覧の土台</strong>です。法人×品目ごとの月別実績から、期間全体の
        <strong>平均出荷単価と数量合計</strong>を集計して案件を作ります。
        取り込むたびに、今回の実績にある法人×品目だけが残ります（マスタ登録のA基準はあとから重ねます）。
        法人名が空の行は取り込まず、すでに入っている空白の行も取込時に削除します。
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" ref={fileRef} accept=".xlsx,.xlsm" onChange={onPick} disabled={busy} />
        {parsed && (
          <>
            <span style={{ fontSize: 13 }}>
              {parsed.p.rows.length.toLocaleString()}行 ・ {parsed.p.corps.length.toLocaleString()}法人
              {parsed.p.period && `（${parsed.p.period}）`}
              {parsed.p.skippedBlank > 0 && ` ・ 法人名が空の行 ${parsed.p.skippedBlank.toLocaleString()}件は除外`}
            </span>
            <button className="btn" onClick={run} disabled={busy}>取り込む</button>
          </>
        )}
      </div>
      {progress && <p className="pt-note">{progress}</p>}
    </Card>
  );
}

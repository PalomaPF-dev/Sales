import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';
import AggImportCard from '../components/AggImportCard';
import SurveyImportCard from '../components/SurveyImportCard';
import type { Meta } from '../types';

/** 取込データの点検結果（数字だけになっている名前欄） */
interface Finding { column: string; label: string; param: string; value: string; deals: number }

/**
 * Excel取込。
 *
 * マスタ登録（値上げ結果の集約表）だけを取り込む。
 * A基準単価が更新されるため毎日取り込み直す運用で、
 * 同じ得意先×納入先×商品の行は上書きされ、
 * 決定単価（B基準）などアプリで入れた値は残る。
 * （旧・管理表ファイルの取込は廃止した）
 */
export default function ImportPage() {
  const me = useUser();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [blankCorp, setBlankCorp] = useState(0);
  const [cleaning, setCleaning] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  // 価格調査の「4月」が何年かは、マスタ登録の当月から決める
  const [meta, setMeta] = useState<Meta | null>(null);
  const canCheck = me.role === 'admin' || me.role === 'developer';
  const navigate = useNavigate();

  const load = () => {
    // 取込のたびに点検し直す（列ズレの値が入ったらすぐ気づけるように）
    if (canCheck) {
      api<Meta>('/meta').then(setMeta).catch(() => {});
      api<{ findings: Finding[]; blankCorp: number }>('/admin/data-check')
        .then((r) => { setFindings(r.findings); setBlankCorp(r.blankCorp ?? 0); })
        .catch(() => {});
    }
  };
  useEffect(load, []);

  const cleanBlank = async () => {
    if (!window.confirm(`法人名が空の案件 ${blankCorp.toLocaleString()}件を削除します。よろしいですか？`)) return;
    setCleaning(true);
    setMsg(null);
    try {
      const r = await api<{ removed: number; total: number }>(
        '/admin/cleanup-blank-corp', { method: 'POST' });
      setMsg({ kind: 'ok', text: `法人名が空の案件を ${r.removed.toLocaleString()}件削除しました（案件 ${r.total.toLocaleString()}件）` });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">Excel取込</h1>
      <p className="page-sub">
        <strong>①価格調査（毎日更新）</strong>が案件一覧の常のベースです
        （マスタ登録単価・目標単価・出荷単価・売上数が入り、毎日の取り込み直しで
        当月のマスタ単価が月別の実績履歴として残ります）。
        <strong>②売上高（月次）</strong>を取り込むと、ベースへ単価・数量を突合して
        その月の実績が重なります（売上高にだけある行も案件として残り、合計は必ず合います）。
        商談結果など画面で入れた値は残ります。
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      {canCheck ? (
        <>
          <AggImportCard onDone={load} />
          <SurveyImportCard anchorYm={meta?.aggMeta?.m0} onDone={load} />
        </>
      ) : (
        <Card title="取込">
          <p className="pt-note" style={{ marginTop: 0 }}>
            価格調査（毎日更新）・売上高の取込は管理者が行います。
          </p>
        </Card>
      )}

      {canCheck && blankCorp > 0 && (
        <Card title="法人名が空の案件">
          <div className="alert error" style={{ marginTop: 0 }}>
            法人名が入っていない案件が <strong>{blankCorp.toLocaleString()}件</strong> あります。
            案件一覧の絞り込みに「(空白)」として出てしまい、どの法人の案件か分かりません。
          </div>
          <p className="pt-note" style={{ marginTop: 0 }}>
            過去の取込で入り込んだ行です。今の取込では法人名が空の行は入りません。
            下のボタンで今すぐ消せます（価格調査の取り込み直しでも消えます）。
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn danger" onClick={cleanBlank} disabled={cleaning}>
              {cleaning ? '削除中...' : `法人名が空の案件を削除（${blankCorp.toLocaleString()}件）`}
            </button>
            <button
              className="btn secondary sm"
              onClick={() => navigate('/deals?corp=%28%E7%A9%BA%E7%99%BD%29')}
            >
              該当の案件を見る
            </button>
          </div>
        </Card>
      )}

      {canCheck && findings.length > 0 && (
        <Card title="取込データの点検">
          <div className="alert error" style={{ marginTop: 0 }}>
            名前が入るはずの欄に、数字だけの値が入っている明細があります。
            取込時の列ズレか入力ミスの可能性が高く、絞り込みの選択肢にも紛れ込みます。
          </div>
          <table className="tbl">
            <thead>
              <tr><th>欄</th><th>入っている値</th><th className="num">件数</th><th></th></tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={`${f.column}:${f.value}`}>
                  <td>{f.label}</td>
                  <td><strong>{f.value}</strong></td>
                  <td className="num">{f.deals.toLocaleString()}</td>
                  <td>
                    <button
                      className="btn secondary sm"
                      onClick={() => navigate(`/deals?${f.param}=${encodeURIComponent(f.value)}`)}
                    >
                      該当の案件を見る
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pt-note" style={{ marginTop: 10 }}>
            {me.role === 'developer'
              ? '案件一覧の「入力」か、案件を開いて「取込データの修正」で正しい値に直せます。'
              : '修正には開発者の権限が必要です。開発者アカウントでログインして直してください。'}
            元のファイル側を直して取り込み直しても直せます（同じ得意先×納入先×商品の行は上書きされます）。
          </p>
        </Card>
      )}

    </div>
  );
}

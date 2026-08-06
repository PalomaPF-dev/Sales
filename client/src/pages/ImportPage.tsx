import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Card } from '../components/ui';
import { useUser } from '../user';
import AggImportCard from '../components/AggImportCard';
import HistImportCard from '../components/HistImportCard';

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
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const canCheck = me.role === 'admin' || me.role === 'developer';
  const navigate = useNavigate();

  const load = () => {
    // 取込のたびに点検し直す（列ズレの値が入ったらすぐ気づけるように）
    if (canCheck) {
      api<{ findings: Finding[] }>('/admin/data-check')
        .then((r) => setFindings(r.findings))
        .catch(() => {});
    }
  };
  useEffect(load, []);

  return (
    <div>
      <h1 className="page-title">Excel取込</h1>
      <p className="page-sub">
        マスタ登録（値上げ結果の集約表）を取り込みます。
        A基準単価が更新されるため、<strong>毎日の取り込み直し</strong>を前提にしています。
        同じ得意先×納入先×商品の行は上書きされ、決定単価（B基準）など画面で入れた値は残ります。
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      {canCheck ? (
        <>
          <AggImportCard onDone={load} />
          <HistImportCard />
        </>
      ) : (
        <Card title="マスタ登録の取込">
          <p className="pt-note" style={{ marginTop: 0 }}>
            マスタ登録の取込は管理者が行います。最新の取込は下の履歴で確認できます。
          </p>
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

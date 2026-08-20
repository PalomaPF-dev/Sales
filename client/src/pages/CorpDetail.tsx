import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Card } from '../components/ui';

interface CorpDetailRes {
  corp_code: string;
  corp_name: string | null;
  deals: number;
  r2_done: number;
}

/**
 * 法人（企業）の概要ページ。
 * 交渉の入力は品目ごとに案件一覧の値上げ交渉で行うため、
 * ここは明細への入り口だけを置く（法人単位の交渉情報は廃止した）。
 */
export default function CorpDetail() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<CorpDetailRes | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api<CorpDetailRes>(`/corps/${encodeURIComponent(code)}`)
      .then(setData)
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, [code]);

  if (!data) {
    return (
      <div>
        {msg && <div className="alert error">{msg.text}</div>}
        <p style={{ color: 'var(--muted)' }}>読み込み中...</p>
      </div>
    );
  }

  return (
    <div>
      <a href="/deals" onClick={(e) => { e.preventDefault(); navigate('/deals'); }}>← 案件一覧へ戻る</a>
      <h1 className="page-title" style={{ marginTop: 8 }}>{data.corp_name}</h1>
      <p className="page-sub">
        法人コード {data.corp_code} ・ 明細 {Number(data.deals).toLocaleString()}件 ・
        完了 {Number(data.r2_done).toLocaleString()}件
      </p>
      {msg && <div className={`alert ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <Card title="この法人の明細">
        <p className="pt-note" style={{ margin: 0 }}>
          <a href={`/deals?corp=${encodeURIComponent(data.corp_code)}`}
             onClick={(e) => { e.preventDefault(); navigate(`/deals?corp=${encodeURIComponent(data.corp_code)}`); }}>
            案件一覧でこの法人の明細を表示する（{Number(data.deals).toLocaleString()}件）
          </a>
        </p>
        <p className="pt-note" style={{ marginTop: 8 }}>
          商談結果は商品（品目）ごとに変わるため、結果の詳細は案件一覧の
          <strong>商談メモ</strong>に品目ごとに残します。
        </p>
      </Card>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * 使い方のスライド。営業担当者が最初に見る前提で、
 * 「入力の仕方」「検索の仕方」「一覧の項目」を1枚ずつ短く見せる。
 * 文字だけで完結させ、画像は使わない（画面が変わっても古くならないように）。
 */

/** 一覧の項目説明で使う小さな表 */
function Terms({ rows }: { rows: [string, string][] }) {
  return (
    <table className="help-terms">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SLIDES: { title: string; body: React.ReactNode }[] = [
  {
    title: 'このアプリでできること',
    body: (
      <>
        <p>
          値上げ交渉の状況を、<b>会社全体で1つの表</b>で管理するアプリです。
          営業担当者の皆さんにお願いしたいのは、次の2つだけです。
        </p>
        <ol>
          <li><b>案件一覧</b>で自分の担当先の値上げ予定（マスタ登録単価・目標単価）を確認する</li>
          <li>商談をしたら、<b>商談結果</b>を入力する</li>
        </ol>
        <p className="help-note">
          単価のデータ（価格調査・売上高）は本社が毎日・毎月取り込みます。
          皆さんがExcelを触る必要はありません。
        </p>
      </>
    ),
  },
  {
    title: 'ログインの仕方',
    body: (
      <>
        <ol>
          <li>ログインIDは<b>社員番号</b>です</li>
          <li>初めての方は「<b>初めてログインする方はこちら</b>」から、自分でパスワードを決めます（10文字以上）</li>
          <li>パスワードを忘れたときは、ログイン画面の「<b>管理者への問い合わせ</b>」から連絡してください。管理者が再設定すると、もう一度自分で決め直せます</li>
        </ol>
        <p className="help-note">
          スマートフォンでも使えます。画面上部の「表示」ボタンで、スマホ向け・PC向けの見た目を切り替えられます。
        </p>
      </>
    ),
  },
  {
    title: '案件一覧の見方（1行＝得意先×商品）',
    body: (
      <>
        <p>案件一覧の1行は「<b>得意先×商品</b>」です。左から順に:</p>
        <Terms rows={[
          ['基本情報', '企業名・得意先名・納入先名・商品コード・器種名。器種名を押すと詳細（月別実績など）が開きます'],
          ['売上高（当月）', '当月の実績。過去最新単価 → 当月単価と、その上がり幅・数量'],
          ['数量の「出荷無」', '当月の出荷が無かった品目（売上高ファイルに数量0で載っている）'],
          ['「当月実績無し」', '価格調査には載っているが、当月の売上高ファイルに無かった品目'],
        ]} />
      </>
    ),
  },
  {
    title: '案件一覧の見方（単価の並び）',
    body: (
      <>
        <Terms rows={[
          ['マスタ登録単価', '実績（4月〜前日まで）→ 計画（当月・翌月・翌々月・3か月後の申請単価）の順。下段は承認日'],
          ['◀ 実績／計画 ▶', '見出しのボタンで、表示する月を1か月ずつずらせます'],
          ['目標単価', '本社が設定する交渉の目標。下段は当月マスタ単価との差額'],
          ['値上げ幅', '「マスタ登録単価 − 当月のマスタ単価」。1台あたりいくら上がるか'],
        ]} />
        <p className="help-note">
          金額の見方に迷ったら、見出しにカーソルを合わせる（スマホは長押し）と説明が出ます。
        </p>
      </>
    ),
  },
  {
    title: '検索・絞り込みの仕方',
    body: (
      <>
        <ol>
          <li><b>検索</b>: 得意先名・器種名などの一部を入れると候補が出ます。空白で区切ると絞り込み（AND）になります（例: 「岩谷 給湯」）</li>
          <li><b>絞り込み</b>: 企業名・支店・営業所・器具区分・担当者などから選べます。自分の名前を担当者に選ぶと、担当先だけになります</li>
          <li><b>並び替え</b>: 表の見出しを押すと並び替え。もう一度で逆順、3回目で元に戻ります</li>
        </ol>
        <p className="help-note">
          営業担当者は自分の支店の案件だけが表示されます。
        </p>
      </>
    ),
  },
  {
    title: '値上げ交渉の入力（1件ずつ）',
    body: (
      <>
        <p>商談をしたら、その品目の行の右端「<b>入力</b>」を押して記入します。</p>
        <Terms rows={[
          ['商談結果', '〇=合意 ／ □=広域待ち ／ △=否決 ／ ×=本社へ相談'],
          ['商談メモ', '商談の内容や補足を自由に（品目ごとに残ります）'],
          ['最終確定日', '単価が確定した日'],
          ['最終確定単価', '確定した単価（円）'],
          ['適用年月', '新単価を適用する月（例: 2026-10）'],
        ]} />
        <p>記入したら「<b>保存</b>」。すぐ一覧に反映されます。</p>
      </>
    ),
  },
  {
    title: 'まとめて入力（複数の品目に同じ結果）',
    body: (
      <>
        <p>同じ得意先で複数の品目をまとめて合意した、というときは一括入力が早いです。</p>
        <ol>
          <li>一覧の<b>商談結果の左にあるチェック</b>で品目を選ぶ（見出しのチェックで全選択）</li>
          <li>表の上の欄に、商談結果・商談メモ・最終確定日・最終確定単価・適用年月のうち<b>入れたい項目だけ</b>記入</li>
          <li>「<b>選択した品目へ一括入力</b>」を押す</li>
        </ol>
        <p className="help-note">
          空欄のままの項目は変更されません。「商談結果だけまとめて〇にする」といった使い方ができます。
        </p>
      </>
    ),
  },
  {
    title: '困ったときは',
    body: (
      <>
        <ul>
          <li>案件が表示されない・担当先が違う → 管理者へ連絡（支店の設定を確認します）</li>
          <li>パスワードを忘れた → ログイン画面の「管理者への問い合わせ」</li>
          <li>その他の質問・要望 → メニューの「<b>お問い合わせ</b>」から送ると、管理者から回答が届きます</li>
        </ul>
        <p className="help-note">
          この使い方は、メニューの「使い方」からいつでも見直せます。
        </p>
      </>
    ),
  },
];

export default function Help() {
  const [at, setAt] = useState(0);
  const navigate = useNavigate();
  const last = SLIDES.length - 1;
  const go = (n: number) => setAt(Math.max(0, Math.min(last, n)));

  // 矢印キーでもめくれるようにする（PCで説明会をするとき向け）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setAt((v) => Math.min(last, v + 1));
      if (e.key === 'ArrowLeft') setAt((v) => Math.max(0, v - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [last]);

  const s = SLIDES[at];
  return (
    <div className="help-wrap">
      <h1 className="page-title">使い方</h1>
      <div className="card help-slide" key={at}>
        <div className="help-step">{at + 1} / {SLIDES.length}</div>
        <h2>{s.title}</h2>
        <div className="help-body">{s.body}</div>
      </div>
      <div className="help-nav">
        <button className="btn secondary" disabled={at === 0} onClick={() => go(at - 1)}>← 前へ</button>
        <div className="help-dots">
          {SLIDES.map((x, i) => (
            <button key={x.title} className={i === at ? 'on' : ''} title={x.title}
                    aria-label={`${i + 1}枚目`} onClick={() => go(i)} />
          ))}
        </div>
        {at < last
          ? <button className="btn" onClick={() => go(at + 1)}>次へ →</button>
          : <button className="btn" onClick={() => navigate('/deals')}>案件一覧を開く</button>}
      </div>
    </div>
  );
}

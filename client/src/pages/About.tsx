import { useUser } from '../user';

/**
 * バックアップと仕様の説明。
 *
 * 「このアプリのデータはどこにあるのか」「消えたときに戻せるのか」「表の数字は
 * どう出しているのか」を、利用者と管理者の双方が確かめられるように1枚にまとめる。
 * フッターの「バックアップ・仕様の説明」から開く。
 *
 * ここに書くのは仕組みの話だけにする。運用の取り決め（誰がいつ取るか等）は
 * 変わりやすいので、ポータルの規約・運用文書を正とする。
 */
export default function About() {
  const me = useUser();
  const isDev = me.role === 'developer' || me.role === 'admin';

  return (
    <div>
      <h1 className="page-title">バックアップと仕様</h1>
      <p className="page-sub">
        このアプリのデータの置き場所・戻し方と、画面に出している数字の決まりをまとめています。
      </p>

      <div className="card">
        <h3>データの置き場所</h3>
        <ul className="about-list">
          <li>
            価格のデータは<strong>クラウドのデータベース（PostgreSQL）</strong>に保管しています。
            画面・Excel出力・集計はすべてこの1か所を見ているため、
            誰が見ても同じ数字になります。
          </li>
          <li>
            添付ファイル（見積書・稟議書類）は<strong>非公開の保管庫</strong>に置いています。
            URLを知っていても直接は開けず、必ずこのアプリを通し、
            その案件を見られる人かどうかを確かめてから渡します。
          </li>
          <li>
            取り込んだExcelそのものは保管しません。取込のたびに中身を読み取り、
            データベースへ反映します。
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>バックアップ</h3>
        <ul className="about-list">
          <li>
            データベースは<strong>クラウド側で自動的にバックアップ</strong>されます。
            ある時点まで戻す操作は、契約しているプランの範囲で行えます。
          </li>
          <li>
            それとは別に、<strong>全件を書き出す手動のバックアップ</strong>を用意しています
            （<code>npm run backup</code>）。
            クラウドの障害とは切り離して手元に控えを残すためのもので、
            案件・ユーザー・設定・取込の履歴などを丸ごと1ファイルに書き出します。
          </li>
          <li>
            日々の運用としては、<strong>案件一覧のExcel出力</strong>が実質の控えになります。
            絞り込んだ内容をそのまま書き出せるので、
            月次の締めのタイミングで残しておくと、後から見比べられます。
          </li>
          <li>
            取込は<strong>上書き</strong>です。誤ったファイルを取り込んだときは、
            正しいファイルを取り込み直せば元に戻ります。
            商談結果・商談メモ・最終確定日・最終確定単価は、
            取込の設定で<strong>残したまま更新</strong>もできます。
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>数字の決まり</h3>
        <ul className="about-list">
          <li>
            <strong>値上げ幅</strong> ＝ マスタ登録単価（A基準） − <strong>基準</strong>の単価。
            基準は「当月のマスタ単価」「当月の実単価」「過去最新単価」から選べます。
          </li>
          <li>
            <strong>値上げ額</strong> ＝ 値上げ幅 × <strong>当月の実績数</strong>。
            基準の単価が無い品目・当月の実績数が無い品目は
            <strong>変動なし</strong>（0円）として扱います。
          </li>
          <li>
            <strong>承認日</strong>は、案件を一覧から消すのではなく
            <strong>合計に入れるかどうか</strong>に効きます。
            案件はすべて表示したまま、条件に合うものだけを足します。
          </li>
          <li>
            <strong>翌月の計画</strong>は、承認日が当月より前（または未記入）のときは
            今回の値上げより前の古い申請とみなし、
            <strong>当月の計画をそのままスライド</strong>して出します。一覧では同じ色で示します。
          </li>
          <li>
            <strong>売上改善額</strong> ＝（当月のマスタ単価 − 過去最新単価）× 数量。
            すでに上がったぶんを表すもので、これからの値上げ額とは別に数えています。
          </li>
          <li>
            <strong>平均単価</strong>は、出荷数で重みを付けた平均
            （単価×実績数の合計 ÷ 実績数の合計）です。
            同じ品目・同じ数量で比べているため、
            （計画の平均 − 基準の平均）× 出荷数 が、その月の値上げ額と一致します。
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>見られる範囲</h3>
        <ul className="about-list">
          <li>営業担当者・支店長は<strong>自分の支店</strong>の案件を見られます。</li>
          <li>広域担当は<strong>担当する広域</strong>、本社・管理者は<strong>全社</strong>を見られます。</li>
          <li>
            閲覧専用のIDは<strong>全社の内容を見られますが、入力・変更はできません</strong>。
            検索・絞り込み・並び替え・Excel出力はそのまま使えます。
          </li>
          <li>実績原価は<strong>管理者・開発者だけ</strong>に出しています（社外秘に準ずる扱い）。</li>
        </ul>
      </div>

      {isDev && (
        <div className="card">
          <h3>管理者向け</h3>
          <ul className="about-list">
            <li>
              取込の履歴・メール通知の状態などは<strong>設定</strong>の画面で確かめられます。
            </li>
            <li>
              手動バックアップは、サーバーで <code>npm run backup</code> を実行します。
              出力先は <code>BACKUP_DIR</code>、残す世代数は <code>BACKUP_KEEP</code>（既定14）で変えられます。
            </li>
          </ul>
        </div>
      )}

      <p className="page-sub" style={{ marginTop: 18 }}>
        利用上の決まりは
        <a href="https://portal.paloma-pf.com/terms.html" target="_blank" rel="noopener noreferrer">
          共通利用規約・著作権ポリシー
        </a>
        （全アプリ共通）をご確認ください。
        操作の手引きは<strong>使い方</strong>の画面にあります。
      </p>
    </div>
  );
}

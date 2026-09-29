import type { ReactNode } from 'react';
import { Card } from './ui';
import { COLOR_NAMES, UNSET, EXCLUDED } from '../shipColor';
import type { ShipRulesRes } from '../shipColor';

const Sw = ({ color }: { color: string }) => (
  <i style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 3, verticalAlign: -2, marginRight: 8,
              background: color, border: '1px solid #ccc' }} />
);

const Sec = ({ title, children }: { title: string; children: ReactNode }) => (
  <Card title={title}>
    <div style={{ fontSize: 13.5, lineHeight: 1.9, color: 'var(--ink-2)' }}>{children}</div>
  </Card>
);

/** 一覧を「A・B・C」でつなぐ。長いときは件数にとどめる */
const joinOr = (list: string[] | undefined, max = 8) => {
  if (!list?.length) return '（なし）';
  return list.length > max ? `${list.slice(0, max).join('・')} ほか（全${list.length.toLocaleString()}件）` : list.join('・');
};

/**
 * 出荷実績（色分け）の仕様。何を取り込み、どの順で区分を決め、どう集計するかをまとめる。
 * 判定条件の数字（締め日・特定コード・件数など）は、いま保存されている値をそのまま出す。
 */
export default function ShipColorSpec({ info }: { info: ShipRulesRes | null }) {
  if (!info) return <p style={{ color: 'var(--muted)' }}>読み込み中...</p>;
  const r = info.rules;
  const cats = [...info.categories, UNSET, EXCLUDED];
  const how: Record<string, string> = {
    raised: '条件2（基準価格以上）・条件7（過去の最大単価を上回る）',
    ordered: '条件6（特定コード・期間指定）・条件8（受注日が締め日以前）',
    contract: '条件4（先方契約済物件リスト）',
    unsigned: '条件3（特定の法人・器種名）',
    nonpos: '自動では付かない。明細で手で選ぶ',
    other: '条件9-2・9-3（特定の器種名・対象機種）',
    unset: 'どの条件にも当たらなかった行。明細で目視確認して区分を選ぶ',
    excluded: '条件1（法人名が輸出）。集計・構成比に含めない',
  };
  const codeText = (list: { code: string; name: string; until: string }[]) => (list.length
    ? list.map((x) => `${x.code}${x.name ? ` ${x.name}` : ''}（${x.until ? `受注日 ${x.until} まで` : '期限なし'}）`).join('、')
    : '（なし）');
  const untils = [...new Set(r.periodCustomers.map((x) => x.until || '期限なし'))];

  return (
    <div style={{ maxWidth: 1000 }}>
      <Sec title="この機能について">
        毎日の出荷データ（MBの出荷明細）を取り込み、これまでExcelで手作業していた
        <strong>出荷単価の色塗り</strong>を、色塗り資料（まとめシート）の判定条件で<strong>自動で区分け</strong>します。
        区分ごとの件数・数量・出荷金額を集計し、Excelにも書き出せます。
        <br />
        案件一覧・ダッシュボード・平均単価など<strong>従来の機能とは別のデータ</strong>で、そちらの数字には影響しません。
        いまは<strong>管理者だけ</strong>が使えます。
      </Sec>

      <Sec title="毎日の流れ">
        <ol style={{ margin: 0, paddingLeft: '1.4em' }}>
          <li>MBから出荷明細（その月の分）をダウンロードし、「取込・判定条件」で取り込む。まだ取り込んでいない日が選ばれた状態になり、取り込むとすぐに自動で区分けされる</li>
          <li>「集計」の上に出る「未判定（目視確認）」を押し、明細で区分を選ぶ（選んだ区分は次の日からの判定にも使われる）</li>
          <li>「集計」で色別集計表を確認し、必要ならExcelに書き出す</li>
        </ol>
        <p className="pt-note" style={{ marginBottom: 0 }}>
          初めて使うときは、先に色塗り資料（基準価格・先方契約済物件・期間指定）と過去色塗り表を取り込んでください。
          基準価格や判定条件を直したときは「判定し直す」を押します。
        </p>
      </Sec>

      <Sec title="区分と色">
        <div className="tbl-scroll">
          <table className="tbl">
            <thead><tr><th>区分</th><th>色</th><th>決まり方</th></tr></thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.key}>
                  <td style={{ whiteSpace: 'nowrap' }}><Sw color={c.color} /><strong>{c.label}</strong></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{COLOR_NAMES[c.key]}</td>
                  <td>{how[c.key]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sec>

      <Sec title="判定条件（上から順に当てはめる）">
        原則として、先の条件で色が決まった行は後の条件で上書きしません（7だけは例外的に上書きします）。
        法人名・器種名は全角・半角（㈱と(株)、＋と+など）と空白の違いを無視して比べます。
        <div className="tbl-scroll" style={{ marginTop: 8 }}>
          <table className="tbl">
            <thead><tr><th>No</th><th>条件</th><th>区分</th><th>いまの設定</th></tr></thead>
            <tbody>
              <tr><td>対象</td><td>カテゴリー名大が対象のものだけを取り込む（それ以外は読み飛ばす）</td><td>—</td>
                <td>{joinOr(r.targetCategories)}</td></tr>
              <tr><td>1</td><td>法人名が対象外の名前なら判定しない</td><td>対象外</td><td>{joinOr(r.excludeCorps)}</td></tr>
              <tr><td>2</td><td>器種コードが基準価格シートの商品コード（中5桁）と一致し、出荷単価が基準価格（Q列）以上。未満なら色を付けず次へ</td>
                <td>値上済</td><td>基準価格 {info.basePrices.count.toLocaleString()}件</td></tr>
              <tr><td>3</td><td>特定の法人、器種名の先頭・末尾が特定の文字（除外する器種名あり）なら無条件で</td><td>値上単価未締結</td>
                <td>法人：{joinOr(r.pinkCorps)}<br />先頭：{joinOr(r.pinkPrefixes)}（除く：{joinOr(r.pinkExcept)}）<br />末尾：{joinOr(r.pinkSuffixes)}</td></tr>
              <tr><td>4</td><td>見積伝票番号が先方契約済物件リストにある</td><td>先方契約済物件リスト分</td>
                <td>{r.contractQuotes.length.toLocaleString()}件</td></tr>
              <tr><td>5</td><td>得意先・納入先・器種・ガス・出荷単価がすべて一致する過去の行があれば、その区分を引き継ぐ</td>
                <td>過去と同じ</td><td>前の日までに取り込んだ出荷データ（手で選んだ区分・ファイルの色を含む）。売上日 {r.historyFrom || '（指定なし）'} 以降</td></tr>
              <tr><td>6</td><td>法人コードが特定コード、または得意先コードが期間指定にある（期限は受注日で見る。売上日では見ない。期限があって受注日が無い行は当てず、未判定にする）</td>
                <td>受注分</td><td>特定コード：{codeText(r.greenCorpCodes)}<br />期間指定：{r.periodCustomers.length.toLocaleString()}件（期限：{untils.join('・') || '—'}）</td></tr>
              <tr><td>7</td><td>得意先・納入先・器種・ガスが一致する過去の行の最大単価を上回る。<strong>例外的に既存の色を上書きする</strong></td>
                <td>値上済</td><td>前の日までに取り込んだ出荷データ（区分を問わず最大単価）。売上日 {r.historyFrom || '（指定なし）'} 以降</td></tr>
              <tr><td>8</td><td>受注日が締め日以前</td><td>受注分</td><td>締め日 {r.orderCutoff || '（未設定）'}</td></tr>
              <tr><td>9-1</td><td>カテゴリー名大が指定のもので黄色なら、色なしに戻す</td><td>（色なし）</td><td>{r.kettleCategory || '（なし）'}</td></tr>
              <tr><td>9-2</td><td>器種名に特定の文字を含む</td><td>その他</td><td>{joinOr(r.grayKeywords)}</td></tr>
              <tr><td>9-3</td><td>器種名が対象機種と一致、または特定の文字で始まる</td><td>その他</td>
                <td>{joinOr(r.grayModels, 12)}<br />先頭：{joinOr(r.grayPrefixes)}</td></tr>
            </tbody>
          </table>
        </div>
        <p className="pt-note" style={{ marginBottom: 0 }}>
          どれにも当たらなかった行は「未判定（目視確認）」になります。設定は「取込・判定条件」の画面で直せます。
        </p>
      </Sec>

      <Sec title="区分の優先順位と、過去の色塗りの扱い">
        1つの明細の区分は <strong>手で選んだ区分 ＞ ファイルの色 ＞ 自動判定</strong> の順で決まります。
        <ul style={{ margin: '4px 0 0', paddingLeft: '1.4em' }}>
          <li>手で選んだ区分は売上伝票NOごとに保存し、同じ日を取り込み直しても残ります</li>
          <li>色塗り済みのファイル（過去色塗り表など）は、出荷単価のセルの色を区分として読み取ります</li>
          <li>後の日の判定（条件5・7）は、前の日までの最終的な区分を「過去の色塗り」として使います。
            そのため判定し直すときは古い日から順に行います</li>
        </ul>
      </Sec>

      <Sec title="取り込むデータ">
        <ul style={{ margin: 0, paddingLeft: '1.4em' }}>
          <li><strong>出荷データ</strong>：MBからダウンロードした出荷明細（1か月分が1シートのファイル、日ごとにシートを分けたファイル、CSV）を、
            <strong>売上日ごとに分けて</strong>古い日から1日ずつ取り込みます。同じ日を取り込み直すと置き換わります。
            毎日1か月分のファイルを取り込むときは、まだ取り込んでいない日だけが選ばれた状態になります</li>
          <li>判定の対象はカテゴリー名大が {joinOr(r.targetCategories)} の明細だけです（ロードヒーター・ビルトインなどは取り込みません）</li>
          <li>列は見出しの名前で探します（得意先コード・器種コード・出荷単価は必須）。列の並びが違っても読めます</li>
          <li><strong>原価・粗利の列は取り込みません</strong>（社外秘のため）</li>
          <li><strong>色塗り資料</strong>：「基準価格」「先方契約済物件」「期間指定」のシートを読み、入っているシートだけ置き換えます。
            期間指定の「9月末まで」などの書き込みは、下の行へ引き継いで期限の日付にします</li>
        </ul>
      </Sec>

      <Sec title="集計と書き出し">
        <ul style={{ margin: 0, paddingLeft: '1.4em' }}>
          <li><strong>色別集計表</strong>：区分ごとの件数・数量・出荷金額・構成比・平均単価（出荷金額÷数量）</li>
          <li><strong>内訳</strong>：区分 × カテゴリー（FH・PH・湯沸・PR）／器具区分／支店／法人／日</li>
          <li>期間は売上日で選びます。輸出（対象外）は構成比に含めません</li>
          <li><strong>Excel</strong>：集計表（色別集計＋内訳5枚）と明細（判定理由つき）を書き出せます。
            区分のセルは区分の色で塗ります（明細は「区分」と「出荷単価」のセル）。色のRGBは
            {info.categories.map((c) => `${c.label} ${c.color}`).join('、')}。未判定・対象外は色なしです</li>
        </ul>
      </Sec>
    </div>
  );
}

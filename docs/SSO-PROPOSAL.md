# 社内ポータルからのSSO — 仕様案

社内ポータル（NextAuth.js v4）にログイン済みの人が、値上げ管理アプリで
もう一度ログインせずに済むようにするための仕様案です。

この文書は**たたき台**です。ポータル側の作りによって選ぶ案が変わるため、
最後の「決めていただきたいこと」に答えていただければ確定できます。

---

## 1. 前提

- ポータルは NextAuth.js v4。パスワードのハッシュは bcryptjs で、本アプリと同方式
- 本アプリのテーブルは専用スキーマ `sales_pricing` にあり、ポータルのテーブルとは衝突しない
- 本アプリは Vercel + PostgreSQL。社内限定運用で、入口に Basic 認証をかけている
- 本アプリのユーザーは `users` 表で管理し、役割は `sales` / `branch_manager` / `planning` / `admin` の4種類

**現在のログインは残します。** SSOは追加の入口であって、置き換えではありません。
ポータルに登録がない人、SSOが落ちたとき、管理者が緊急で入るときのために、
ログインID/パスワードは併存させます。

---

## 2. 2つの案

### 案A：受け渡しトークン（HMAC署名）— **推奨**

ポータルが「この人は本人です」と署名した短命のトークンを発行し、
本アプリへリダイレクトで渡します。本アプリは署名を検証して自前のセッションを作ります。

```
ポータル                      本アプリ
   │  ①「値上げ管理」を押す
   │
   │  ② トークンを発行（60秒有効）
   │─────── リダイレクト ──────▶│
   │   /api/sso?token=...        │ ③ 署名・期限・使い回しを検証
   │                             │ ④ users から本人を特定
   │                             │ ⑤ 本アプリのセッションCookieを発行
   │◀────── /deals へ ──────────│
```

- ドメインが違っても動く
- ポータル側とアプリ側の結合が「共有鍵1つ」で済む
- ポータルは「誰に対して発行したか」を明示するので、事故が起きたときに追いやすい

### 案B：ポータルのセッションを直接検証

ポータルとアプリが同じ親ドメイン（例 `portal.paloma-pf.com` と `sales.paloma-pf.com`）に
ある場合、ポータルのセッションCookieを本アプリが直接検証する方法です。

- **NextAuthがJWT戦略の場合**：`NEXTAUTH_SECRET` を共有すれば本アプリでもCookieを読めます。
  ただしNextAuth v4のセッションCookieは**署名ではなく暗号化（JWE）**されており、
  復号には秘密鍵からHKDFで鍵を導出する必要があります。`jose` を入れれば実装できますが、
  「署名を検証するだけ」より手間がかかり、NextAuth側の実装に追従する必要も出ます。
  **ポータル側の改修はほぼ不要**という利点は残ります
- **NextAuthがデータベース戦略の場合**：ポータルの `sessions` 表を本アプリから参照します。
  DBを跨ぐ参照になるため、権限設計が必要です

手間は少ないのですが、ポータルの認証の秘密鍵そのものを本アプリと共有することになります。
本アプリが漏れるとポータル側のセッションも偽造できてしまうため、案Aより結合が強くなります。

### どちらを採るか

**案Aを推奨します。** 理由は3つです。

1. 共有するのは「このアプリ専用の鍵」なので、漏れてもポータル本体には波及しない
2. ドメイン構成に依存しない（別ドメインでも、将来アプリが増えても同じやり方で足りる）
3. 「いつ誰にトークンを出したか」がポータル側のログに残る

ただし、**ポータル側を触れない事情がある**場合は案Bが選択肢になります。
同じ親ドメインに置ける前提で、ポータルの改修なしに繋げられます。

以下は案Aの詳細です。

---

## 3. 案A の仕様

### 3.1 トークン形式

**JWT（HS256）** を使います。標準の形式なので、ポータル側は既存のライブラリ
（`jsonwebtoken` / `jose`）でそのまま発行できます。本アプリ側は `node:crypto` だけで
検証できるため、依存を増やしません。

### 3.2 クレーム

| 項目 | 必須 | 内容 | 例 |
|---|---|---|---|
| `iss` | ○ | 発行元。固定値 | `"portal"` |
| `aud` | ○ | 宛先。固定値。他アプリ向けトークンの流用を防ぐ | `"sales-pricing"` |
| `sub` | ○ | ポータル側のユーザーID（不変のもの） | `"u_01H8..."` |
| `login_id` | ○ | 本アプリの `users.login_id` に対応する値 | `"yamada.taro"` |
| `name` | ○ | 氏名。新規作成時と表示に使う | `"山田 太郎"` |
| `branch` | | 支店名。新規作成時に使う | `"東京中央"` |
| `office` | | 営業所名。新規作成時に使う | `"中央営業所"` |
| `email` | | 任意。記録用 | `"..."` |
| `iat` | ○ | 発行時刻（UNIX秒） | `1785500000` |
| `exp` | ○ | 失効時刻。`iat + 60`（60秒） | `1785500060` |
| `jti` | ○ | 1回限りの識別子。ランダム32文字以上 | `"9f3a..."` |

**`role` は入れません。** 役割（管理者かどうか等）は本アプリの管理者画面で管理します。
トークンに役割を持たせると、ポータル側の設定ミスや改ざんで管理者が作れてしまうためです。

### 3.3 検証手順（本アプリ側）

上から順に、1つでも失敗したら拒否します。

1. 署名が `PORTAL_SSO_SECRET` によるHS256として正しいこと（`timingSafeEqual` で比較）
2. `alg` が `HS256` であること（`none` や他アルゴリズムへの差し替えを拒否）
3. `iss` が `portal`、`aud` が `sales-pricing` であること
4. `exp` を過ぎていないこと（時計のずれを考慮して60秒の猶予）
5. `iat` が未来すぎないこと（同じく60秒の猶予）
6. `jti` が未使用であること（使用済みならリプレイとして拒否）
7. `login_id` に対応する `users` があり、`active = 1` であること

検証を通ったら `jti` を使用済みとして記録し、本アプリのセッションを作って
Cookieを発行します（既存のログインと同じ仕組み・同じ8時間）。

検証部分は依存ライブラリなしで書けます（動作確認済み）。

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(token, secret, { issuer, audience, skew = 60 }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('形式が不正です');
  const [h, p, s] = parts;

  const header = JSON.parse(Buffer.from(h, 'base64url'));
  if (header.alg !== 'HS256') throw new Error('署名方式が不正です');  // alg:none 対策

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new Error('署名が一致しません');
  }

  const c = JSON.parse(Buffer.from(p, 'base64url'));
  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== issuer) throw new Error('発行元が不正です');
  if (c.aud !== audience) throw new Error('宛先が不正です');
  if (typeof c.exp !== 'number' || now > c.exp + skew) throw new Error('有効期限が切れています');
  if (typeof c.iat !== 'number' || c.iat > now + skew) throw new Error('発行時刻が未来です');
  if (!c.jti || String(c.jti).length < 16) throw new Error('jtiが不正です');
  if (!c.login_id) throw new Error('login_idがありません');
  return c;  // 以降、jtiの使い回し確認とユーザー特定へ
}
```

鍵違い・本文の改ざん・`alg: none` への差し替え・期限切れ・宛先違い・発行元詐称を
それぞれ拒否することを確認しています。

### 3.4 リプレイ（使い回し）の防止

```sql
CREATE TABLE IF NOT EXISTS sso_used_tokens (
  jti        TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  used_at    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sso_expires ON sso_used_tokens(expires_at);
```

`expires_at` を過ぎた行は次回のSSO時にまとめて削除します（60秒しか残らないため件数は増えません）。

> 実装上の注意：この表は主キーが `jti` で `id` 列を持たないため、
> `server/db.js` の `TABLES_WITHOUT_ID` に `sso_used_tokens` を追加する必要があります。
> 追加を忘れると PostgreSQL で `column "id" does not exist` になります。

### 3.5 エンドポイント

```
GET /api/sso?token=<JWT>&next=<遷移先パス>
```

- 成功：セッションCookieを発行し、`next`（既定は `/deals`）へ302リダイレクト。
  **このときURLからトークンを落とします**（アドレス欄や履歴、ブックマークに残さないため）
- 失敗：ログイン画面へ302で戻し、理由を画面に出す
  （「リンクの有効期限が切れました。ポータルからもう一度お開きください」など）

`next` は `/` で始まる相対パスのみ許可します。`//example.com` のような値は
外部サイトへ飛ばされる（オープンリダイレクト）ため拒否します。

### 3.6 ユーザーの対応づけ

`login_id` で突き合わせます。ポータルと本アプリで同じログインIDを使う前提です。

登録がない人が来たときの扱いは2通りあり、**既定は「自動で作る」を推奨**します。

| 方式 | 内容 |
|---|---|
| 自動で作る（推奨） | `role = 'sales'`（最小権限）で作成し、`name` / `branch` / `office` をトークンから設定。管理者への昇格は本アプリの管理者画面で行う |
| 拒否する | 事前に一括登録した人だけを通す。`PORTAL_SSO_AUTO_CREATE=false` で切り替え |

自動作成でも役割は必ず `sales` から始まるため、勝手に強い権限が付くことはありません。

### 3.7 環境変数

| 変数 | 必須 | 内容 |
|---|---|---|
| `PORTAL_SSO_SECRET` | ○ | ポータルと共有する署名鍵。32バイト以上。**本番と検証で別の値にする** |
| `PORTAL_SSO_AUTO_CREATE` | | `false` で未登録者を拒否（既定は自動作成） |
| `PORTAL_SSO_ISSUER` | | `iss` の期待値（既定 `portal`） |

未設定のときはSSOのエンドポイントごと無効にします（誤って鍵なしで開かないように）。

鍵の生成例：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

### 3.8 ポータル側の実装（参考）

```js
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';

// 「値上げ管理」リンクを押されたときのハンドラ
export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.redirect('/login');

  const token = jwt.sign({
    iss: 'portal',
    aud: 'sales-pricing',
    sub: session.user.id,
    login_id: session.user.loginId,
    name: session.user.name,
    branch: session.user.branch,
    office: session.user.office,
    jti: randomBytes(24).toString('base64url'),
  }, process.env.PORTAL_SSO_SECRET, { algorithm: 'HS256', expiresIn: 60 });

  res.redirect(`https://sales.example.com/api/sso?token=${encodeURIComponent(token)}`);
}
```

ポータル側で必要なのは、**この1画面だけ**です。

---

## 4. Basic認証との関係（判断が必要です）

現在、本アプリの入口にはBasic認証がかかっています。SSOを入れても
**Basic認証は別の層なので、そのままでは利用者に認証ダイアログが出ます。**

選択肢は3つです。

| 方式 | 利用者から見た動き | 評価 |
|---|---|---|
| Basic認証を残す | ブラウザごとに一度だけBasic認証を入力。以降はSSOで素通り | 手間は初回のみ。**当面はこれで十分** |
| IP制限に置き換える | Basic認証なし。社内ネットワークからのみ到達可 | 体験は最良。VercelのTrusted IPsはEnterpriseプランが必要 |
| SSOの入口だけ除外 | `/api/sso` のみBasic認証を免除 | トークンが署名済みなので穴にはならないが、遷移先の `/deals` で結局ダイアログが出るため**意味がありません** |

「Basic認証を残す」を推奨します。SSOの目的は「毎回のログインID/パスワード入力をなくす」ことで、
ブラウザが記憶する初回1回のBasic認証は実用上の負担になりにくいためです。

---

## 5. 作業量の見積り

| 作業 | 担当 | 目安 |
|---|---|---|
| トークン発行の画面を1つ追加 | ポータル側 | 半日 |
| 検証エンドポイント・リプレイ防止・自動作成 | 本アプリ側 | 1日 |
| 結合確認（正常系・期限切れ・改ざん・使い回し） | 双方 | 半日 |

本アプリ側は依存ライブラリを増やさずに実装できます（HS256の検証は `node:crypto` で足ります）。

---

## 6. 決めていただきたいこと

これらが決まれば実装に入れます。

1. **案Aと案Bのどちらにするか**（案Bを検討する場合、ポータルのNextAuthは
   JWT戦略とデータベース戦略のどちらか／同じ親ドメインに置けるか）
2. **ポータル側の改修を誰が行うか**（別チームの場合、この文書をそのまま渡せます）
3. **ログインIDはポータルと本アプリで同じ値か**（違う場合、何で突き合わせるか）
4. **未登録の人を自動で作ってよいか**（推奨は「作る、ただし権限は営業担当者から」）
5. **共有鍵をどこで受け渡すか**（本番と検証で別の値にします）

未確定のままでも、こちらで仮の鍵を使った実装と単体の検証まで進めることはできます。
その場合はポータル側の準備ができ次第、鍵を差し替えて結合確認となります。

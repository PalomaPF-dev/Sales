# デプロイ手順

構成は **Vercel（アプリ）＋ PostgreSQL（データベース）** です。
Vercelのサーバーレス関数はファイルシステムが揮発性のため、データはPostgreSQLに保存します。

> ブラウザだけで設定を完了したい場合は **[SETUP-WEB.md](SETUP-WEB.md)** を参照してください。

```
利用者 ──▶ Vercel Edge Middleware（Basic認証）
              ├─▶ 静的ファイル（画面）      … Vercel CDN
              └─▶ /api/*（Express関数）──▶ PostgreSQL（データ永続化）
```

---

## 1. データベースの用意

社内のPostgreSQLに接続します。次の形式の接続文字列を用意してください。

```
postgres://ユーザー名:パスワード@ホスト名:5432/データベース名
```

テーブルは専用スキーマ **`sales_pricing`**（`DB_SCHEMA` で変更可）に作成されるため、
同じDBにある既存テーブル（ポータルの `users` / `sessions` など）と衝突しません。
スキーマは初回アクセス時に自動作成されるので、事前のSQL実行は不要です。

> **接続経路の確認**: VercelはインターネットからPostgreSQLへ接続します。
> 社内ネットワーク内にしか無いDBの場合は到達できないため、情報システム部門に
> 接続可否をご確認ください。難しい場合は末尾の「自社サーバーで運用する場合」に切り替えられます。

## 2. 初期データの投入

スキーマとマスタ（単価種別6種・承認ルール・ユーザー）は**アプリの初回アクセス時に自動作成**されます。
管理表の取込は、リクエストサイズ上限を避けるため**手元のPCからCLIで実行**してください。

```bash
git clone <このリポジトリ> && cd Sales
npm install

export DATABASE_URL="postgres://ユーザー:パスワード@ホスト:5432/DB名"

# 現行の管理表を投入（器具ごとのファイルを順に指定）
npm run import -- FH風呂釜.xlsx 業務部品.xlsx ビルトイン.xlsx

# 入れ直す場合は既存データを消してから
npm run import -- 管理表.xlsx --replace
```

> 同じ内容のファイルは既定でスキップされます（明細が二重になり、値上げ金額が二倍になるため）。
> 意図的に入れ直すときだけ `--force` を付けてください。

> 画面の「Excel取込」からも取り込めます。ブラウザ側でExcelを読み、行データだけを分割して送るため、
> Vercelのリクエスト上限（約4.5MB）に関係なく、大きい管理表でもそのまま取り込めます。

## 3. Vercelへのデプロイ

```bash
npm i -g vercel
vercel link            # プロジェクト prj_2PBLXhb6epFtiM3t5xAdKCMknjBT を選択

# 環境変数（Production / Preview 双方に設定）
vercel env add DATABASE_URL production
vercel env add BASIC_AUTH_USER production
vercel env add BASIC_AUTH_PASS production

vercel --prod
```

Vercelダッシュボードから設定する場合は **Settings → Environment Variables** に同じものを登録します。

### 環境変数

| 変数 | 必須 | 内容 |
|---|---|---|
| `DATABASE_URL` | ○ | PostgreSQLの接続文字列。未設定だとローカルSQLiteを見に行き、データが保存されません |
| `BASIC_AUTH_USER` | ○ | サイト全体にかけるBasic認証のユーザー名（例: `sales`） |
| `BASIC_AUTH_PASS` | ○ | 同上のパスワード。半角英数32文字程度を推奨（下記「本番の認証設定」参照） |
| `DB_SCHEMA` | | テーブルを作成するスキーマ名（既定: `sales_pricing`） |
| `DB_SSL_NO_VERIFY` | | `true` でTLS証明書の検証を緩める（社内認証局を使っている場合） |
| `DISPLAY_TZ` | | 画面に出す時刻の時間帯（既定: `Asia/Tokyo`）。通常は設定不要 |

`DISABLE_AUTH` と `DEV_LOGIN_AS` は認証を省略するための開発用の設定です。
**本番（Vercel）では設定されていても無視され、必ずログインを求めます。**
取り違えて設定したときに価格データが認証なしで公開されてしまうためです。

## 4. デプロイ後の確認

```bash
# ヘルスチェック（認証不要・DB接続と件数を返す）
curl https://<デプロイ先>/api/health
# → {"status":"ok","db":"postgres","deals":23024,"authProtected":true,...}

# 未ログインでは価格データが返らないこと（401であること）
curl -o /dev/null -w "%{http_code}\n" -u 'sales:<パスワード>' https://<デプロイ先>/api/deals
```

`deals` が 0 の場合は取込（手順2）が未実行か、環境変数の設定先（Production/Preview）が違います。
認証まわりの詳しい確認方法は「本番の認証設定」を参照してください。

## 5. 最初のログインユーザーを作る

初期状態では誰もパスワードを持たないため、ログインできません。
手元から本番DBに対してパスワードを設定します。

```bash
export DATABASE_URL="postgres://..."

npm run set-password -- --list        # ログインIDの一覧
npm run set-password -- planning1     # 仮パスワードを生成して表示
```

表示された仮パスワードでログインし、画面の指示に従って変更してください。
以降の担当者の追加は「ユーザー管理」画面から行えます。

---

## 本番の認証設定

### 設定するもの

Vercelの **Settings → Environment Variables** に、Production / Preview の双方へ登録します。

```
BASIC_AUTH_USER=sales
BASIC_AUTH_PASS=<半角英数32文字程度のパスワード>
```

パスワードは使い回さず、下記のように生成した値を使ってください。

```bash
node -e "const{randomBytes:r}=require('node:crypto');const c='abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';const b=r(32);let s='';for(let i=0;i<32;i++)s+=c[b[i]%c.length];console.log(s)"
```

半角英数のみにしているのは、Basic認証のパスワードに日本語や記号を使うと、
ブラウザや機器によって送られ方が変わり、入力しても通らないことがあるためです。

### 設定する順番（重要）

**Basic認証は、利用者にURLを知らせる前に設定してください。**

アプリはまだ誰もパスワードを持っていない間だけ「初期セットアップ」画面を開きます。
この画面は、その時点ではログインなしで到達できます（誰も入れない状態を解消するために必要なため）。
URLが知られている状態でここが開いていると、先に管理者のパスワードを設定されてしまいます。
Basic認証を先に入れておけば、その手前で止まります。

1. `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` を設定してデプロイする
2. 初期セットアップ、または `npm run set-password` で最初の管理者のパスワードを決める
3. そのあとで利用者にURLとBasic認証の情報を伝える

一度セットアップが済むと初期セットアップ画面は無効になり、以降は開きません。

### 保護の構成

保護は3層になっています。

1. **Basic認証**（サイト全体の入口）
   Edge Middleware（`middleware.js`）が、画面ファイルを含む全リクエストの手前で認証します。
   監視から到達できるよう `/api/health` のみ免除しています。
   Vercelは既定でインターネットに公開されるため、社外からURLを踏まれてもここで止まります。

2. **アプリのログイン**（常時有効・止められません）
   個人ごとのログインID/パスワード。未ログインでは価格データを含む全APIが401を返します。
   - パスワードは bcrypt でハッシュ化して保存（社内ポータルのNextAuthと同方式のため、
     同じ `users` 表を共有しても双方で検証・更新できます）
   - セッションはDBで管理し、Cookieは HttpOnly / SameSite=Lax / HTTPS時は Secure
   - Cookieの値そのものはDBに保存せず、SHA-256にして保管（DBが漏れても乗っ取れません）
   - 有効期間は8時間。パスワード変更時はそのユーザーの全セッションを無効化
   - ログインに5回失敗すると15分ロック（解除時刻は日本時間で表示）
   - 変更操作は本人のセッションに紐づくため、「誰が変更したか」が記録として残ります

3. **Vercel Authentication**（Vercelの機能）
   `*.vercel.app` のURLに対して、Vercelアカウントを持つチームメンバーのみ
   アクセスを許可する保護です。**カスタムドメインには適用されません**（後述）。

### 確認方法

デプロイ後、次の3つを確認してください。

```bash
# 1. Basic認証なしでは入れない（401であること）
curl -o /dev/null -w "%{http_code}\n" https://<デプロイ先>/

# 2. Basic認証だけでは価格データが取れない（401であること）
curl -o /dev/null -w "%{http_code}\n" -u 'sales:<パスワード>' https://<デプロイ先>/api/deals

# 3. ヘルスチェックは認証なしで到達でき、保護が有効と出ること
curl https://<デプロイ先>/api/health
# → {"status":"ok","db":"postgres","deals":23024,"authProtected":true,...}
```

`authProtected` が `false` の場合は `BASIC_AUTH_*` が設定されていないか、
設定先（Production / Preview）が違います。

## 独自ドメイン（例: sales.paloma-pf.com）の設定

### 1. Vercelにドメインを追加

Vercelのプロジェクト → Settings → Domains で `sales.paloma-pf.com` を追加します。

### 2. DNSレコードを追加

`paloma-pf.com` のDNSに、Vercelの画面に表示される内容でレコードを追加します。
サブドメインの場合は通常CNAMEです。

```
種別    名前     値
CNAME   sales    cname.vercel-dns.com
```

反映後、Vercelが自動でTLS証明書を発行します（数分〜数十分）。

### 3. 保護の見直し（重要）

Vercel Authentication の適用範囲は既定で **`*.vercel.app` のみ（カスタムドメインは対象外）** です。
そのため独自ドメインを割り当てると、**そのURLはインターネットから到達可能になります**。

アプリ自身のログインで保護されているため価格データが漏れることはありませんが、
ログイン画面自体は社外からも見える状態になります。社内限定で運用するため、
本アプリでは下表の**Basic認証を標準の構成として設定します**（「本番の認証設定」参照）。
より強く絞りたい場合は他の方法も併用できます。

| 方法 | 内容 |
|---|---|
| Basic認証（本アプリの標準） | `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` を設定する。Edge Middlewareはカスタムドメインにも適用されるため、これが最も簡単で確実な方法です |
| Vercelの保護範囲を変更 | Settings → Deployment Protection で、保護対象にカスタムドメインを含める（プランにより可否あり） |
| IP制限 | Vercelの Trusted IPs で社内グローバルIPからのみ許可（Enterpriseプラン） |

### 4. 確認

```bash
curl -o /dev/null -w "%{http_code}\n" https://sales.paloma-pf.com/api/deals   # → 401
curl https://sales.paloma-pf.com/api/health                                    # → status: ok
```

なお、アプリ側にホスト名の直書きはなく、CookieにもDomain属性を付けていないため、
ドメイン変更にともなうコード修正は不要です。

## バックアップ

PostgreSQL側のバックアップ運用に加えて、論理バックアップも取得できます。

```bash
export DATABASE_URL=postgres://...
npm run backup                 # backups/app-<日時>.json に全テーブルを出力
BACKUP_KEEP=30 npm run backup  # 保持世代数を変更（既定14）
```

---

## 別案: 自社サーバー / コンテナで運用する場合

Vercelを使わず、永続ディスクのあるサーバーで運用する構成も同梱しています。
この場合は外部DBが不要で、SQLiteファイルをそのまま使えます。

### Docker

```bash
cp .env.example .env     # BASIC_AUTH_USER / PASS を設定
docker compose up -d
docker compose exec app node scripts/import.js /path/to/管理表.xlsx
```

DBは名前付きボリューム `app-data` に永続化されます。

> 注: 本リポジトリのDockerfileは、開発環境からDocker Hubへの接続が
> 組織のポリシーで遮断されていたためイメージビルドの実地検証ができていません。
> 初回ビルド時はエラーが出ないか確認してください。

### systemd

`deploy/` 配下にユニットファイルを同梱しています。

```bash
sudo useradd -r -s /bin/false sales
sudo mkdir -p /opt/sales-pricing /var/lib/sales-pricing
sudo cp -r . /opt/sales-pricing && cd /opt/sales-pricing
sudo npm ci --omit=dev && sudo npm run build
sudo chown -R sales:sales /var/lib/sales-pricing

# 認証情報
echo 'BASIC_AUTH_USER=sales'   | sudo tee /etc/sales-pricing.env
echo 'BASIC_AUTH_PASS=<パスワード>' | sudo tee -a /etc/sales-pricing.env
sudo chmod 600 /etc/sales-pricing.env

sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/
sudo systemctl enable --now sales-pricing sales-pricing-backup.timer
```

日次バックアップ（毎日2:00・14世代保持）が `sales-pricing-backup.timer` で動作します。
リバースプロキシ（nginx等）でHTTPS終端することを推奨します。

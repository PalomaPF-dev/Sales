# デプロイ手順

構成は **Vercel（アプリ）＋ Turso（データベース）** です。
Vercelのサーバーレス関数はファイルシステムが揮発性のため、DBはTurso（SQLite互換のマネージドDB）に置きます。

```
利用者 ──▶ Vercel Edge Middleware（Basic認証）
              ├─▶ 静的ファイル（画面）      … Vercel CDN
              └─▶ /api/*（Express関数）──▶ Turso（データ永続化）
```

---

## 1. Turso データベースの作成

```bash
# CLIのインストール（初回のみ）
curl -sSfL https://tur.so/install.sh | bash
turso auth login

# DBを作成（リージョンは東京 nrt。アプリ側も東京 hnd1 で動かすため合わせる）
turso db create sales-pricing --location nrt

# 接続情報を取得（この2つをVercelの環境変数に設定します）
turso db show sales-pricing --url        # → TURSO_DATABASE_URL
turso db tokens create sales-pricing     # → TURSO_AUTH_TOKEN
```

無料プランで動作します（本アプリのデータ量は23,000行・約3MB程度）。

> **リージョンを揃えてください。** `vercel.json` でアプリの実行リージョンを東京（`hnd1`）に指定しています。
> DBを別リージョン（例: 米国）に作ると1リクエストごとに複数回の太平洋往復が発生し、
> 画面表示が目に見えて遅くなります。

## 2. 初期データの投入

スキーマとマスタ（単価種別6種・承認ルール・ユーザー）は**アプリの初回アクセス時に自動作成**されます。
管理表の取込は、リクエストサイズ上限を避けるため**手元のPCからCLIで実行**してください。

```bash
git clone <このリポジトリ> && cd Sales
npm install

export TURSO_DATABASE_URL="libsql://sales-pricing-xxxx.turso.io"
export TURSO_AUTH_TOKEN="eyJ..."

# 現行の管理表を投入（器具ごとのファイルを順に指定）
npm run import -- FH風呂釜.xlsx 業務部品.xlsx ビルトイン.xlsx

# 入れ直す場合は既存データを消してから
npm run import -- 管理表.xlsx --replace
```

> 画面の「Excel取込」からもアップロードできますが、Vercelのリクエスト上限（約4.5MB）を超えるファイルは
> このCLIから投入してください。

## 3. Vercelへのデプロイ

```bash
npm i -g vercel
vercel link            # プロジェクト prj_2PBLXhb6epFtiM3t5xAdKCMknjBT を選択

# 環境変数（Production / Preview 双方に設定）
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production
vercel env add BASIC_AUTH_USER production
vercel env add BASIC_AUTH_PASS production

vercel --prod
```

Vercelダッシュボードから設定する場合は **Settings → Environment Variables** に同じ4つを登録します。

### 環境変数

| 変数 | 必須 | 内容 |
|---|---|---|
| `TURSO_DATABASE_URL` | ○ | `libsql://...` 未設定だとローカルSQLiteを見に行き、データが保存されません |
| `TURSO_AUTH_TOKEN` | ○ | Tursoのアクセストークン |
| `BASIC_AUTH_USER` | 任意 | サイト全体にかける追加のBasic認証。インターネット公開時に推奨 |
| `BASIC_AUTH_PASS` | 任意 | 同上。十分に長いパスワードを設定してください |

アプリ本体は個人ごとのログインID/パスワードで保護されており、未ログインでは
価格データを含む全APIが401を返します。`BASIC_AUTH_*` はその手前に置く任意の追加の壁です。

## 4. デプロイ後の確認

```bash
# ヘルスチェック（認証不要・DB接続と件数を返す）
curl https://<デプロイ先>/api/health
# → {"status":"ok","db":"turso","deals":23024,"authProtected":false,...}

# 未ログインでは価格データが返らないこと（401であること）
curl -o /dev/null -w "%{http_code}\n" https://<デプロイ先>/api/deals
```

`deals` が 0 の場合は取込（手順2）が未実行か、環境変数の設定先（Production/Preview）が違います。

## 5. 最初のログインユーザーを作る

初期状態では誰もパスワードを持たないため、ログインできません。
手元から本番DBに対してパスワードを設定します。

```bash
export TURSO_DATABASE_URL="libsql://..."
export TURSO_AUTH_TOKEN="..."

npm run set-password -- --list        # ログインIDの一覧
npm run set-password -- planning1     # 仮パスワードを生成して表示
```

表示された仮パスワードでログインし、画面の指示に従って変更してください。
以降の担当者の追加は「ユーザー管理」画面から行えます。

---

## アクセス保護について

保護は2層になっています。

1. **アプリのログイン**（必須・常時有効）
   個人ごとのログインID/パスワード。未ログインでは全APIが401を返します。
   パスワードはscryptでハッシュ化して保存し、セッションはHttpOnly Cookieで管理します。
   承認操作は本人のセッションに紐づくため、「誰が承認したか」が記録として残ります。

2. **Basic認証**（任意）
   `BASIC_AUTH_*` を設定した場合のみ有効。Edge Middleware（`middleware.js`）が
   静的ファイルを含む全リクエストの手前で認証します。`/api/health` のみ免除しています。
   インターネットに公開する場合の追加の壁で、社内ネットワーク限定なら不要です。

3. **Vercel Authentication**（Vercelの機能）
   `*.vercel.app` のURLに対して、Vercelアカウントを持つチームメンバーのみ
   アクセスを許可する保護です。**カスタムドメインには適用されません**（後述）。

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
ログイン画面自体は社外からも見える状態になります。社内限定で運用したい場合は、
次のいずれかを併用してください。

| 方法 | 内容 |
|---|---|
| Basic認証 | `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` を設定する。Edge Middlewareはカスタムドメインにも適用されるため、これが最も簡単な方法です |
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

Turso側にも自動バックアップ（PITR）がありますが、論理バックアップも取得できます。

```bash
export TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=...
npm run backup                 # backups/app-<日時>.json に全テーブルを出力
BACKUP_KEEP=30 npm run backup  # 保持世代数を変更（既定14）
```

---

## 別案: 自社サーバー / コンテナで運用する場合

Vercelを使わず、永続ディスクのあるサーバーで運用する構成も同梱しています。
この場合Tursoは不要で、SQLiteファイルをそのまま使います。

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

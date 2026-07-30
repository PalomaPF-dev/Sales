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

# DBを作成（リージョンは東京 nrt を推奨）
turso db create sales-pricing --location nrt

# 接続情報を取得（この2つをVercelの環境変数に設定します）
turso db show sales-pricing --url        # → TURSO_DATABASE_URL
turso db tokens create sales-pricing     # → TURSO_AUTH_TOKEN
```

無料プランで動作します（本アプリのデータ量は23,000行・約3MB程度）。

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
| `BASIC_AUTH_USER` | ○ | 社内限定公開のためのID |
| `BASIC_AUTH_PASS` | ○ | 十分に長いパスワードを設定してください |

`BASIC_AUTH_*` が未設定だと**認証なしで全価格データが公開される**ため、必ず設定してください。
起動時に警告ログを出しますが、設定漏れを防ぐのは運用側の責任になります。

## 4. デプロイ後の確認

```bash
# 認証なしで401が返ること（＝保護されている）
curl -o /dev/null -w "%{http_code}\n" https://<デプロイ先>/

# ヘルスチェック（認証不要・DB接続と件数を返す）
curl https://<デプロイ先>/api/health
# → {"status":"ok","db":"turso","deals":23024,...}

# 認証ありで画面が返ること
curl -o /dev/null -w "%{http_code}\n" -u sales:<パスワード> https://<デプロイ先>/
```

`deals` が 0 の場合は取込（手順2）が未実行か、環境変数の設定先（Production/Preview）が違います。

---

## アクセス保護について

Edge Middleware（`middleware.js`）が**静的ファイルを含む全リクエスト**の手前でBasic認証を行います。
`/api/health` のみ監視のため認証を免除しています。

現在の個人単位の認証は**プロトタイプのまま**（画面でユーザーを選択する方式）です。
Basic認証を知っていれば誰の名義でも承認操作ができるため、
**「誰が承認したか」を証跡として残す運用に進む場合はSSO等の導入が必要**です。
社内限定での試用・評価段階であれば現構成で問題ありません。

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

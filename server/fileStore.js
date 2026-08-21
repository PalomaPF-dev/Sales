// 添付ファイル（見積書・稟議書類など）の保管先。
//
// 価格データと同じ Supabase に置く（Storage の非公開バケット）。
// 保管先が1か所にまとまるので、バックアップも退避も費用も1本で済む。
//
// 非公開バケットなので、URLを知っていても読めない。ダウンロードは必ず
// このアプリを経由し、案件スコープの確認（findDealInScope）を通したうえで
// サーバーが取得して中継する。保管庫の場所はブラウザへ返さない。
//
// 環境変数:
//   SUPABASE_SERVICE_ROLE_KEY … 保管庫への読み書きに使う鍵（必須）
//   SUPABASE_URL              … 省略時は DATABASE_URL の利用者名から組み立てる
//   SUPABASE_BUCKET           … 保管庫の名前（既定: attachments）
//
// 鍵が未設定のローカル開発では、従来どおり DB(base64) に保存するため
// 追加設定なしでそのまま動く。

/** 保管庫の中でこのアプリの領域を示す区画分け */
const APP_PREFIX = 'sales';

// このアプリ専用の保管庫。Supabaseのプロジェクトは他システムと共用のため、
// 名前でどのアプリのものか分かるようにする
export const fileBucket = () => process.env.SUPABASE_BUCKET || 'sales-attachments';

const serviceKey = () => (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

/**
 * SupabaseのAPIの入口（https://<ref>.supabase.co）。
 *
 * 明示の設定が無ければ接続文字列から組み立てる。プーラー経由の利用者名は
 * 「postgres.<プロジェクトの符号>」の形をしており、ここから引ける。
 * 設定を1つ（鍵だけ）で済ませるための補いで、うまく引けなければ未設定と同じ。
 */
export function supabaseUrl() {
  const explicit = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  try {
    const u = new URL(raw);
    // aws-0-〜.pooler.supabase.com は 利用者名 postgres.<ref>
    const fromUser = /^postgres\.([a-z0-9]{16,})$/i.exec(decodeURIComponent(u.username));
    if (fromUser) return `https://${fromUser[1]}.supabase.co`;
    // db.<ref>.supabase.co の直接接続
    const fromHost = /^db\.([a-z0-9]{16,})\.supabase\.co$/i.exec(u.hostname);
    if (fromHost) return `https://${fromHost[1]}.supabase.co`;
  } catch {
    // URL形式でなければ組み立てない
  }
  return '';
}

/** 保管庫が使える構成か。false なら呼び出し元は DB 保存へフォールバックする。 */
export function isFileStoreConfigured() {
  return Boolean(serviceKey() && supabaseUrl());
}

/** パスに使えない文字を落とす（パストラバーサル・不正文字の遮断） */
function sanitize(seg) {
  return String(seg).replace(/[^\w.\-]/g, '_').slice(0, 120) || 'file';
}

/** 推測できない文字列。同じ名前のファイルがぶつからないようにもする */
function randomTag() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

const objectUrl = (key) =>
  `${supabaseUrl()}/storage/v1/object/${encodeURIComponent(fileBucket())}/${
    key.split('/').map(encodeURIComponent).join('/')}`;

const authHeaders = () => ({
  Authorization: `Bearer ${serviceKey()}`,
  apikey: serviceKey(),
});

/**
 * 添付を保管庫へ置き、その場所（保管庫の中のパス）を返す。
 * 返り値は attachments.blob_url に入れる。URLではなくパスなので、
 * 保管先を変えても記録がそのまま使える。
 */
export async function putAttachment({ dealId, filename, mimeType, body }) {
  if (!isFileStoreConfigured()) throw new Error('SUPABASE_SERVICE_ROLE_KEY が未設定です');
  const key = `${APP_PREFIX}/${sanitize(dealId ?? 'nodeal')}/${Date.now()}_${randomTag()}_${
    sanitize(filename)}`;
  const res = await fetch(objectUrl(key), {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': mimeType || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // 同じ名前が来ても上書きしない（時刻と乱数を付けているので通常ぶつからない）
      'x-upsert': 'false',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`保管庫へ保存できませんでした（${res.status} ${
      (await res.text()).slice(0, 200)}）`);
  }
  return key;
}

/** 保管庫から本体を取得（ダウンロード中継用）。取得できなければ null。 */
export async function fetchAttachment(key) {
  if (!key || !isFileStoreConfigured()) return null;
  const res = await fetch(objectUrl(key), { headers: authHeaders() });
  if (!res.ok) {
    console.error('[fileStore] 添付を取得できませんでした:', res.status, key);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

/** 添付削除時に実体も消す。失敗しても業務は止めない（ログのみ）。 */
export async function deleteAttachment(key) {
  if (!key || !isFileStoreConfigured()) return;
  try {
    const res = await fetch(objectUrl(key), { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) console.error('[fileStore] 添付の実体を削除できませんでした:', res.status, key);
  } catch (e) {
    console.error('[fileStore] 添付の実体を削除できませんでした:', e?.message || e);
  }
}

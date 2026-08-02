// 添付ファイル（見積書・稟議書類など）の保管先。
//
// Vercel Blob の **Private** ストア（pf-project-private）を使う。
// 公開ストアと違い URL を知っていても読めない（トークンが要る）ため、
// ダウンロードは必ずこのアプリを経由し、案件スコープの確認
// （findDealInScope）を通したうえでサーバーが取得して中継する。
// Blob の URL はブラウザへ返さない。
//
// 環境変数 PRIVATE_BLOB_READ_WRITE_TOKEN は Vercel のストア接続
// （カスタムプレフィックス PRIVATE_BLOB）で自動設定される。
// 未設定のローカル開発では従来どおり DB(base64) に保存するため、
// 追加設定なしでそのまま動く。

/** 統一ストア上でこのアプリの領域を示す区画分け（他アプリと同じ規約） */
const APP_PREFIX = 'sales';

export function privateBlobToken() {
  return process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
}

/** Blob が使える構成か。false なら呼び出し元は DB 保存へフォールバックする。 */
export function isPrivateBlobConfigured() {
  return Boolean(privateBlobToken());
}

/** パスに使えない文字を落とす（パストラバーサル・不正文字の遮断） */
function sanitize(seg) {
  return String(seg).replace(/[^\w.\-]/g, '_').slice(0, 120) || 'file';
}

/**
 * 添付を Private ストアへ保存し URL を返す。
 * パスは sales/<案件ID>/<時刻>_<ファイル名>。addRandomSuffix で推測不能になる。
 */
export async function putAttachment({ dealId, filename, mimeType, body }) {
  const token = privateBlobToken();
  if (!token) throw new Error('PRIVATE_BLOB_READ_WRITE_TOKEN が未設定です');
  const { put } = await import('@vercel/blob');
  const key = `${APP_PREFIX}/${sanitize(dealId ?? 'nodeal')}/${Date.now()}_${sanitize(filename)}`;
  const blob = await put(key, body, {
    access: 'private',
    token,
    contentType: mimeType || 'application/octet-stream',
    addRandomSuffix: true,
  });
  return blob.url;
}

/** Private ストアから本体を取得（ダウンロード中継用）。取得できなければ null。 */
export async function fetchAttachment(url) {
  const token = privateBlobToken();
  if (!token) return null;
  const { get } = await import('@vercel/blob');
  const res = await get(url, { access: 'private', token });
  if (!res?.stream) return null;
  const chunks = [];
  for await (const c of res.stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** 添付削除時に実体も消す。失敗しても業務は止めない（ログのみ）。 */
export async function deleteAttachment(url) {
  if (!url) return;
  const token = privateBlobToken();
  if (!token) return;
  try {
    const { del } = await import('@vercel/blob');
    await del(url, { token });
  } catch (e) {
    console.error('[privateBlob] 添付の実体を削除できませんでした:', e?.message || e);
  }
}

/**
 * 自動取込（社内PCのスクリプト）用のAPIクライアント。
 *
 * 組み立てのとき（build.mjs）、画面の src/api.ts の代わりにこれを組み込む。
 * ファイルの読み取りと送り方は画面と同じコード（shipColorClient・surveyImportClient）を
 * そのまま使い、送り先と本人確認（Cookieの代わりに自動取込の鍵）だけをここで変える。
 */

export interface Connection {
  /** アプリのURL（https://sales.paloma-pf.com など） */
  appUrl: string;
  /** アプリに設定した AUTO_IMPORT_KEY */
  key: string;
  /** アプリ側のBasic認証（BASIC_AUTH_USER / BASIC_AUTH_PASS）を使っているとき */
  basicAuth?: { user?: string; pass?: string };
  /** VercelのPassword Protectionを使っているときの「Protection Bypass for Automation」の値 */
  vercelBypass?: string;
}

let origin = '';
let baseHeaders: Record<string, string> = {};

export function connect(c: Connection) {
  origin = String(c.appUrl ?? '').trim().replace(/\/+$/, '');
  baseHeaders = { 'X-Import-Key': String(c.key ?? '').trim() };
  if (c.basicAuth?.user && c.basicAuth?.pass) {
    const token = Buffer.from(`${c.basicAuth.user}:${c.basicAuth.pass}`, 'utf8').toString('base64');
    baseHeaders.Authorization = `Basic ${token}`;
  }
  if (c.vercelBypass) baseHeaders['x-vercel-protection-bypass'] = c.vercelBypass;
}

/** 1回の呼び出しの待ち時間の上限。Vercelの関数は60秒で打ち切られるので、それより長く待つ */
const TIMEOUT_MS = 180_000;

/** 画面の api() と同じ形。失敗したらサーバーの理由を文言にして投げる */
export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  if (!origin) throw new Error('アプリのURLが設定されていません');
  const headers: Record<string, string> = {
    ...baseHeaders,
    ...(options.headers as Record<string, string>),
  };
  if (options.body) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${origin}/api${path}`, {
      ...options, headers, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const why = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`アプリにつながりません（${origin}）: ${why}`);
  }
  const text = await res.text();
  let data: { error?: string } = {};
  try { data = JSON.parse(text); } catch { /* JSONでない応答（認証の画面など） */ }
  if (!res.ok) {
    if (data.error) throw new Error(data.error);
    if (res.status === 401 && text.includes('認証が必要です')) {
      throw new Error('アプリのBasic認証で止められました。設定ファイルの basicAuth を確かめてください');
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`アプリの手前で止められました（${res.status}）。`
        + 'VercelのPassword Protectionを使っているときは、設定ファイルの vercelBypass を設定してください');
    }
    throw new Error(`エラー (${res.status})`);
  }
  return data as T;
}

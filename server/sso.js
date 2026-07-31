/**
 * 社内ポータルからのSSO（受け渡しトークン方式）。
 *
 * ポータルが「この人は本人です」と署名した短命のトークンを発行し、
 * リダイレクトで本アプリへ渡す。本アプリは署名を検証して自前のセッションを作る。
 * 仕様は docs/SSO-PROPOSAL.md を参照。
 *
 * 署名はHS256のJWT。標準の形式なのでポータル側は既存のライブラリで発行でき、
 * 検証側は node:crypto だけで足りるため依存を増やさない。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// トークンの宛先。他アプリ向けに発行されたトークンの流用を防ぐ
export const SSO_AUDIENCE = 'sales-pricing';

// 時計のずれの許容（秒）。ポータルと本アプリで別のサーバーのため少し見込む
const CLOCK_SKEW_SEC = 60;

// jti の最低長。短すぎる値は総当たりで衝突させられる
const MIN_JTI_LENGTH = 16;

/** 設定。鍵が未設定の間はSSOそのものを無効にする */
export function ssoConfig() {
  const secret = process.env.PORTAL_SSO_SECRET || '';
  return {
    enabled: Boolean(secret),
    secret,
    issuer: process.env.PORTAL_SSO_ISSUER || 'portal',
    // 未登録の人を自動で作るか。既定は作る（権限は営業担当者から始まる）
    autoCreate: String(process.env.PORTAL_SSO_AUTO_CREATE ?? '').toLowerCase() !== 'false',
  };
}

/** 検証に失敗した理由を持つエラー。画面への出し分けに使う */
export class SsoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SsoError';
    this.code = code;
  }
}

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/**
 * トークンを検証してクレームを返す。
 * 失敗したら SsoError を投げる（理由はcodeで区別する）。
 *
 * 呼び出し側は、このあと jti の使い回し確認とユーザーの特定を行う。
 */
export function verifyToken(token, config, nowMs = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) {
    throw new SsoError('malformed', 'トークンの形式が不正です');
  }
  const [h, p, s] = parts;

  let header;
  try {
    header = decodeSegment(h);
  } catch {
    throw new SsoError('malformed', 'トークンの形式が不正です');
  }
  // alg を見ずに検証すると "none" への差し替えで署名を飛ばされる
  if (header?.alg !== 'HS256') {
    throw new SsoError('bad_alg', 'トークンの署名方式が不正です');
  }

  const expected = createHmac('sha256', config.secret).update(`${h}.${p}`).digest();
  let got;
  try {
    got = Buffer.from(s, 'base64url');
  } catch {
    throw new SsoError('bad_signature', 'トークンの署名が確認できません');
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new SsoError('bad_signature', 'トークンの署名が確認できません');
  }

  let c;
  try {
    c = decodeSegment(p);
  } catch {
    throw new SsoError('malformed', 'トークンの形式が不正です');
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (c.iss !== config.issuer) {
    throw new SsoError('bad_issuer', 'トークンの発行元が不正です');
  }
  if (c.aud !== SSO_AUDIENCE) {
    throw new SsoError('bad_audience', 'このアプリ向けのトークンではありません');
  }
  if (typeof c.exp !== 'number' || nowSec > c.exp + CLOCK_SKEW_SEC) {
    throw new SsoError('expired', 'リンクの有効期限が切れています');
  }
  if (typeof c.iat !== 'number' || c.iat > nowSec + CLOCK_SKEW_SEC) {
    throw new SsoError('bad_iat', 'トークンの発行時刻が不正です');
  }
  if (!c.jti || String(c.jti).length < MIN_JTI_LENGTH) {
    throw new SsoError('bad_jti', 'トークンの識別子が不正です');
  }
  if (!c.login_id || !String(c.login_id).trim()) {
    throw new SsoError('no_login_id', 'トークンにログインIDが含まれていません');
  }

  return {
    jti: String(c.jti),
    loginId: String(c.login_id).trim(),
    name: c.name ? String(c.name).trim() : '',
    branch: c.branch ? String(c.branch).trim() : null,
    office: c.office ? String(c.office).trim() : null,
    sub: c.sub ? String(c.sub) : null,
    // exp は使用済み記録の掃除に使う
    expiresAt: new Date(c.exp * 1000).toISOString(),
  };
}

/**
 * 遷移先の検証。
 *
 * 受け取った値をそのままリダイレクトに使うと、`//example.com` のような値で
 * 外部サイトへ飛ばされる（オープンリダイレクト）。
 * 自サイト内の絶対パスだけを許可する。
 */
export function safeNextPath(value, fallback = '/deals') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  // 「/」で始まること、かつ「//」や「/\」でないこと（別ホストとして解釈されるため）
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  // 制御文字が混ざるとヘッダーを分割される恐れがある
  if (/[\r\n\t\0]/.test(raw)) return fallback;
  return raw;
}

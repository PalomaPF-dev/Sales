import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';

const scrypt = promisify(scryptCb);

// 社内ポータル（NextAuth）と同じ bcryptjs を使う。
// 同じユーザーテーブルを共有しても、双方でパスワードを検証・更新できる。
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

/** パスワードをハッシュ化する（保存用の文字列を返す） */
export async function hashPassword(password) {
  return bcrypt.hash(normalize(password), BCRYPT_ROUNDS);
}

/**
 * 平文パスワードと保存済みハッシュを照合する。
 * bcrypt（$2a$/$2b$/$2y$）と、本アプリが以前使っていた scrypt 形式の両方を受け付ける。
 */
export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const hash = String(stored);

  if (/^\$2[aby]\$/.test(hash)) {
    try {
      return await bcrypt.compare(normalize(password), hash);
    } catch {
      return false;
    }
  }

  // 旧形式（scrypt$N$r$p$salt$key）
  const parts = hash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  try {
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(normalize(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** 保存済みハッシュが旧方式か（ログイン時に新方式へ移行するために使う） */
export function isLegacyHash(stored) {
  return Boolean(stored) && String(stored).startsWith('scrypt$');
}

// 全角で入力された英数字などの表記ゆれを吸収する
function normalize(password) {
  return String(password ?? '').normalize('NFKC');
}

/** セッショントークン（Cookieに入れる値）を生成する */
export function generateToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * トークンをDB保存用にハッシュ化する。
 * DBが漏れてもセッションを乗っ取れないようにするため、生の値は保存しない。
 */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** 仮パスワードを生成する（紛らわしい文字は除外） */
export function generateTempPassword(length = 12) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/**
 * パスワードの強度を検証する。
 * 社内利用のため複雑さより長さを重視する（NIST SP 800-63B の方針に沿う）。
 */
export function validatePassword(password) {
  const s = normalize(password);
  if (s.length < 10) return 'パスワードは10文字以上にしてください';
  // bcryptは72バイトを超える部分を無視するため、そこで頭打ちにする
  // （日本語はUTF-8で1文字3バイトのため、全角なら24文字が上限になる）
  if (Buffer.byteLength(s, 'utf8') > 72) {
    return 'パスワードが長すぎます（半角72文字・全角24文字までを目安にしてください）';
  }
  if (/^\d+$/.test(s)) return '数字だけのパスワードは使用できません';
  const weak = ['password', 'paloma', '12345678', 'qwerty', 'sales'];
  const lower = s.toLowerCase();
  if (weak.some((w) => lower.includes(w))) return '推測されやすい文字列を含むパスワードは使用できません';
  return null;
}

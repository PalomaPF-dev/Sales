import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// scrypt のコストパラメータ。N は 2 のべき乗。
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

/** パスワードをハッシュ化する（保存用の文字列を返す） */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(normalize(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** 平文パスワードと保存済みハッシュを照合する */
export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  let expected;
  try {
    expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(normalize(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
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
  if (s.length > 200) return 'パスワードが長すぎます';
  if (/^\d+$/.test(s)) return '数字だけのパスワードは使用できません';
  const weak = ['password', 'paloma', '12345678', 'qwerty', 'sales'];
  const lower = s.toLowerCase();
  if (weak.some((w) => lower.includes(w))) return '推測されやすい文字列を含むパスワードは使用できません';
  return null;
}

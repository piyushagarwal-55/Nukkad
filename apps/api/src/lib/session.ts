import { createHmac, timingSafeEqual, randomInt, createHash } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Stateless signed session. No password anywhere in this product, because
 * this user does not want another password, and a shop owner's phone is how
 * they log into everything else in their life.
 */
export interface Session {
  userId: string;
  kiranaId: string;
  exp: number;
}

export const COOKIE = 'nukkad_session';
const TTL_MS = 30 * 86_400_000;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

const sign = (payload: string): string =>
  createHmac('sha256', env.SESSION_SECRET).update(payload).digest('base64url');

export function issue(userId: string, kiranaId: string): string {
  const payload = b64(JSON.stringify({ userId, kiranaId, exp: Date.now() + TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

export function verify(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = Buffer.from(sign(payload), 'utf8');
  const got = Buffer.from(sig, 'utf8');
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  try {
    const s = JSON.parse(unb64(payload)) as Session;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/** Six digits. Stored only as a hash, never in plaintext. */
export const newOtp = (): string => String(randomInt(100_000, 999_999));
export const hashOtp = (otp: string): string =>
  createHash('sha256').update(otp + env.SESSION_SECRET).digest('hex');

export const OTP_TTL_MS = 10 * 60_000;

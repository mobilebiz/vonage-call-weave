// 監視 WS の接続認証トークン。呼制御サービスが発行し、Vonage の authorization (custom) で送られ、
// 音声中継サービスが検証する。callId / role / 世代を含み、有効期限付き。
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from './types.js';

export interface MediaClaims {
  callId: string;
  role: Role;
  gen: number;
}

const AUD = 'callweave-media';

export async function signMediaToken(secret: string, claims: MediaClaims, ttlSec: number): Promise<string> {
  return new SignJWT({ role: claims.role, gen: claims.gen })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.callId)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyMediaToken(secret: string, token: string): Promise<MediaClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { audience: AUD, algorithms: ['HS256'] });
    const role = payload.role;
    const gen = payload.gen;
    if (!payload.sub || (role !== 'caller' && role !== 'operator') || typeof gen !== 'number') return null;
    return { callId: payload.sub, role, gen };
  } catch {
    return null;
  }
}

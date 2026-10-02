// Vonage 署名付き Webhook の検証。Authorization: Bearer <JWT>（署名シークレットで HMAC 署名）
import { jwtVerify } from 'jose';
import { createHash } from 'node:crypto';

export interface SignatureCheckInput {
  authorization: string | undefined;
  rawBody: string | null;
  secret: string;
  applicationId: string;
  verifyPayloadHash: boolean;
  maxAgeSec?: number;
}

export type SignatureResult = { ok: true } | { ok: false; reason: string };

export async function verifyVonageSignature(input: SignatureCheckInput): Promise<SignatureResult> {
  const h = input.authorization ?? '';
  if (!h.startsWith('Bearer ')) return { ok: false, reason: 'missing_bearer' };
  if (!input.secret) return { ok: false, reason: 'secret_not_configured' };
  try {
    const { payload } = await jwtVerify(h.slice(7), new TextEncoder().encode(input.secret), {
      algorithms: ['HS256', 'HS512'],
      maxTokenAge: `${input.maxAgeSec ?? 600}s`,
      clockTolerance: 60,
    });
    if (input.applicationId && payload.application_id && payload.application_id !== input.applicationId) {
      return { ok: false, reason: 'application_mismatch' };
    }
    if (input.verifyPayloadHash && input.rawBody) {
      const hash = createHash('sha256').update(input.rawBody).digest('hex');
      if (payload.payload_hash !== hash) return { ok: false, reason: 'payload_hash_mismatch' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `jwt_invalid:${(err as { code?: string }).code ?? 'unknown'}` };
  }
}

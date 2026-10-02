import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { verifyVonageSignature } from '../src/vonage/signature.js';
import { compareSegments } from '../src/shared/ordering.js';
import { displayNumber, normalizeNumber } from '../src/shared/phone.js';
import { deriveTranscriptionStatus, emptyRoleState, type CallDoc } from '../src/shared/types.js';
import { signMediaToken, verifyMediaToken } from '../src/shared/mediaToken.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { localEnv } from './helpers.js';

describe('vonage signature', () => {
  const secret = 'x'.repeat(40);
  const body = '{"uuid":"a","status":"answered"}';
  const sign = (claims: Record<string, unknown>, key = secret) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(new TextEncoder().encode(key));
  it('accepts a valid token with payload hash', async () => {
    const t = await sign({ application_id: 'app', payload_hash: createHash('sha256').update(body).digest('hex') });
    const r = await verifyVonageSignature({ authorization: `Bearer ${t}`, rawBody: body, secret, applicationId: 'app', verifyPayloadHash: true });
    expect(r.ok).toBe(true);
  });
  it('rejects wrong secret, wrong app, tampered body', async () => {
    const base = { rawBody: body, secret, applicationId: 'app', verifyPayloadHash: true };
    const hash = createHash('sha256').update(body).digest('hex');
    expect((await verifyVonageSignature({ ...base, authorization: `Bearer ${await sign({ application_id: 'app', payload_hash: hash }, 'y'.repeat(40))}` })).ok).toBe(false);
    expect((await verifyVonageSignature({ ...base, authorization: `Bearer ${await sign({ application_id: 'other', payload_hash: hash })}` })).ok).toBe(false);
    expect((await verifyVonageSignature({ ...base, rawBody: '{}', authorization: `Bearer ${await sign({ application_id: 'app', payload_hash: hash })}` })).ok).toBe(false);
    expect((await verifyVonageSignature({ ...base, authorization: undefined })).ok).toBe(false);
  });
});

describe('media token', () => {
  it('round trips and rejects wrong secret', async () => {
    const t = await signMediaToken('s'.repeat(32), { callId: 'c1', role: 'operator', gen: 2 }, 60);
    expect(await verifyMediaToken('s'.repeat(32), t)).toEqual({ callId: 'c1', role: 'operator', gen: 2 });
    expect(await verifyMediaToken('t'.repeat(32), t)).toBeNull();
  });
});

describe('ordering', () => {
  it('orders by startMs, then caller before operator, then segmentId; keeps overlap', () => {
    const segs = [
      { startMs: 2000, role: 'caller' as const, segmentId: 'caller-e1-s2' },
      { startMs: 1000, role: 'operator' as const, segmentId: 'operator-e1-s1' },
      { startMs: 1000, role: 'caller' as const, segmentId: 'caller-e1-s1' },
      { startMs: null, role: 'caller' as const, segmentId: 'caller-e1-s3' },
    ];
    expect(segs.sort(compareSegments).map((s) => s.segmentId)).toEqual(['caller-e1-s1', 'operator-e1-s1', 'caller-e1-s2', 'caller-e1-s3']);
  });
});

describe('phone', () => {
  it('formats and distinguishes withheld / unknown', () => {
    const n = normalizeNumber('819012345678');
    expect(displayNumber(n.normalized, n.kind)).toBe('090-1234-5678');
    expect(displayNumber(normalizeNumber('81312345678').normalized, 'normal')).toBe('03-1234-5678');
    const w = normalizeNumber('anonymous');
    expect(displayNumber(w.normalized, w.kind)).toBe('非通知');
    const u = normalizeNumber('');
    expect(displayNumber(u.normalized, u.kind)).toBe('番号不明');
  });
});

describe('deriveTranscriptionStatus', () => {
  const base = (): Pick<CallDoc, 'roles' | 'callStatus' | 'transcriptionStatus'> => ({
    callStatus: 'active',
    transcriptionStatus: 'starting',
    roles: { caller: { ...emptyRoleState(), wsGeneration: 1 }, operator: { ...emptyRoleState(), wsGeneration: 1 } },
  });
  it('covers streaming / degraded / finalizing / completed / partial', () => {
    const c = base();
    c.roles.caller.asrStatus = 'streaming';
    c.roles.operator.asrStatus = 'streaming';
    expect(deriveTranscriptionStatus(c)).toBe('streaming');
    c.roles.operator.asrStatus = 'failed';
    expect(deriveTranscriptionStatus(c)).toBe('degraded');
    c.callStatus = 'ended';
    expect(deriveTranscriptionStatus(c)).toBe('finalizing');
    c.roles.caller.final = 'completed';
    c.roles.operator.final = 'partial';
    expect(deriveTranscriptionStatus(c)).toBe('partial');
    c.roles.operator.final = 'completed';
    c.roles.operator.asrStatus = 'done';
    expect(deriveTranscriptionStatus(c)).toBe('completed');
  });
  it('ended before SIP answer stays not_started', () => {
    const c = base();
    c.roles.caller.wsGeneration = 0;
    c.roles.operator.wsGeneration = 0;
    c.callStatus = 'abandoned';
    expect(deriveTranscriptionStatus(c)).toBe('not_started');
  });
});

describe('config isolation guard', () => {
  it('ignores GOOGLE_CLOUD_PROJECT and refuses other projects', () => {
    localEnv({ CW_STORE: 'firestore', CW_SERVICE: 'web', CW_FORBIDDEN_PROJECT_PATTERN: 'other-app-a|other-app-b' });
    process.env.GOOGLE_CLOUD_PROJECT = 'other-app-b-prod';
    expect(() => loadConfig()).toThrow(/CW_GCP_PROJECT_ID is required/);
    process.env.CW_GCP_PROJECT_ID = 'other-app-a';
    expect(() => loadConfig()).toThrow(/belongs to another project/);
    process.env.CW_GCP_PROJECT_ID = 'other-app-b-prod';
    expect(() => loadConfig()).toThrow(/belongs to another project/);
    process.env.CW_GCP_PROJECT_ID = 'callweave-prod';
    expect(loadConfig().gcpProjectId).toBe('callweave-prod');
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });
  it('production requires secrets and forbids fake ASR', () => {
    localEnv({ CW_ENV: 'production', CW_ASR_FAKE: '1', CW_STORE: 'firestore', CW_GCP_PROJECT_ID: 'callweave-prod' });
    expect(() => loadConfig()).toThrow(/CW_ASR_FAKE must not be enabled/);
  });
  it('validateConfig is exported', () => expect(typeof validateConfig).toBe('function'));
});

describe('web basic auth', () => {
  it('protects UI/API but not webhooks or healthz', async () => {
    const { startStack } = await import('./helpers.js');
    const stack = await startStack({ CW_WEB_BASIC_AUTH_PASSWORD: 'p'.repeat(20) });
    try {
      expect((await stack.app.inject({ url: '/api/calls' })).statusCode).toBe(401);
      expect((await stack.app.inject({ url: '/api/calls' })).headers['www-authenticate']).toContain('Basic');
      const bad = 'Basic ' + Buffer.from('callweave:wrong').toString('base64');
      expect((await stack.app.inject({ url: '/api/calls', headers: { authorization: bad } })).statusCode).toBe(401);
      const ok = 'Basic ' + Buffer.from(`callweave:${'p'.repeat(20)}`).toString('base64');
      expect((await stack.app.inject({ url: '/api/calls', headers: { authorization: ok } })).statusCode).toBe(200);
      expect((await stack.app.inject({ url: '/healthz' })).statusCode).toBe(200);
      const ans = await stack.app.inject({ method: 'POST', url: '/webhooks/vonage/answer', payload: { uuid: 'u1', from: '81901', to: '8150' } });
      expect(ans.statusCode).toBe(200);
    } finally {
      await stack.close();
    }
  });
});

describe('production config per service', () => {
  it('web needs basic auth but not media token', () => {
    localEnv({ CW_ENV: 'production', CW_ASR_FAKE: '0', CW_SERVICE: 'web', CW_STORE: 'firestore', CW_GCP_PROJECT_ID: 'callweave-poc-123456', CW_MEDIA_TOKEN_SECRET: '' });
    expect(() => loadConfig()).toThrow(/CW_WEB_BASIC_AUTH_PASSWORD/);
    process.env.CW_WEB_BASIC_AUTH_PASSWORD = 'x'.repeat(20);
    expect(loadConfig().service).toBe('web');
  });
  it('media needs media token', () => {
    localEnv({ CW_ENV: 'production', CW_ASR_FAKE: '0', CW_SERVICE: 'media', CW_STORE: 'firestore', CW_GCP_PROJECT_ID: 'callweave-poc-123456' });
    expect(() => loadConfig()).toThrow(/CW_MEDIA_TOKEN_SECRET is required/);
  });
});

describe('basic auth rate limit ignores spoofed X-Forwarded-For', () => {
  it('keys on the proxy-appended address, not the client-supplied first entry', async () => {
    const { startStack } = await import('./helpers.js');
    const stack = await startStack({ CW_WEB_BASIC_AUTH_PASSWORD: 'p'.repeat(20) });
    try {
      const bad = 'Basic ' + Buffer.from('callweave:wrong').toString('base64');
      let last = 0;
      for (let i = 0; i < 21; i++) {
        const r = await stack.app.inject({ url: '/api/calls', headers: { authorization: bad, 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` } });
        last = r.statusCode;
      }
      // 先頭の値を変えても、末尾（実際の送信元）で数えられて 429 になる
      expect(last).toBe(429);
    } finally {
      await stack.close();
    }
  });
});

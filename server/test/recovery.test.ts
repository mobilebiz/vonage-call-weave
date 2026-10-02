// Codex 事前レビューで指摘された「途中失敗からの回復」の再現テスト
import { afterEach, describe, expect, it } from 'vitest';
import { callWhere, startStack, waitFor } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>> | null = null;
afterEach(async () => {
  await stack?.close();
  stack = null;
});

const answer = (uuid: string) =>
  stack!.app.inject({ method: 'POST', url: '/webhooks/vonage/answer', payload: { uuid, from: '819012345678', to: '815012345678' } });

describe('recovery after partial failures', () => {
  it('input resend after state moved to dialing but job creation failed re-creates the dial job', async () => {
    stack = await startStack();
    const store = stack.store;
    const origCreate = store.createJob.bind(store);
    let fail = true;
    store.createJob = async (job) => {
      if (fail && job.op === 'dialSip') {
        fail = false;
        throw new Error('injected');
      }
      return origCreate(job);
    };
    const a = JSON.parse((await answer('rec-1')).body) as { action: string; eventUrl?: string[] }[];
    const url = new URL(a.find((x) => x.action === 'input')!.eventUrl![0]!);
    const path = `${url.pathname}${url.search}`;
    const first = await stack.app.inject({ method: 'POST', url: path, payload: { uuid: 'rec-1', dtmf: { digits: '2' } } });
    expect(first.statusCode).toBe(500);
    // Vonage の再送
    const second = await stack.app.inject({ method: 'POST', url: path, payload: { uuid: 'rec-1', dtmf: { digits: '2' } } });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).some((x: { action: string }) => x.action === 'conversation')).toBe(true);
    const callId = url.searchParams.get('callId')!;
    await callWhere(store, callId, (c) => c.callStatus === 'active');
  });

  it('duplicate webhook while the first is still processing returns 503 (retry), and an expired lease is taken over', async () => {
    stack = await startStack();
    const store = stack.store;
    expect((await store.beginWebhookEvent('k1', '2099-01-01T00:00:00Z', 30_000)).state).toBe('new');
    expect((await store.beginWebhookEvent('k1', '2099-01-01T00:00:00Z', 30_000)).state).toBe('processing');
    expect((await store.beginWebhookEvent('k2', '2099-01-01T00:00:00Z', -1)).state).toBe('new');
    expect((await store.beginWebhookEvent('k2', '2099-01-01T00:00:00Z', 30_000)).state).toBe('new');
  });

  it('re-sent terminal event re-runs call-level handling when the first attempt failed after the leg write', async () => {
    stack = await startStack();
    const store = stack.store;
    const a = JSON.parse((await answer('rec-3')).body) as { action: string; eventUrl?: string[] }[];
    const callId = new URL(a.find((x) => x.action === 'input')!.eventUrl![0]!).searchParams.get('callId')!;
    const origMutate = store.mutateCall.bind(store);
    let fail = true;
    store.mutateCall = async (id, fn) => {
      if (fail) {
        fail = false;
        throw new Error('injected');
      }
      return origMutate(id, fn);
    };
    const ev = { uuid: 'rec-3', status: 'completed', timestamp: '2026-10-03T00:00:00Z' };
    expect((await stack.app.inject({ method: 'POST', url: '/webhooks/vonage/events', payload: ev })).statusCode).toBe(500);
    expect((await store.getLeg(callId, 'caller'))!.status).toBe('completed');
    expect((await stack.app.inject({ method: 'POST', url: '/webhooks/vonage/events', payload: ev })).statusCode).toBe(204);
    const c = await store.getCall(callId);
    expect(c!.callStatus).toBe('abandoned');
    expect(c!.endReason).toBe('ivr_hangup');
  });

  it('a leg whose UUID arrives after the call ended is hung up immediately', async () => {
    stack = await startStack({}, { sipAnswerDelayMs: 60_000 });
    const { callId, uuid } = await stack.tel.inbound({ from: '819012345678', digits: ['1'] });
    await waitFor(async () => (await stack!.store.getLeg(callId!, 'sip'))?.vonageUuid);
    // 発信者切断 → hangupLegs が SIP を切る
    await stack.tel.hangup(uuid);
    await callWhere(stack.store, callId!, (c) => c.callStatus === 'abandoned');
    const sip = await stack.store.getLeg(callId!, 'sip');
    await waitFor(async () => stack!.vonage.hungUp.includes(sip!.vonageUuid!));
  });

  it('job status is not reset to enqueued after it started running', async () => {
    stack = await startStack();
    const store = stack.store;
    const now = new Date().toISOString();
    await store.createJob({ jobId: 'j1', callId: 'c', op: 'hangupLegs', generation: 1, params: {}, status: 'pending', attempts: 0, lastError: null, lockedUntil: null, createdAt: now, updatedAt: now, expiresAt: '2099-01-01T00:00:00Z' });
    expect(await store.claimJob('j1', 60_000)).not.toBeNull();
    expect(await store.updateJobIf('j1', (j) => j.status === 'pending', { status: 'enqueued' })).toBe(false);
    // 期限内の重複配信は claim できない
    expect(await store.claimJob('j1', 60_000)).toBeNull();
  });
});

describe('late leg after call ended', () => {
  it('a late answered event for a leg whose dial outcome was unknown is hung up', async () => {
    stack = await startStack();
    const { callId, uuid } = await stack.tel.inbound({ from: '819012345678', digits: ['1'] });
    await callWhere(stack.store, callId!, (c) => c.callStatus === 'active');
    await stack.tel.hangup(uuid);
    await callWhere(stack.store, callId!, (c) => c.callStatus === 'ended');
    // 発信結果が不明だったレッグに遅れて answered が届いた想定
    const now = new Date().toISOString();
    await stack.store.putLeg({ legId: 'operator_ws-g9', callId: callId!, role: 'operator_ws', generation: 9, vonageUuid: null, status: 'unknown', createdAt: now, connectedAt: null, endedAt: null, updatedAt: now });
    await stack.app.inject({ method: 'POST', url: `/webhooks/vonage/events?callId=${callId}&leg=operator_ws&gen=9`, payload: { uuid: 'late-uuid', status: 'answered', timestamp: now } });
    expect(stack.vonage.hungUp).toContain('late-uuid');
  });
});

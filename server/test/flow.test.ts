import { afterEach, describe, expect, it } from 'vitest';
import { callWhere, startStack, waitFor } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>> | null = null;
afterEach(async () => {
  await stack?.close();
  stack = null;
});

describe('call flow (fake telephony + fake ASR)', () => {
  it('IVR → SIP → 2 monitors → transcripts → hangup → completed export', async () => {
    stack = await startStack();
    const { store, tel, vonage } = stack;
    const { uuid, callId } = await tel.inbound({ from: '819012345678', digits: ['3'] });
    expect(callId).toBeTruthy();

    const active = await callWhere(store, callId!, (c) => c.callStatus === 'active');
    expect(active.engine).toBe('deepgram');
    expect(active.recognitionBaseAt).toBeTruthy();

    // SIP は発信者だけを聞く。監視 WS は対象だけを聞き、誰にも話さない
    const sip = vonage.created.find((c) => (c.body.to as { type: string }[])[0]!.type === 'sip')!;
    expect(sip.body.ncco).toEqual([expect.objectContaining({ action: 'conversation', canHear: [uuid] })]);
    await waitFor(async () => vonage.created.filter((c) => (c.body.to as { type: string }[])[0]!.type === 'websocket').length === 2);
    const monitors = vonage.created.filter((c) => (c.body.to as { type: string }[])[0]!.type === 'websocket');
    for (const m of monitors) {
      const ncco = (m.body.ncco as Record<string, unknown>[])[0]!;
      expect(ncco.canSpeak).toEqual([]);
      expect((ncco.canHear as string[]).length).toBe(1);
      expect((m.body.to as Record<string, unknown>[])[0]!.authorization).toMatchObject({ type: 'custom' });
    }
    const callerMon = monitors.find((m) => ((m.body.to as Record<string, { role: string }>[])[0]!.headers as { role: string }).role === 'caller')!;
    expect((callerMon.body.ncco as { canHear: string[] }[])[0]!.canHear).toEqual([uuid]);

    await callWhere(store, callId!, (c) => c.transcriptionStatus === 'streaming');
    // 擬似 ASR は発信者 3s / オペレーター 5s 付近で最初の確定を出す
    await waitFor(async () => (await store.listSegments(callId!, 10, null)).items.length >= 2, 15_000);

    await tel.hangup(uuid);
    const done = await callWhere(store, callId!, (c) => c.transcriptionStatus === 'completed' || c.transcriptionStatus === 'partial');
    expect(done.callStatus).toBe('ended');
    expect(done.endReason).toBe('caller_hangup');
    expect(done.transcriptionStatus).toBe('completed');

    // 残存レッグ（SIP・監視 WS）が回収されている
    await waitFor(async () => vonage.hungUp.length >= 1);

    const segs = (await store.listSegments(callId!, 100, null)).items;
    expect(new Set(segs.map((s) => s.role))).toEqual(new Set(['caller', 'operator']));
    for (const s of segs) expect(s.segmentId.startsWith(s.role)).toBe(true);

    const txt = await stack.app.inject({ url: `/api/calls/${callId}/export?format=txt` });
    expect(txt.statusCode).toBe(200);
    expect(txt.headers['cache-control']).toBe('no-store');
    expect(txt.headers['content-disposition']).toMatch(/callweave_\d{8}_\d{6}_[0-9a-f]{6}\.txt/);
    expect(txt.headers['content-disposition']).not.toContain('9012345678');
    expect(txt.body).toContain('発信者:');
    expect(txt.body).toContain('オペレーター:');
    const json = await stack.app.inject({ url: `/api/calls/${callId}/export?format=json` });
    const parsed = JSON.parse(json.body);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.segments.length).toBe(segs.length);
  });

  it('export is 409 while the call is active', async () => {
    stack = await startStack();
    const { callId } = await stack.tel.inbound({ from: '819012345678', digits: ['1'] });
    await callWhere(stack.store, callId!, (c) => c.callStatus === 'active');
    const res = await stack.app.inject({ url: `/api/calls/${callId}/export?format=txt` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'not_finalized', requestId: expect.any(String) });
  });

  it('invalid input twice ends the call without picking an engine', async () => {
    stack = await startStack();
    const { callId } = await stack.tel.inbound({ from: 'anonymous', digits: ['9', ''] });
    const c = await callWhere(stack.store, callId!, (x) => x.callStatus === 'failed');
    expect(c.endReason).toBe('ivr_no_selection');
    expect(c.engine).toBeNull();
    expect(c.callerNumberKind).toBe('withheld');
    expect(stack.vonage.created.length).toBe(0);
  });

  it('second wrong digit then valid digit works', async () => {
    stack = await startStack();
    const { callId } = await stack.tel.inbound({ from: '819012345678', digits: ['7', '2'] });
    const c = await callWhere(stack.store, callId!, (x) => x.callStatus === 'active');
    expect(c.engine).toBe('elevenlabs');
  });

  it('SIP busy → failed with reason and caller is announced', async () => {
    stack = await startStack({}, { sipOutcome: 'busy' });
    const { callId, uuid } = await stack.tel.inbound({ from: '819012345678', digits: ['1'] });
    const c = await callWhere(stack.store, callId!, (x) => x.callStatus === 'failed');
    expect(c.endReason).toBe('sip_busy');
    await waitFor(async () => stack!.vonage.transfers.some((t) => t.uuid === uuid));
  });

  it('duplicate answer webhook returns same call (idempotent)', async () => {
    stack = await startStack();
    const body = { uuid: 'dup-uuid-1', from: '819012345678', to: '815012345678' };
    const a = await stack.app.inject({ method: 'POST', url: '/webhooks/vonage/answer', payload: body });
    const b = await stack.app.inject({ method: 'POST', url: '/webhooks/vonage/answer', payload: body });
    expect(a.body).toBe(b.body);
    const list = await stack.app.inject({ url: '/api/calls?status=all' });
    expect(JSON.parse(list.body).items.length).toBe(1);
  });

  it('duplicate SIP answered events do not create duplicate monitors', async () => {
    stack = await startStack();
    const { callId } = await stack.tel.inbound({ from: '819012345678', digits: ['1'] });
    await callWhere(stack.store, callId!, (c) => c.callStatus === 'active');
    const sipLeg = await stack.store.getLeg(callId!, 'sip');
    // 同じイベントの再送と、順序逆転した ringing
    await stack.app.inject({ method: 'POST', url: `/webhooks/vonage/events?callId=${callId}&leg=sip`, payload: { uuid: sipLeg!.vonageUuid, status: 'answered', timestamp: '2026-01-01T00:00:00Z' } });
    await stack.app.inject({ method: 'POST', url: `/webhooks/vonage/events?callId=${callId}&leg=sip`, payload: { uuid: sipLeg!.vonageUuid, status: 'ringing', timestamp: '2026-01-01T00:00:01Z' } });
    await new Promise((r) => setTimeout(r, 500));
    const ws = stack.vonage.created.filter((c) => (c.body.to as { type: string }[])[0]!.type === 'websocket');
    expect(ws.length).toBe(2);
    expect(stack.vonage.created.filter((c) => (c.body.to as { type: string }[])[0]!.type === 'sip').length).toBe(1);
  });

  it('monitor WS loss is recreated with a new generation and gap recorded', async () => {
    stack = await startStack();
    const { callId, uuid } = await stack.tel.inbound({ from: '819012345678', digits: ['1'] });
    await callWhere(stack.store, callId!, (c) => c.transcriptionStatus === 'streaming');
    const legs = await stack.store.listLegs(callId!);
    const opMon = legs.find((l) => l.legId === 'operator_ws-g1')!;
    stack.tel.dropMonitor(opMon.vonageUuid!);
    const c = await callWhere(stack.store, callId!, (x) => x.roles.operator.wsGeneration === 2 && x.roles.operator.asrStatus === 'streaming');
    expect(c.roles.caller.wsGeneration).toBe(1);
    await stack.tel.hangup(uuid);
    const done = await callWhere(stack.store, callId!, (x) => ['completed', 'partial'].includes(x.transcriptionStatus));
    expect(done.transcriptionStatus).toBe('partial');
    const gaps = await stack.store.listGaps(callId!);
    expect(gaps.some((g) => g.role === 'operator' && g.reason === 'monitor_ws_lost')).toBe(true);
  });

  it('stale-generation media token is rejected', async () => {
    stack = await startStack();
    const { signMediaToken } = await import('../src/shared/mediaToken.js');
    const { callId } = await stack.tel.inbound({ from: '819012345678', digits: ['1'] });
    await callWhere(stack.store, callId!, (c) => c.transcriptionStatus === 'streaming');
    const WebSocket = (await import('ws')).default;
    const token = await signMediaToken('local-dev-media-token-secret-change-me', { callId: callId!, role: 'caller', gen: 99 }, 60);
    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/media/vonage`, { headers: { Authorization: `Bearer ${token}` } });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(1008);
    const bad = new WebSocket(`ws://127.0.0.1:${stack.port}/media/vonage`, { headers: { Authorization: 'Bearer nope' } });
    const err = await new Promise<string>((resolve) => {
      bad.on('unexpected-response', (_q, r) => resolve(String(r.statusCode)));
      bad.on('error', (e) => resolve(e.message));
    });
    expect(err).toContain('401');
  });
});

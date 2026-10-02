import { afterEach, describe, expect, it } from 'vitest';
import { callWhere, startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>> | null = null;
afterEach(async () => {
  await stack?.close();
  stack = null;
});

const put = (body: unknown, headers: Record<string, string> = {}) =>
  stack!.app.inject({ method: 'PUT', url: '/api/settings', payload: body as object, headers: { 'content-type': 'application/json', ...headers } });

describe('settings API', () => {
  it('defaults to env, updates, and the next call dials the new URI', async () => {
    stack = await startStack();
    const g = JSON.parse((await stack.app.inject({ url: '/api/settings' })).body);
    expect(g).toMatchObject({ sipTargetUri: 'sip:op@pbx.invalid', isDefault: true, revision: 0 });

    const r = await put({ sipTargetUri: ' sip:2001@pbx.example.com ', revision: 0 });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ sipTargetUri: 'sip:2001@pbx.example.com', isDefault: false, revision: 1 });

    const { callId } = await stack.tel.inbound({ from: '819012345678', digits: ['1'] });
    const c = await callWhere(stack.store, callId!, (x) => x.callStatus === 'active');
    expect(c.sipTargetUri).toBe('sip:2001@pbx.example.com');
    const sip = stack.vonage.created.find((x) => (x.body.to as { type: string }[])[0]!.type === 'sip')!;
    expect((sip.body.to as { uri: string }[])[0]!.uri).toBe('sip:2001@pbx.example.com');
  });

  it('rejects stale revision, bad URI, cross-origin, and resets to default', async () => {
    stack = await startStack();
    expect((await put({ sipTargetUri: 'sip:a@b.example', revision: 5 })).statusCode).toBe(409);
    for (const bad of ['2001@pbx', 'sip:2001@pbx example', 'sip:<x>@pbx', 'http://x', 'sip:@pbx']) {
      expect((await put({ sipTargetUri: bad, revision: 0 })).statusCode).toBe(400);
    }
    expect((await put({ sipTargetUri: 'sip:a@b.example', revision: 0 }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await put({ sipTargetUri: 'sip:a@b.example;transport=tls', revision: 0 })).statusCode).toBe(200);
    const reset = JSON.parse((await put({ sipTargetUri: '', revision: 1 })).body);
    expect(reset).toMatchObject({ isDefault: true, sipTargetUri: 'sip:op@pbx.invalid', revision: 2 });
  });
});

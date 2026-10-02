import { buildApp } from '../src/main.js';
import { loadConfig } from '../src/config.js';
import { FakeVonageClient } from '../src/vonage/client.js';
import { MemoryStore } from '../src/store/memory.js';
import { FakeTelephony, type FakeTelephonyOptions } from '../src/tools/fakeTelephony.js';
import type { CallDoc } from '../src/shared/types.js';

export function localEnv(extra: Record<string, string> = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('CW_')) delete process.env[k];
  Object.assign(process.env, {
    CW_ENV: 'local',
    CW_SERVICE: 'all',
    CW_STORE: 'memory',
    CW_QUEUE: 'inline',
    CW_ASR_FAKE: '1',
    CW_LOG_LEVEL: 'error',
    CW_VONAGE_NUMBER: '815000000000',
    CW_SIP_TARGET_URI: 'sip:op@pbx.invalid',
    CW_FINALIZE_WAIT_MS: '2000',
    ...extra,
  });
}

export async function startStack(extra: Record<string, string> = {}, tel: Partial<FakeTelephonyOptions> = {}) {
  localEnv(extra);
  const store = new MemoryStore();
  const vonage = new FakeVonageClient();
  // ポートを先に決めるため一度 listen してから URL を設定する
  const cfg = loadConfig();
  const built = await buildApp(cfg, { store, vonage });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  cfg.controlBaseUrl = `http://127.0.0.1:${port}`;
  cfg.mediaWsUrl = `ws://127.0.0.1:${port}/media/vonage`;
  const telephony = new FakeTelephony({ app: built.app, vonage, sipAnswerDelayMs: 100, ...tel });
  return {
    ...built,
    store,
    vonage,
    tel: telephony,
    port,
    async close() {
      telephony.stop();
      await built.mediaHub?.shutdown();
      await built.app.close();
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, stepMs = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const callWhere = (store: MemoryStore, callId: string, pred: (c: CallDoc) => boolean) =>
  waitFor(async () => {
    const c = await store.getCall(callId);
    return c && pred(c) ? c : null;
  });

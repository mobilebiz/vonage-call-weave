// ローカルデモ: GCP / Vonage / ASR に一切接続せず、擬似着信を発生させて UI を確認する。
//   npm run sim            （http://localhost:8080 を開く）
// CW_STORE=memory, CW_QUEUE=inline, CW_ASR_FAKE=1 を強制する。
import { buildApp } from '../main.js';
import { loadConfig } from '../config.js';
import { FakeVonageClient } from '../vonage/client.js';
import { FakeTelephony } from './fakeTelephony.js';

for (const k of Object.keys(process.env)) if (k.startsWith('CW_')) delete process.env[k];
Object.assign(process.env, {
  CW_ENV: 'local',
  CW_SERVICE: 'all',
  CW_STORE: 'memory',
  CW_QUEUE: 'inline',
  CW_ASR_FAKE: '1',
  CW_LOG_LEVEL: process.env.DEMO_LOG_LEVEL ?? 'info',
  CW_CONTROL_BASE_URL: 'http://localhost:8080',
  CW_MEDIA_WS_URL: 'ws://localhost:8080/media/vonage',
  CW_VONAGE_NUMBER: '815000000000',
  CW_SIP_TARGET_URI: 'sip:operator@pbx.invalid',
});

const cfg = loadConfig();
const vonage = new FakeVonageClient();
const built = await buildApp(cfg, { vonage });
await built.app.listen({ port: cfg.port, host: '127.0.0.1' });
const tel = new FakeTelephony({ app: built.app, vonage, sipAnswerDelayMs: 1500 });

const callers = ['09012345678', '0312345678', 'anonymous', '09012345678', '08055556666'];
let n = 0;
async function placeCall() {
  const from = callers[n % callers.length]!;
  const digit = String((n % 3) + 1);
  n++;
  const { uuid } = await tel.inbound({ from: from === 'anonymous' ? 'anonymous' : `81${from.slice(1)}`, digits: [digit] });
  const duration = 25_000 + Math.random() * 35_000;
  setTimeout(() => void tel.hangup(uuid), duration);
}

console.log('CallWeave demo: http://localhost:8080  (擬似着信を発生中。Ctrl+C で終了)');
await placeCall();
setTimeout(() => void placeCall(), 4000);
setInterval(() => void placeCall(), 20_000);

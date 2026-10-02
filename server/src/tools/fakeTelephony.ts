// ローカル検証用の擬似電話網。FakeVonageClient の発信要求を受けて、Vonage と同じ順序で
// Webhook（ringing / answered / completed）を送り、監視 WS では 16kHz PCM を 20ms ごとに流す。
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FakeVonageClient } from '../vonage/client.js';

export interface FakeTelephonyOptions {
  app: FastifyInstance;
  vonage: FakeVonageClient;
  /** SIP の応答までの時間 */
  sipAnswerDelayMs?: number;
  /** SIP を応答させず、このステータスで終了させる（busy 等の試験用） */
  sipOutcome?: 'answered' | 'busy' | 'unanswered';
  frameMs?: number;
}

interface Leg {
  uuid: string;
  eventPath: string;
  ws?: WebSocket;
  timer?: NodeJS.Timeout;
  ended: boolean;
}

export class FakeTelephony {
  readonly legs = new Map<string, Leg>();
  private readonly frameMs: number;

  constructor(private readonly o: FakeTelephonyOptions) {
    this.frameMs = o.frameMs ?? 20;
    o.vonage.onCreate = (uuid, body) => void this.onCreate(uuid, body);
    const origHangup = o.vonage.hangup.bind(o.vonage);
    o.vonage.hangup = async (uuid: string) => {
      await origHangup(uuid);
      await this.endLeg(uuid, 'completed');
    };
    const origTransfer = o.vonage.transferNcco.bind(o.vonage);
    o.vonage.transferNcco = async (uuid, ncco) => {
      await origTransfer(uuid, ncco);
      // 案内再生後に切れる
      setTimeout(() => void this.endLeg(uuid, 'completed'), 200);
    };
  }

  private pathOf(url: string) {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  }

  private stopped = false;

  async post(path: string, body: unknown) {
    if (this.stopped) return null;
    const res = await this.o.app.inject({ method: 'POST', url: path, payload: body as object });
    return res.statusCode >= 200 && res.statusCode < 300 && res.body ? (JSON.parse(res.body) as unknown) : null;
  }

  async event(leg: Leg, status: string) {
    await this.post(leg.eventPath, { uuid: leg.uuid, status, timestamp: new Date().toISOString(), direction: 'outbound' });
  }

  /** 着信して IVR で数字を押す。callId を返す */
  async inbound(opts: { from: string; to?: string; digits?: string[] }): Promise<{ uuid: string; callId: string | null }> {
    const uuid = randomUUID();
    const leg: Leg = { uuid, eventPath: '/webhooks/vonage/events', ended: false };
    this.legs.set(uuid, leg);
    this.o.vonage.statuses.set(uuid, 'answered');
    let ncco = (await this.post('/webhooks/vonage/answer', { uuid, from: opts.from, to: opts.to ?? '815012345678', conversation_uuid: `CON-${uuid}` })) as {
      action: string;
      eventUrl?: string[];
    }[];
    let callId: string | null = null;
    for (const d of opts.digits ?? ['1']) {
      const input = ncco?.find((a) => a.action === 'input');
      if (!input?.eventUrl?.[0]) break;
      const path = this.pathOf(input.eventUrl[0]);
      callId = new URL(input.eventUrl[0]).searchParams.get('callId');
      ncco = (await this.post(path, { uuid, dtmf: { digits: d, timed_out: d === '' } })) as typeof ncco;
    }
    return { uuid, callId };
  }

  async hangup(uuid: string) {
    this.o.vonage.statuses.set(uuid, 'completed');
    await this.endLeg(uuid, 'completed');
  }

  private async endLeg(uuid: string, status: string) {
    const leg = this.legs.get(uuid);
    if (!leg || leg.ended) return;
    leg.ended = true;
    if (leg.timer) clearInterval(leg.timer);
    leg.ws?.close();
    await this.event(leg, status);
  }

  private async onCreate(uuid: string, body: Record<string, unknown>) {
    const to = (body.to as Record<string, unknown>[])[0]!;
    const eventPath = this.pathOf((body.event_url as string[])[0]!);
    const leg: Leg = { uuid, eventPath, ended: false };
    this.legs.set(uuid, leg);
    await this.event(leg, 'started');

    if (to.type === 'sip') {
      await this.event(leg, 'ringing');
      setTimeout(async () => {
        const outcome = this.o.sipOutcome ?? 'answered';
        if (outcome === 'answered') {
          this.o.vonage.statuses.set(uuid, 'answered');
          await this.event(leg, 'answered');
        } else {
          leg.ended = true;
          this.o.vonage.statuses.set(uuid, outcome);
          await this.event(leg, outcome);
        }
      }, this.o.sipAnswerDelayMs ?? 500);
      return;
    }

    if (to.type === 'websocket') {
      const auth = (to.authorization as { value: string }).value;
      const ws = new WebSocket(String(to.uri), { headers: { Authorization: auth } });
      leg.ws = ws;
      ws.on('open', async () => {
        this.o.vonage.statuses.set(uuid, 'answered');
        await this.event(leg, 'answered');
        ws.send(JSON.stringify({ event: 'websocket:connected', 'content-type': 'audio/l16;rate=16000', ...(to.headers as object) }));
        const frame = Buffer.alloc(16 * 2 * this.frameMs);
        leg.timer = setInterval(() => {
          for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(Math.round((Math.random() - 0.5) * 200), i);
          if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        }, this.frameMs);
      });
      ws.on('close', () => {
        if (leg.timer) clearInterval(leg.timer);
        if (!leg.ended) void this.endLeg(uuid, 'completed');
      });
      ws.on('error', () => undefined);
    }
  }

  /** テスト用: 監視 WS だけを切断する */
  dropMonitor(uuid: string) {
    this.legs.get(uuid)?.ws?.terminate();
  }

  stop() {
    this.stopped = true;
    for (const leg of this.legs.values()) {
      if (leg.timer) clearInterval(leg.timer);
      leg.ws?.terminate();
    }
  }
}

// Web サービス: REST / SSE / エクスポート / 静的 UI。
// Firestore を購読して配信するため、接続先インスタンスに依存しない。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { CallFilter, CallStreamEvent, Store, Unsubscribe } from '../store/store.js';
import { ApiError, badRequest, conflict, gone, notFound } from '../shared/errors.js';
import { FINAL_TRANSCRIPTION_STATUSES, type CallDoc } from '../shared/types.js';
import { nowIso } from '../shared/time.js';
import { toCallView, isExportable } from './views.js';
import { exportFileName, loadExportData, renderJson, renderTxt } from './export.js';
import { registerSettingsRoutes } from './settings.js';

const CALL_ID_RE = /^[0-9]{14}-[0-9a-f]{10}$/;
const HEARTBEAT_MS = 15_000;

function sseWrite(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 1 インスタンス内で Firestore リスナーを共有する */
class SseHub {
  private listClients = new Set<(call: CallDoc) => void>();
  private listUnsub: Unsubscribe | null = null;
  private callWatchers = new Map<string, { clients: Set<(ev: CallStreamEvent) => void>; unsub: Unsubscribe }>();
  clientCount = 0;

  constructor(private readonly store: Store) {}

  subscribeList(cb: (call: CallDoc) => void): Unsubscribe {
    this.listClients.add(cb);
    this.listUnsub ??= this.store.watchCalls((c) => this.listClients.forEach((f) => f(c)));
    return () => {
      this.listClients.delete(cb);
      if (!this.listClients.size && this.listUnsub) {
        this.listUnsub();
        this.listUnsub = null;
      }
    };
  }

  subscribeCall(callId: string, cb: (ev: CallStreamEvent) => void): Unsubscribe {
    let w = this.callWatchers.get(callId);
    if (!w) {
      const clients = new Set<(ev: CallStreamEvent) => void>();
      w = { clients, unsub: this.store.watchCall(callId, (ev) => clients.forEach((f) => f(ev))) };
      this.callWatchers.set(callId, w);
    }
    w.clients.add(cb);
    return () => {
      const cur = this.callWatchers.get(callId);
      if (!cur) return;
      cur.clients.delete(cb);
      if (!cur.clients.size) {
        cur.unsub();
        this.callWatchers.delete(callId);
      }
    };
  }

  /** 最終化完了への遷移を 1 回だけ検出する（クライアント単位で判定） */
  isNewlyFinalized(call: CallDoc, seen: Map<string, string>): boolean {
    const done = FINAL_TRANSCRIPTION_STATUSES.includes(call.transcriptionStatus) && isExportable(call);
    const prev = seen.get(call.callId);
    seen.set(call.callId, call.transcriptionStatus);
    if (seen.size > 2000) seen.delete(seen.keys().next().value!);
    return done && prev !== undefined && prev !== call.transcriptionStatus;
  }
}

export function registerWebRoutes(app: FastifyInstance, store: Store, cfg: Config, log: Logger) {
  const hub = new SseHub(store);

  app.addHook('onSend', async (req, reply, payload) => {
    // 通話ログは個人情報を含むため、すべての API でキャッシュさせない
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  async function loadCall(callId: string): Promise<CallDoc> {
    if (!CALL_ID_RE.test(callId)) throw badRequest('invalid callId');
    const call = await store.getCall(callId);
    if (!call) throw notFound('call');
    if (call.expiresAt <= nowIso()) throw gone();
    return call;
  }

  app.get('/api/calls', async (req) => {
    const q = req.query as { status?: string; cursor?: string; limit?: string };
    const filter = (q.status ?? 'active') as CallFilter;
    if (!['active', 'ended', 'all'].includes(filter)) throw badRequest('status must be active, ended or all');
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const page = await store.listCalls(filter, limit, q.cursor ?? null);
    return { items: page.items.map(toCallView), nextCursor: page.nextCursor };
  });

  app.get('/api/calls/:callId', async (req) => {
    const call = await loadCall((req.params as { callId: string }).callId);
    const [live, gaps] = await Promise.all([store.listLive(call.callId), store.listGaps(call.callId)]);
    return { call: toCallView(call), live, gaps };
  });

  app.get('/api/calls/:callId/segments', async (req) => {
    const call = await loadCall((req.params as { callId: string }).callId);
    const q = req.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 500);
    return store.listSegments(call.callId, limit, q.cursor ?? null);
  });

  app.get('/api/calls/:callId/export', async (req, reply) => {
    const call = await loadCall((req.params as { callId: string }).callId);
    const format = (req.query as { format?: string }).format ?? 'txt';
    if (format !== 'txt' && format !== 'json') throw badRequest('format must be txt or json');
    if (!isExportable(call)) throw conflict('not_finalized', '通話または文字起こしの最終化が完了していません');
    const data = await loadExportData(store, call);
    const name = exportFileName(call, format);
    reply
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Content-Type', format === 'txt' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
    // TXT は Windows のメモ帳でも文字化けしないよう BOM 付き UTF-8
    return format === 'txt' ? `﻿${renderTxt(data)}` : renderJson(data);
  });

  app.get('/api/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { scope?: string; callId?: string };
    const scope = q.scope ?? 'calls';
    if (scope !== 'calls' && scope !== 'call') throw badRequest('scope must be calls or call');
    let call: CallDoc | null = null;
    if (scope === 'call') call = await loadCall(q.callId ?? '');
    if (hub.clientCount >= cfg.maxSseClients) throw new ApiError(503, 'too_many_clients', 'too many viewers');

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    hub.clientCount++;
    const seen = new Map<string, string>();
    reply.raw.write(`retry: 3000\n\n`);
    sseWrite(reply, 'hello', { scope, callId: call?.callId ?? null, at: nowIso() });

    let unsub: Unsubscribe;
    if (scope === 'calls') {
      unsub = hub.subscribeList((c) => {
        sseWrite(reply, 'call.upsert', { callId: c.callId, revision: c.revision, call: toCallView(c) });
        if (hub.isNewlyFinalized(c, seen)) sseWrite(reply, 'call.finalized', { callId: c.callId, revision: c.revision, call: toCallView(c) });
      });
    } else {
      const callId = call!.callId;
      seen.set(callId, call!.transcriptionStatus);
      let lastStatus = JSON.stringify([call!.transcriptionStatus, call!.roles]);
      unsub = hub.subscribeCall(callId, (ev) => {
        switch (ev.kind) {
          case 'call': {
            const c = ev.call;
            sseWrite(reply, 'call.upsert', { callId, revision: c.revision, call: toCallView(c) });
            const status = JSON.stringify([c.transcriptionStatus, c.roles]);
            if (status !== lastStatus) {
              lastStatus = status;
              sseWrite(reply, 'transcription.status', {
                callId,
                revision: c.revision,
                transcriptionStatus: c.transcriptionStatus,
                roles: toCallView(c).roles,
              });
            }
            if (hub.isNewlyFinalized(c, seen)) sseWrite(reply, 'call.finalized', { callId, revision: c.revision, call: toCallView(c) });
            break;
          }
          case 'segment':
            sseWrite(reply, 'transcript.upsert', { callId, revision: ev.segment.revision, kind: 'final', segment: ev.segment });
            break;
          case 'live':
            sseWrite(reply, 'transcript.upsert', { callId, revision: ev.live?.revision ?? 0, kind: 'partial', role: ev.role, live: ev.live });
            break;
          case 'gap':
            sseWrite(reply, 'gap', { callId, revision: 0, gap: ev.gap });
            break;
        }
      });
    }
    const hb = setInterval(() => reply.raw.write(`: hb\n\n`), HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(hb);
      unsub();
      hub.clientCount--;
    };
    req.raw.on('close', cleanup);
    log.debug('sse client connected', { scope });
  });

  registerSettingsRoutes(app, store, cfg, log);

  app.get('/healthz', async () => ({ ok: true }));
}

export function errorHandler(log: Logger) {
  return (err: Error & { statusCode?: number; validation?: unknown }, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id;
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ code: err.code, message: err.message, requestId });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ code: 'bad_request', message: err.message, requestId });
    }
    log.error('unhandled error', { requestId, path: req.routeOptions?.url, err: err.name, errMsg: err.message?.slice(0, 200) });
    return reply.code(500).send({ code: 'internal', message: 'internal error', requestId });
  };
}

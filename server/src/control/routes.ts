// 呼制御サービスの HTTP ルート。Vonage Webhook と内部ジョブ（Cloud Tasks / Scheduler）を受ける。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import type { CallFlow, VonageEvent } from './callFlow.js';
import type { Maintenance } from './maintenance.js';
import type { InlineQueue } from './queue.js';
import { verifyVonageSignature } from '../vonage/signature.js';
import { errInfo } from '../log.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function registerControlRoutes(app: FastifyInstance, flow: CallFlow, maintenance: Maintenance, inline: InlineQueue | null) {
  const { cfg, log } = flow;
  const oidc = new OAuth2Client();

  if (inline) inline.bind((jobId) => flow.runJob(jobId));

  /** Vonage 署名付き Webhook の検証 */
  async function verifyVonage(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (!cfg.vonage.verifySignature) return true;
    const r = await verifyVonageSignature({
      authorization: req.headers.authorization,
      rawBody: req.rawBody ?? null,
      secret: cfg.vonage.signatureSecret,
      applicationId: cfg.vonage.applicationId,
      verifyPayloadHash: cfg.vonage.verifyPayloadHash,
    });
    if (!r.ok) {
      log.warn('webhook signature rejected', { path: req.routeOptions.url, reason: r.reason });
      // 内部エラー時に Vonage が無署名で送るケースがあるため 5xx で再送を促す
      await reply.code(r.reason === 'missing_bearer' ? 503 : 401).send({ code: 'unauthorized', message: 'invalid signature' });
      return false;
    }
    return true;
  }

  /** Cloud Tasks / Cloud Scheduler からの OIDC トークンを検証する */
  async function verifyInternal(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (cfg.env === 'local' && cfg.queue === 'inline') return true;
    const h = req.headers.authorization ?? '';
    try {
      if (!h.startsWith('Bearer ')) throw new Error('missing token');
      const ticket = await oidc.verifyIdToken({ idToken: h.slice(7), audience: cfg.controlBaseUrl });
      const p = ticket.getPayload();
      if (!p?.email_verified || !p.email || !cfg.internalCallerServiceAccounts.includes(p.email)) throw new Error('caller not allowed');
      return true;
    } catch (err) {
      log.warn('internal call rejected', { path: req.routeOptions.url, ...errInfo(err) });
      await reply.code(403).send({ code: 'forbidden', message: 'forbidden' });
      return false;
    }
  }

  const params = (req: FastifyRequest): Record<string, unknown> =>
    req.method === 'GET' ? (req.query as Record<string, unknown>) : ((req.body ?? {}) as Record<string, unknown>);

  // Answer: Vonage アプリの Answer URL（POST 推奨、GET も受ける）
  const answer = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await verifyVonage(req, reply))) return;
    const ncco = await flow.handleAnswer(params(req));
    return reply.send(ncco);
  };
  app.post('/webhooks/vonage/answer', answer);
  app.get('/webhooks/vonage/answer', answer);

  app.post('/webhooks/vonage/input', async (req, reply) => {
    if (!(await verifyVonage(req, reply))) return;
    const q = req.query as { callId?: string; attempt?: string };
    if (!q.callId) return reply.send([]);
    const ncco = await flow.handleInput(q.callId, Number(q.attempt ?? '1') || 1, params(req));
    return reply.send(ncco);
  });

  const events = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await verifyVonage(req, reply))) return;
    // 永続化・冪等処理してから速やかに応答する
    await flow.handleEvent(req.query as Record<string, string | undefined>, params(req) as VonageEvent, req.rawBody ?? '');
    return reply.code(204).send();
  };
  app.post('/webhooks/vonage/events', events);
  app.get('/webhooks/vonage/events', events);
  // Vonage アプリのフォールバック URL。障害時は案内して終了する
  app.post('/webhooks/vonage/fallback', async (req, reply) => {
    if (!(await verifyVonage(req, reply))) return;
    return reply.send([{ action: 'talk', language: 'ja-JP', text: '申し訳ございません。ただいま電話を受け付けできません。' }]);
  });

  app.post('/internal/tasks/run', async (req, reply) => {
    if (!(await verifyInternal(req, reply))) return;
    const jobId = (req.body as { jobId?: string } | undefined)?.jobId;
    if (!jobId) return reply.code(400).send({ code: 'bad_request', message: 'jobId required' });
    const r = await flow.runJob(jobId);
    // 5xx を返すと Cloud Tasks が指数バックオフで再試行する
    return r === 'retry' ? reply.code(503).send({ code: 'retry', message: 'retry later' }) : reply.code(204).send();
  });

  app.post('/internal/cron/reconcile', async (req, reply) => {
    if (!(await verifyInternal(req, reply))) return;
    const report = await maintenance.reconcile();
    if (report.endedByReconcile || report.finalizeTimeouts || report.orphanHangups || report.jobsRequeued || report.monitorsRecreated) {
      log.info('reconcile', { ...report });
    }
    return reply.send(report);
  });

  app.post('/internal/cron/cleanup', async (req, reply) => {
    if (!(await verifyInternal(req, reply))) return;
    return reply.send(await maintenance.cleanup());
  });
}

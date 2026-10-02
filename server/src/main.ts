// エントリポイント。CW_SERVICE で control / media / web / all（ローカル）を切り替える。
// 1 つのコンテナイメージを 3 つの Cloud Run サービスとしてデプロイする。
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertRuntimeProject, loadConfig, loadDotenv, type Config } from './config.js';
import { createLogger } from './log.js';
import { createStore } from './store/index.js';
import type { Store } from './store/store.js';
import { CallFlow } from './control/callFlow.js';
import { Maintenance } from './control/maintenance.js';
import { CloudTasksQueue, InlineQueue } from './control/queue.js';
import { registerControlRoutes } from './control/routes.js';
import { FakeVonageClient, HttpVonageClient, type VonageClient } from './vonage/client.js';
import { MediaHub, registerMediaRoutes } from './media/routes.js';
import { createAsrFactory } from './media/asr/index.js';
import { errorHandler, registerWebRoutes } from './web/routes.js';
import { registerBasicAuth } from './web/basicAuth.js';

export interface BuiltApp {
  app: ReturnType<typeof Fastify>;
  store: Store;
  flow: CallFlow | null;
  maintenance: Maintenance | null;
  mediaHub: MediaHub | null;
  vonage: VonageClient | null;
}

export async function buildApp(cfg: Config, overrides: { store?: Store; vonage?: VonageClient } = {}): Promise<BuiltApp> {
  const log = createLogger(cfg.logLevel, { service: cfg.service });
  const store = overrides.store ?? (await createStore(cfg));
  const app = Fastify({
    logger: false,
    genReqId: (req) => (req.headers['x-cloud-trace-context'] as string | undefined)?.split('/')[0] ?? randomUUID(),
    // 任意の X-Forwarded-For を信用しない（Basic 認証の試行制限を送信元偽装で回避させない）
    trustProxy: (_addr: string, hop: number) => hop < cfg.trustProxyHops,
    bodyLimit: 1024 * 1024,
  });
  app.setErrorHandler(errorHandler(log));

  // 署名・本文ハッシュ検証のため生の本文を保持する
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const has = (s: Config['service']) => cfg.service === 'all' || cfg.service === s;
  let flow: CallFlow | null = null;
  let maintenance: Maintenance | null = null;
  let mediaHub: MediaHub | null = null;
  let vonage: VonageClient | null = null;

  if (has('control')) {
    vonage =
      overrides.vonage ??
      (cfg.vonage.applicationId && cfg.vonage.privateKey ? new HttpVonageClient(cfg.vonage) : new FakeVonageClient());
    if (cfg.env === 'production' && vonage instanceof FakeVonageClient) throw new Error('Vonage credentials missing');
    const inline = cfg.queue === 'inline' ? new InlineQueue(log) : null;
    const queue = inline ?? new CloudTasksQueue(cfg, log);
    flow = new CallFlow(cfg, store, vonage, queue, log);
    maintenance = new Maintenance(flow);
    registerControlRoutes(app, flow, maintenance, inline);
  }

  if (has('media')) {
    await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
    mediaHub = new MediaHub({ cfg, store, asrFactory: createAsrFactory(cfg), log });
    registerMediaRoutes(app, mediaHub);
  }

  if (has('web')) {
    registerBasicAuth(app, cfg.webAuth, log);
    registerWebRoutes(app, store, cfg, log);
    if (existsSync(cfg.staticDir)) {
      await app.register(fastifyStatic, { root: cfg.staticDir, wildcard: false });
      // SPA: API 以外の未知パスは index.html を返す
      app.setNotFoundHandler((req, reply) => {
        if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/webhooks/')) {
          return reply.sendFile('index.html');
        }
        return reply.code(404).send({ code: 'not_found', message: 'not found', requestId: req.id });
      });
    } else {
      log.warn('static UI not found; serving API only', { staticDir: cfg.staticDir });
    }
  } else {
    app.get('/healthz', async () => ({ ok: true }));
  }

  return { app, store, flow, maintenance, mediaHub, vonage };
}

async function main() {
  loadDotenv();
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel, { service: cfg.service });
  await assertRuntimeProject(cfg);
  const built = await buildApp(cfg);
  if (cfg.env === 'local' && cfg.queue === 'inline' && built.maintenance) {
    // ローカルでは Cloud Scheduler の代わりに 1 分ごとに照合する
    setInterval(() => void built.maintenance!.reconcile().catch(() => undefined), 60_000).unref();
  }
  await built.app.listen({ port: cfg.port, host: cfg.host });
  log.info('callweave started', {
    port: cfg.port,
    store: cfg.store,
    queue: cfg.queue,
    project: cfg.gcpProjectId ?? '(none)',
    asrFake: cfg.asr.fake,
  });

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    await built.mediaHub?.shutdown();
    await built.app.close();
    await built.store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ severity: 'CRITICAL', msg: 'startup failed', err: String(err) })}\n`);
    process.exit(1);
  });
}

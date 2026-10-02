// WebUI / Web API / SSE / エクスポートの Basic 認証。
// ブラウザは同一オリジンの fetch / EventSource / ダウンロードにも認証情報を自動で付ける。
import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../log.js';

const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 20;

const digest = (s: string) => createHash('sha256').update(s).digest();

/** 単一プロセス（CW_SERVICE=all）で同居する Vonage / 内部経路は Basic 認証の対象外（各自の認証を持つ） */
const UNPROTECTED = /^\/(healthz$|webhooks\/|media\/|internal\/)/;

export function registerBasicAuth(app: FastifyInstance, auth: { user: string; password: string }, log: Logger) {
  if (!auth.password) return;
  const expected = digest(`${auth.user}:${auth.password}`);
  // 総当たり対策: 送信元ごとの失敗回数（インスタンス内）
  const failures = new Map<string, { count: number; since: number }>();

  app.addHook('onRequest', async (req, reply) => {
    if (UNPROTECTED.test(req.url)) return;
    const ip = req.ip;
    const now = Date.now();
    const f = failures.get(ip);
    if (f && now - f.since > WINDOW_MS) failures.delete(ip);
    if (f && f.count >= MAX_FAILURES && now - f.since <= WINDOW_MS) {
      return reply.code(429).send({ code: 'too_many_attempts', message: 'too many failed attempts', requestId: req.id });
    }

    const h = req.headers.authorization ?? '';
    if (h.startsWith('Basic ')) {
      const given = digest(Buffer.from(h.slice(6), 'base64').toString('utf8'));
      if (timingSafeEqual(given, expected)) {
        failures.delete(ip);
        return;
      }
      const cur = failures.get(ip) ?? { count: 0, since: now };
      cur.count++;
      failures.set(ip, cur);
      if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
      log.warn('basic auth failed', { failures: cur.count });
    }
    reply.header('WWW-Authenticate', 'Basic realm="CallWeave", charset="UTF-8"');
    return reply.code(401).send({ code: 'unauthorized', message: 'authentication required', requestId: req.id });
  });
}

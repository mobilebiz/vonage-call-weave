// 音声中継サービス: Vonage の監視 WS を受ける。
// 接続認証は Vonage の authorization (custom) で送られる、有効期限・callId・role・世代付きトークン。
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyMediaToken, type MediaClaims } from '../shared/mediaToken.js';
import { StreamSession, type SessionDeps } from './session.js';
import { errInfo } from '../log.js';

declare module 'fastify' {
  interface FastifyRequest {
    mediaClaims?: MediaClaims;
  }
}

export class MediaHub {
  readonly sessions = new Set<StreamSession>();
  accepting = true;

  constructor(readonly deps: SessionDeps) {}

  /** インスタンス終了時: 新規受付を停止し、可能な範囲で flush する（メモリ音声の無損失は保証しない） */
  async shutdown() {
    this.accepting = false;
    await Promise.allSettled([...this.sessions].map((s) => s.end('shutdown')));
  }
}

export function registerMediaRoutes(app: FastifyInstance, hub: MediaHub) {
  const { cfg, log } = hub.deps;

  app.get(
    '/media/vonage',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!hub.accepting) return reply.code(503).send({ code: 'shutting_down', message: 'shutting down' });
        const h = req.headers.authorization ?? '';
        const claims = h.startsWith('Bearer ') ? await verifyMediaToken(cfg.mediaTokenSecret, h.slice(7)) : null;
        if (!claims) {
          log.warn('media ws unauthorized');
          return reply.code(401).send({ code: 'unauthorized', message: 'invalid token' });
        }
        req.mediaClaims = claims;
      },
    },
    (socket: WebSocket, req) => {
      const claims = req.mediaClaims!;
      const session = new StreamSession(hub.deps, claims.callId, claims.role, claims.gen, socket);
      hub.sessions.add(session);
      let ready = false;
      const early: Buffer[] = [];

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          // 最初のテキストは websocket:connected と NCCO headers のメタデータ。認証には使わない
          try {
            const meta = JSON.parse(data.toString()) as { event?: string; callId?: string; role?: string };
            if (meta.event === 'websocket:connected' && (meta.callId !== claims.callId || meta.role !== claims.role)) {
              log.warn('media metadata mismatch', { callId: claims.callId });
              socket.close(1008, 'metadata_mismatch');
            }
          } catch {
            /* ignore */
          }
          return;
        }
        if (!ready) {
          early.push(data);
          return;
        }
        session.onAudio(data);
      });
      socket.on('close', () => {
        void session.end('ws_closed').finally(() => hub.sessions.delete(session));
      });
      socket.on('error', (err) => log.warn('media socket error', { callId: claims.callId, ...errInfo(err) }));

      const started = session.start().then((ok) => {
        // 開始処理中に届いた音声も経過時間を維持して扱う
        if (ok) for (const b of early.splice(0)) session.onAudio(b);
        ready = ok;
        return ok;
      });
      started.catch((err) => {
        log.error('media session start failed', { callId: claims.callId, ...errInfo(err) });
        socket.close(1011, 'start_failed');
      });
    },
  );
}

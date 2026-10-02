// 運用設定 API（画面の設定メニュー）。Basic 認証の配下で提供する。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/store.js';
import { ApiError, badRequest, conflict } from '../shared/errors.js';
import { SIP_URI_RE, type SettingsDoc } from '../shared/types.js';

export interface SettingsView {
  sipTargetUri: string;
  /** 画面で未設定のときに使う値（環境変数 CW_SIP_TARGET_URI） */
  defaultSipTargetUri: string;
  isDefault: boolean;
  revision: number;
  updatedAt: string | null;
}

export function toSettingsView(s: SettingsDoc, cfg: Config): SettingsView {
  return {
    sipTargetUri: s.sipTargetUri || cfg.sip.targetUri,
    defaultSipTargetUri: cfg.sip.targetUri,
    isDefault: !s.sipTargetUri,
    revision: s.revision,
    updatedAt: s.updatedAt,
  };
}

/** 別サイトからの書き換え（CSRF）を防ぐ。Origin があれば自ホストと一致すること */
function assertSameOrigin(req: FastifyRequest) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw new ApiError(403, 'forbidden', 'invalid origin');
  }
  if (host !== req.headers.host) throw new ApiError(403, 'forbidden', 'cross-origin request');
}

export function registerSettingsRoutes(app: FastifyInstance, store: Store, cfg: Config, log: Logger) {
  app.get('/api/settings', async () => toSettingsView(await store.getSettings(), cfg));

  app.put('/api/settings', async (req) => {
    assertSameOrigin(req);
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw badRequest('content-type must be application/json');
    const body = (req.body ?? {}) as { sipTargetUri?: unknown; revision?: unknown };
    if (typeof body.revision !== 'number') throw badRequest('revision is required');
    let uri: string | null = null;
    if (body.sipTargetUri !== null && body.sipTargetUri !== undefined) {
      if (typeof body.sipTargetUri !== 'string') throw badRequest('sipTargetUri must be a string');
      const v = body.sipTargetUri.trim();
      if (v !== '') {
        if (v.length > 256 || !SIP_URI_RE.test(v)) throw badRequest('SIP URI の形式が正しくありません（例: sip:2001@pbx.example.com）');
        // 既定値と同じなら「既定値に戻す」として保存する
        uri = v === cfg.sip.targetUri ? null : v;
      }
    }
    const next = await store.updateSettings({ sipTargetUri: uri }, body.revision);
    if (!next) throw conflict('stale_revision', '他の画面で設定が更新されました。再読み込みしてください');
    log.info('settings updated', { revision: next.revision, sipTargetIsDefault: !uri });
    return toSettingsView(next, cfg);
  });
}

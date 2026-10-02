// 環境変数の読込と検証。
// CallWeave の設定はすべて CW_ 接頭辞で受け取る。シェルに残っている他プロジェクトの
// GOOGLE_CLOUD_PROJECT や VONAGE_* などを誤って拾わないための措置。
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

export type ServiceName = 'control' | 'media' | 'web' | 'all';


export interface Config {
  service: ServiceName;
  env: 'local' | 'production';
  port: number;
  host: string;
  logLevel: string;

  store: 'memory' | 'firestore';
  gcpProjectId: string | null;
  firestoreDatabase: string;
  region: string;

  queue: 'inline' | 'cloudtasks';
  tasksQueue: string;
  tasksLocation: string;
  tasksInvokerServiceAccount: string | null;
  /** Cloud Tasks / Scheduler の OIDC 検証で許可するサービスアカウント */
  internalCallerServiceAccounts: string[];

  controlBaseUrl: string;
  mediaWsUrl: string;

  vonage: {
    applicationId: string;
    privateKey: string;
    signatureSecret: string;
    apiBase: string;
    number: string;
    verifySignature: boolean;
    verifyPayloadHash: boolean;
  };

  sip: {
    targetUri: string;
    fromMode: 'caller' | 'vonage_number';
    headers: Record<string, string>;
    ringingTimeoutSec: number;
  };
  holdMusicUrl: string | null;

  mediaTokenSecret: string;
  mediaTokenTtlSec: number;

  asr: {
    fake: boolean;
    language: string;
    engineConfigVersion: string;
    amivoice: { appKey: string; url: string; engine: string; resultUpdatedInterval: number };
    elevenlabs: { apiKey: string; url: string; model: string; enableLogging: boolean; vadSilenceSecs: number };
    deepgram: { apiKey: string; url: string; model: string; endpointingMs: number; utteranceEndMs: number };
  };

  retentionDays: number;
  transcriptionLimitMs: number;
  finalizeWaitMs: number;
  finalizeDeadlineMs: number;
  audioQueueMaxMs: number;
  partialMinIntervalMs: number;
  maxSseClients: number;
  /**
   * 信頼するプロキシの段数。X-Forwarded-For の右から数えてこの段数分を信頼する。
   * Cloud Run 直接公開は 1（Google フロントエンドが末尾に実 IP を追加）、外部 LB 経由は 2。
   * クライアントが送った X-Forwarded-For の先頭値は信用しない
   */
  trustProxyHops: number;
  /** WebUI / API / SSE / エクスポートの Basic 認証。password が空なら認証なし（ローカルのみ） */
  webAuth: { user: string; password: string };
  maxWsRecreate: number;
  staticDir: string;
}

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function readPrivateKey(): string {
  const inline = str('CW_VONAGE_PRIVATE_KEY');
  if (inline) return inline.replace(/\\n/g, '\n');
  const path = str('CW_VONAGE_PRIVATE_KEY_PATH');
  // 相対パスは server/ からでもプロジェクト直下からでも解決する
  for (const p of path ? [resolve(path), resolve('..', path)] : []) if (existsSync(p)) return readFileSync(p, 'utf8');
  return '';
}

export function loadDotenv(): void {
  // ローカル開発用。プロジェクト直下の .env をシェルの値より優先して読む
  for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]) {
    if (existsSync(p)) {
      dotenv.config({ path: p, override: true, quiet: true });
      break;
    }
  }
}

export function loadConfig(): Config {
  const env = str('CW_ENV', 'local') === 'production' ? 'production' : 'local';
  const prod = env === 'production';
  const service = str('CW_SERVICE', 'all') as ServiceName;
  if (!['control', 'media', 'web', 'all'].includes(service)) throw new Error(`invalid CW_SERVICE: ${service}`);

  const cfg: Config = {
    service,
    env,
    port: num('PORT', 8080),
    host: str('CW_HOST', '0.0.0.0'),
    logLevel: str('CW_LOG_LEVEL', prod ? 'info' : 'debug'),

    store: str('CW_STORE', prod ? 'firestore' : 'memory') === 'firestore' ? 'firestore' : 'memory',
    gcpProjectId: str('CW_GCP_PROJECT_ID') || null,
    firestoreDatabase: str('CW_FIRESTORE_DATABASE', '(default)'),
    region: str('CW_REGION', 'asia-northeast1'),

    queue: str('CW_QUEUE', prod ? 'cloudtasks' : 'inline') === 'cloudtasks' ? 'cloudtasks' : 'inline',
    tasksQueue: str('CW_TASKS_QUEUE', 'callweave-control'),
    tasksLocation: str('CW_TASKS_LOCATION', str('CW_REGION', 'asia-northeast1')),
    tasksInvokerServiceAccount: str('CW_TASKS_INVOKER_SA') || null,
    internalCallerServiceAccounts: str('CW_INTERNAL_CALLER_SAS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    controlBaseUrl: str('CW_CONTROL_BASE_URL', 'http://localhost:8080').replace(/\/$/, ''),
    mediaWsUrl: str('CW_MEDIA_WS_URL', 'ws://localhost:8080/media/vonage'),

    vonage: {
      applicationId: str('CW_VONAGE_APPLICATION_ID'),
      privateKey: readPrivateKey(),
      signatureSecret: str('CW_VONAGE_SIGNATURE_SECRET'),
      apiBase: str('CW_VONAGE_API_BASE', 'https://api.nexmo.com').replace(/\/$/, ''),
      number: str('CW_VONAGE_NUMBER'),
      verifySignature: bool('CW_VERIFY_WEBHOOK_SIGNATURE', prod),
      verifyPayloadHash: bool('CW_VERIFY_PAYLOAD_HASH', false),
    },

    sip: {
      targetUri: str('CW_SIP_TARGET_URI'),
      fromMode: str('CW_SIP_FROM_MODE', 'caller') === 'vonage_number' ? 'vonage_number' : 'caller',
      headers: JSON.parse(str('CW_SIP_HEADERS_JSON', '{}')) as Record<string, string>,
      ringingTimeoutSec: num('CW_SIP_RINGING_TIMEOUT_SEC', 30),
    },
    holdMusicUrl: str('CW_HOLD_MUSIC_URL') || null,

    mediaTokenSecret: str('CW_MEDIA_TOKEN_SECRET', prod ? '' : 'local-dev-media-token-secret-change-me'),
    mediaTokenTtlSec: num('CW_MEDIA_TOKEN_TTL_SEC', 300),

    asr: {
      fake: bool('CW_ASR_FAKE', false),
      language: str('CW_ASR_LANGUAGE', 'ja'),
      engineConfigVersion: str('CW_ENGINE_CONFIG_VERSION', '2026-10-02.1'),
      amivoice: {
        appKey: str('CW_AMIVOICE_APPKEY'),
        // ログ保存なしのエンドポイントを既定にする
        url: str('CW_AMIVOICE_URL', 'wss://acp-api.amivoice.com/v1/nolog/'),
        engine: str('CW_AMIVOICE_ENGINE', '-a-general'),
        resultUpdatedInterval: num('CW_AMIVOICE_RESULT_UPDATED_INTERVAL', 500),
      },
      elevenlabs: {
        apiKey: str('CW_ELEVENLABS_API_KEY'),
        url: str('CW_ELEVENLABS_URL', 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'),
        model: str('CW_ELEVENLABS_MODEL', 'scribe_v2_realtime'),
        enableLogging: bool('CW_ELEVENLABS_ENABLE_LOGGING', false),
        vadSilenceSecs: num('CW_ELEVENLABS_VAD_SILENCE_SECS', 0.8),
      },
      deepgram: {
        apiKey: str('CW_DEEPGRAM_API_KEY'),
        url: str('CW_DEEPGRAM_URL', 'wss://api.deepgram.com/v1/listen'),
        model: str('CW_DEEPGRAM_MODEL', 'nova-3'),
        endpointingMs: num('CW_DEEPGRAM_ENDPOINTING_MS', 300),
        utteranceEndMs: num('CW_DEEPGRAM_UTTERANCE_END_MS', 1000),
      },
    },

    retentionDays: num('CW_RETENTION_DAYS', 7),
    transcriptionLimitMs: num('CW_TRANSCRIPTION_LIMIT_MIN', 55) * 60_000,
    finalizeWaitMs: num('CW_FINALIZE_WAIT_MS', 10_000),
    finalizeDeadlineMs: num('CW_FINALIZE_DEADLINE_MS', 30_000),
    audioQueueMaxMs: num('CW_AUDIO_QUEUE_MAX_MS', 5_000),
    partialMinIntervalMs: num('CW_PARTIAL_MIN_INTERVAL_MS', 500),
    maxSseClients: num('CW_MAX_SSE_CLIENTS', 200),
    trustProxyHops: num('CW_TRUST_PROXY_HOPS', 1),
    webAuth: { user: str('CW_WEB_BASIC_AUTH_USER', 'callweave'), password: str('CW_WEB_BASIC_AUTH_PASSWORD') },
    maxWsRecreate: num('CW_MAX_WS_RECREATE', 3),
    staticDir: str('CW_STATIC_DIR', resolve(process.cwd(), '../web/dist')),
  };

  validateConfig(cfg);
  return cfg;
}

/**
 * 取り違えを防ぎたい他プロジェクトの識別子（正規表現）。CW_FORBIDDEN_PROJECT_PATTERN で与える。
 * 未設定なら null（この確認は行わない）
 */
export function forbiddenProjectPattern(): RegExp | null {
  const p = str('CW_FORBIDDEN_PROJECT_PATTERN');
  return p ? new RegExp(p, 'i') : null;
}

/** 他プロジェクトの GCP / Vonage 環境と混ざる設定を起動時に拒否する */
export function validateConfig(cfg: Config): void {
  const errors: string[] = [];
  const forbidden = forbiddenProjectPattern();

  if (cfg.store === 'firestore' || cfg.queue === 'cloudtasks') {
    if (!cfg.gcpProjectId) errors.push('CW_GCP_PROJECT_ID is required (GOOGLE_CLOUD_PROJECT is intentionally ignored)');
    else if (forbidden?.test(cfg.gcpProjectId)) errors.push(`CW_GCP_PROJECT_ID "${cfg.gcpProjectId}" belongs to another project`);
  }

  const forbiddenApps = str('CW_FORBIDDEN_VONAGE_APP_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (cfg.vonage.applicationId && forbiddenApps.includes(cfg.vonage.applicationId)) {
    errors.push('CW_VONAGE_APPLICATION_ID is listed in CW_FORBIDDEN_VONAGE_APP_IDS (another project\'s Vonage app)');
  }

  if (cfg.env === 'production') {
    const needs: [string, string][] = [];
    // 監視 WS トークンは control（発行）と media（検証）だけが使う
    if (cfg.service !== 'web') needs.push(['CW_MEDIA_TOKEN_SECRET', cfg.mediaTokenSecret]);
    if (cfg.service === 'control' || cfg.service === 'all') {
      needs.push(
        ['CW_VONAGE_APPLICATION_ID', cfg.vonage.applicationId],
        ['CW_VONAGE_PRIVATE_KEY', cfg.vonage.privateKey],
        ['CW_VONAGE_SIGNATURE_SECRET', cfg.vonage.signatureSecret],
        ['CW_SIP_TARGET_URI', cfg.sip.targetUri],
        ['CW_VONAGE_NUMBER', cfg.vonage.number],
        ['CW_CONTROL_BASE_URL', cfg.controlBaseUrl],
        ['CW_MEDIA_WS_URL', cfg.mediaWsUrl],
      );
    }
    for (const [k, v] of needs) if (!v) errors.push(`${k} is required in production`);
    // 公開 URL を知っているだけで通話ログを読める構成にしない
    if ((cfg.service === 'web' || cfg.service === 'all') && cfg.webAuth.password.length < 16) {
      errors.push('CW_WEB_BASIC_AUTH_PASSWORD (>= 16 chars) is required in production');
    }
    if (cfg.asr.fake) errors.push('CW_ASR_FAKE must not be enabled in production');
    if (cfg.mediaTokenSecret && cfg.mediaTokenSecret.length < 32) errors.push('CW_MEDIA_TOKEN_SECRET must be >= 32 chars');
  }

  if (errors.length) throw new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`);
}

/**
 * Cloud Run 上では、メタデータサーバーが返す実行プロジェクトと設定値の一致を確認する。
 * 別プロジェクトにデプロイされたイメージや、設定の取り違えを起動時に止める。
 */
export async function assertRuntimeProject(cfg: Config): Promise<void> {
  if (!process.env.K_SERVICE || !cfg.gcpProjectId) return;
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id', {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  const actual = (await res.text()).trim();
  if (actual !== cfg.gcpProjectId) {
    throw new Error(`Runtime project "${actual}" does not match CW_GCP_PROJECT_ID "${cfg.gcpProjectId}"`);
  }
  if (forbiddenProjectPattern()?.test(actual)) throw new Error(`Refusing to run in project "${actual}"`);
}

// Vonage Voice API の最小クライアント。SDK の型が WS の authorization 等に追従していないため REST を直接呼ぶ。
import { SignJWT, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';

export class VonageApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Vonage API error ${status}`);
  }
}

/** タイムアウト等で、要求が Vonage 側で処理されたか不明な場合 */
export class VonageAmbiguousError extends Error {}

export interface CreateCallResult {
  uuid: string;
  status?: string;
  conversation_uuid?: string;
}

export interface VonageCallInfo {
  uuid: string;
  status: string;
  direction?: string;
  conversation_uuid?: string;
}

export interface VonageClient {
  createCall(body: Record<string, unknown>): Promise<CreateCallResult>;
  hangup(uuid: string): Promise<void>;
  transferNcco(uuid: string, ncco: unknown[]): Promise<void>;
  getCall(uuid: string): Promise<VonageCallInfo | null>;
}

export class HttpVonageClient implements VonageClient {
  private keyPromise: ReturnType<typeof importPKCS8> | null = null;
  private cached: { token: string; exp: number } | null = null;

  constructor(
    private readonly cfg: Config['vonage'],
    private readonly timeoutMs = 8000,
  ) {}

  private async token(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.exp - 60 > now) return this.cached.token;
    if (!this.cfg.applicationId || !this.cfg.privateKey) throw new Error('Vonage credentials are not configured');
    this.keyPromise ??= importPKCS8(this.cfg.privateKey, 'RS256');
    const key = await this.keyPromise;
    const exp = now + 900;
    const token = await new SignJWT({ application_id: this.cfg.applicationId })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(key);
    this.cached = { token, exp };
    return token;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.cfg.apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new VonageAmbiguousError(`Vonage request failed: ${(err as Error).name}`);
    } finally {
      clearTimeout(t);
    }
  }

  async createCall(body: Record<string, unknown>): Promise<CreateCallResult> {
    const res = await this.request('POST', '/v1/calls', body);
    const text = await res.text();
    if (res.status >= 500) throw new VonageAmbiguousError(`Vonage createCall ${res.status}`);
    if (!res.ok) throw new VonageApiError(res.status, text);
    return JSON.parse(text) as CreateCallResult;
  }

  async hangup(uuid: string): Promise<void> {
    const res = await this.request('PUT', `/v1/calls/${encodeURIComponent(uuid)}`, { action: 'hangup' });
    // 既に終了済みのレッグは 400/404 になる。回収目的なので成功扱い
    if (!res.ok && ![400, 404, 409].includes(res.status)) throw new VonageApiError(res.status, await res.text());
  }

  async transferNcco(uuid: string, ncco: unknown[]): Promise<void> {
    const res = await this.request('PUT', `/v1/calls/${encodeURIComponent(uuid)}`, {
      action: 'transfer',
      destination: { type: 'ncco', ncco },
    });
    if (!res.ok && ![400, 404, 409].includes(res.status)) throw new VonageApiError(res.status, await res.text());
  }

  async getCall(uuid: string): Promise<VonageCallInfo | null> {
    const res = await this.request('GET', `/v1/calls/${encodeURIComponent(uuid)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new VonageApiError(res.status, await res.text());
    return (await res.json()) as VonageCallInfo;
  }
}

/** ローカル開発用。実際には発信せず、シミュレーターが Webhook を送る */
export class FakeVonageClient implements VonageClient {
  readonly created: { uuid: string; body: Record<string, unknown> }[] = [];
  readonly hungUp: string[] = [];
  readonly transfers: { uuid: string; ncco: unknown[] }[] = [];
  readonly statuses = new Map<string, string>();
  onCreate?: (uuid: string, body: Record<string, unknown>) => void;

  async createCall(body: Record<string, unknown>) {
    const uuid = randomUUID();
    this.created.push({ uuid, body });
    this.statuses.set(uuid, 'started');
    queueMicrotask(() => this.onCreate?.(uuid, body));
    return { uuid, status: 'started' };
  }
  async hangup(uuid: string) {
    this.hungUp.push(uuid);
    this.statuses.set(uuid, 'completed');
  }
  async transferNcco(uuid: string, ncco: unknown[]) {
    this.transfers.push({ uuid, ncco });
  }
  async getCall(uuid: string) {
    const status = this.statuses.get(uuid);
    return status ? { uuid, status } : null;
  }
}

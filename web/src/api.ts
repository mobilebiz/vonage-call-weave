// サーバー API の型と呼び出し。Firestore やベンダーへは直接アクセスしない。
export type Role = 'caller' | 'operator';
export type CallStatus = 'ivr' | 'dialing' | 'active' | 'ended' | 'failed' | 'abandoned';
export type TranscriptionStatus =
  | 'not_started'
  | 'starting'
  | 'streaming'
  | 'degraded'
  | 'finalizing'
  | 'completed'
  | 'partial'
  | 'failed';

export interface RoleView {
  asrStatus: string;
  errorCode: string | null;
  startupGapMs: number | null;
  final: string | null;
}

export interface CallView {
  callId: string;
  shortCallId: string;
  callerDisplay: string;
  callerNumber: string | null;
  calledDisplay: string;
  engine: string | null;
  engineLabel: string | null;
  engineConfigVersion: string | null;
  receivedAt: string;
  sipAnsweredAt: string | null;
  endedAt: string | null;
  recognitionBaseAt: string | null;
  callStatus: CallStatus;
  transcriptionStatus: TranscriptionStatus;
  endReason: string | null;
  roles: Record<Role, RoleView>;
  limitReached: boolean;
  sipTargetUri: string | null;
  exportable: boolean;
  revision: number;
}

export interface Segment {
  callId: string;
  segmentId: string;
  role: Role;
  streamEpoch: number;
  text: string;
  startMs: number;
  endMs: number;
  timestampQuality: 'vendor' | 'estimated';
  revision: number;
}

export interface Live {
  callId: string;
  role: Role;
  segmentId: string;
  revision: number;
  text: string;
  startMs: number | null;
  unconfirmed: boolean;
}

export interface Gap {
  callId: string;
  gapId: string;
  role: Role;
  startMs: number;
  endMs: number | null;
  reason: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let body: { code?: string; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new HttpError(res.status, body.code ?? 'error', body.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

export type ListFilter = 'active' | 'ended' | 'all';

export async function fetchCalls(filter: ListFilter, signal?: AbortSignal): Promise<CallView[]> {
  const items: CallView[] = [];
  let cursor: string | null = null;
  // 一覧は最大 500 件まで（保存期間 7 日の範囲）
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ status: filter, limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const page: { items: CallView[]; nextCursor: string | null } = await getJson(`/api/calls?${q}`, signal);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return items;
}

export function fetchCall(callId: string, signal?: AbortSignal) {
  return getJson<{ call: CallView; live: Live[]; gaps: Gap[] }>(`/api/calls/${encodeURIComponent(callId)}`, signal);
}

/** 確定履歴をページングで取得する。ページごとに onPage を呼ぶ */
export async function fetchAllSegments(callId: string, onPage: (items: Segment[]) => void, signal?: AbortSignal) {
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ limit: '300' });
    if (cursor) q.set('cursor', cursor);
    const page: { items: Segment[]; nextCursor: string | null } = await getJson(
      `/api/calls/${encodeURIComponent(callId)}/segments?${q}`,
      signal,
    );
    onPage(page.items);
    cursor = page.nextCursor;
  } while (cursor && !signal?.aborted);
}

export function exportUrl(callId: string, format: 'txt' | 'json') {
  return `/api/calls/${encodeURIComponent(callId)}/export?format=${format}`;
}

export type ConnState = 'connecting' | 'open' | 'reconnecting';

/**
 * SSE を購読し、切断時は指数バックオフで再接続する。
 * 接続（再接続）ごとに onOpen を呼ぶので、呼び出し側はスナップショットを再取得する。
 */
export function subscribe(
  url: string,
  handlers: Record<string, (data: any) => void>,
  onState: (s: ConnState) => void,
  onOpen: () => void,
): () => void {
  let es: EventSource | null = null;
  let attempt = 0;
  let timer: number | undefined;
  let closed = false;

  const connect = () => {
    if (closed) return;
    onState(attempt === 0 ? 'connecting' : 'reconnecting');
    es = new EventSource(url);
    es.addEventListener('hello', () => {
      attempt = 0;
      onState('open');
      onOpen();
    });
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, (ev) => {
        try {
          fn(JSON.parse((ev as MessageEvent<string>).data));
        } catch {
          /* ignore malformed */
        }
      });
    }
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;
      onState('reconnecting');
      const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
      attempt++;
      timer = window.setTimeout(connect, delay);
    };
  };
  connect();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    es?.close();
  };
}

export interface SettingsView {
  sipTargetUri: string;
  defaultSipTargetUri: string;
  isDefault: boolean;
  revision: number;
  updatedAt: string | null;
}

export function fetchSettings(signal?: AbortSignal) {
  return getJson<SettingsView>('/api/settings', signal);
}

/** sipTargetUri に空文字を渡すと既定値（環境変数）に戻す */
export async function saveSettings(sipTargetUri: string, revision: number): Promise<SettingsView> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sipTargetUri, revision }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, body.code ?? 'error', body.message ?? res.statusText);
  return body as SettingsView;
}

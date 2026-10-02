import type {
  CallDoc,
  SettingsDoc,
  GapDoc,
  JobDoc,
  LegDoc,
  LiveDoc,
  Role,
  SegmentDoc,
} from '../shared/types.js';

export type Unsubscribe = () => void;

export type CallStreamEvent =
  | { kind: 'call'; call: CallDoc }
  | { kind: 'segment'; segment: SegmentDoc }
  | { kind: 'live'; role: Role; live: LiveDoc | null }
  | { kind: 'gap'; gap: GapDoc };

export type CallFilter = 'active' | 'ended' | 'all';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type WebhookBegin =
  | { state: 'new' }
  | { state: 'processing' }
  | { state: 'done'; result: unknown };

/**
 * 永続化層。本番は Firestore、ローカル開発とテストはメモリ実装を使う。
 * ブラウザから直接アクセスさせず、必ずサーバー経由で使う。
 */
export interface Store {
  /** 着信レッグ UUID で重複判定して通話を作成する。既存なら既存を返す */
  createCallForInbound(inboundUuid: string, build: (callId: string) => CallDoc): Promise<{ call: CallDoc; created: boolean }>;
  getCall(callId: string): Promise<CallDoc | null>;
  /**
   * トランザクションで通話を更新する。fn が null を返したら変更なし。
   * revision と updatedAt はストアが更新する。
   */
  mutateCall(callId: string, fn: (call: CallDoc) => CallDoc | null): Promise<{ call: CallDoc; changed: boolean } | null>;
  listCalls(filter: CallFilter, limit: number, cursor: string | null): Promise<Page<CallDoc>>;
  /** 照合対象：呼が終わっていない、または最終化が終わっていない通話 */
  listOpenCalls(limit: number): Promise<CallDoc[]>;
  listExpiredCallIds(nowIso: string, limit: number): Promise<string[]>;
  deleteCallCascade(callId: string): Promise<void>;

  putLeg(leg: LegDoc): Promise<void>;
  getLeg(callId: string, legId: string): Promise<LegDoc | null>;
  mutateLeg(callId: string, legId: string, fn: (leg: LegDoc) => LegDoc | null): Promise<LegDoc | null>;
  listLegs(callId: string): Promise<LegDoc[]>;
  indexLeg(vonageUuid: string, callId: string, legId: string, expiresAt: string): Promise<void>;
  findLegByUuid(vonageUuid: string): Promise<{ callId: string; legId: string } | null>;

  /** 新規、または revision が大きい場合のみ書き込む。書いたら true */
  upsertSegment(segment: SegmentDoc): Promise<boolean>;
  listSegments(callId: string, limit: number, cursor: string | null): Promise<Page<SegmentDoc>>;
  setLive(callId: string, role: Role, live: LiveDoc | null): Promise<void>;
  listLive(callId: string): Promise<LiveDoc[]>;
  putGap(gap: GapDoc): Promise<void>;
  listGaps(callId: string): Promise<GapDoc[]>;

  /** 処理中（期限内）の重複は processing、期限切れの処理中は引き継いで new を返す */
  beginWebhookEvent(eventKey: string, expiresAt: string, leaseMs: number): Promise<WebhookBegin>;
  completeWebhookEvent(eventKey: string, result: unknown): Promise<void>;
  abandonWebhookEvent(eventKey: string): Promise<void>;

  /** jobId は決定的に作る。既存なら created=false */
  createJob(job: JobDoc): Promise<{ job: JobDoc; created: boolean }>;
  /** 処理権を取得する。他インスタンスが実行中・完了済みなら null */
  claimJob(jobId: string, lockMs: number): Promise<JobDoc | null>;
  updateJob(jobId: string, patch: Partial<JobDoc>): Promise<void>;
  /** 現在の状態が pred を満たすときだけ更新する（実行中ジョブの状態を上書きしない） */
  updateJobIf(jobId: string, pred: (job: JobDoc) => boolean, patch: Partial<JobDoc>): Promise<boolean>;
  listStaleJobs(olderThanIso: string, limit: number): Promise<JobDoc[]>;

  deleteExpiredAux(nowIso: string, limit: number): Promise<number>;

  getSettings(): Promise<SettingsDoc>;
  /** revision が一致した場合のみ更新する（同時編集の上書き防止）。不一致なら null */
  updateSettings(patch: Pick<SettingsDoc, 'sipTargetUri'>, expectedRevision: number): Promise<SettingsDoc | null>;

  /** 一覧用。購読開始後の変更のみ通知する */
  watchCalls(cb: (call: CallDoc) => void): Unsubscribe;
  /** 選択通話用。購読開始後の変更のみ通知する */
  watchCall(callId: string, cb: (ev: CallStreamEvent) => void): Unsubscribe;
  /** 音声中継用。通話ドキュメントの変更だけを購読する */
  watchCallDoc(callId: string, cb: (call: CallDoc) => void): Unsubscribe;

  close(): Promise<void>;
}

export function isOpenCall(c: CallDoc): boolean {
  return (
    c.legsSettled === false ||
    ['ivr', 'dialing', 'active'].includes(c.callStatus) ||
    ['starting', 'streaming', 'degraded', 'finalizing'].includes(c.transcriptionStatus)
  );
}

export function matchesFilter(c: CallDoc, filter: CallFilter): boolean {
  if (filter === 'all') return true;
  const active = ['ivr', 'dialing', 'active'].includes(c.callStatus);
  return filter === 'active' ? active : !active;
}

export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(cursor: string | null): (string | number)[] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

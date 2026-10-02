// ドメイン型。Firestore のドキュメント形状とブラウザへ返す JSON の両方に使う。
// 日時はすべて UTC の ISO 8601 文字列で保存する（表示時に Asia/Tokyo へ変換）。

export type Role = 'caller' | 'operator';
export const ROLES: readonly Role[] = ['caller', 'operator'];

export type Engine = 'amivoice' | 'elevenlabs' | 'deepgram';
export const ENGINE_BY_DIGIT: Record<string, Engine> = {
  '1': 'amivoice',
  '2': 'elevenlabs',
  '3': 'deepgram',
};
export const ENGINE_LABEL: Record<Engine, string> = {
  amivoice: 'AmiVoice',
  elevenlabs: 'ElevenLabs',
  deepgram: 'Deepgram',
};

export type CallStatus = 'ivr' | 'dialing' | 'active' | 'ended' | 'failed' | 'abandoned';
export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = ['ended', 'failed', 'abandoned'];

export type TranscriptionStatus =
  | 'not_started'
  | 'starting'
  | 'streaming'
  | 'degraded'
  | 'finalizing'
  | 'completed'
  | 'partial'
  | 'failed';
export const FINAL_TRANSCRIPTION_STATUSES: readonly TranscriptionStatus[] = [
  'not_started',
  'completed',
  'partial',
  'failed',
];

/** 話者ごとの認識ストリーム状態 */
export type RoleAsrStatus =
  | 'not_started'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'failed'
  | 'finalizing'
  | 'done';

export interface RoleState {
  asrStatus: RoleAsrStatus;
  /** 監視 WS レッグの世代。再作成のたびに増える。0 = 未作成 */
  wsGeneration: number;
  /** ASR セッションの世代。ASR 再接続・WS 再接続で増える */
  streamEpoch: number;
  /** 最終化結果。null = 未確定 */
  final: 'completed' | 'partial' | null;
  /** 監視 WS 再作成の回数 */
  wsRecreateCount: number;
  errorCode: string | null;
  /** 応答から WS 確立（音声受信開始）までの欠落時間 */
  startupGapMs: number | null;
  /** 直前の監視ストリームが終わった音声位置（認識開始基準からの ms）。WS 再接続時の欠落記録に使う */
  lastAudioMs: number | null;
  /** 欠落区間を記録したか。true なら最終結果は partial */
  hadGap: boolean;
}

export type EndReason =
  | 'caller_hangup'
  | 'operator_hangup'
  | 'ivr_hangup'
  | 'ivr_no_selection'
  | 'dialing_hangup'
  | 'sip_busy'
  | 'sip_rejected'
  | 'sip_unanswered'
  | 'sip_failed'
  | 'sip_timeout'
  | 'sip_cancelled'
  | 'reconciled'
  | 'unknown';

export interface CallDoc {
  callId: string;
  /** E.164 等に正規化した発信番号。非通知・不明なら null */
  callerNumber: string | null;
  /** Vonage から受け取った元の値 */
  rawCallerNumber: string | null;
  callerNumberKind: 'normal' | 'withheld' | 'unknown';
  calledNumber: string | null;
  rawCalledNumber: string | null;
  engine: Engine | null;
  engineConfigVersion: string | null;
  receivedAt: string;
  sipAnsweredAt: string | null;
  /** PBX イベント連携時の拡張用。初期版では設定しない */
  operatorAnsweredAt: string | null;
  endedAt: string | null;
  callStatus: CallStatus;
  transcriptionStatus: TranscriptionStatus;
  endReason: EndReason | null;
  /** 全音声時刻の基準（SIP レッグ answered の時刻） */
  recognitionBaseAt: string | null;
  inboundUuid: string;
  conversationName: string;
  ivrAttempts: number;
  roles: Record<Role, RoleState>;
  /** この通話で発信した SIP URI（画面の設定変更後も通話ごとに残す） */
  sipTargetUri?: string | null;
  /** 終話後、全レッグ（監視 WS を含む）の終了を照合処理が確認したか */
  legsSettled?: boolean;
  /** 55 分の認識上限に到達したか */
  limitReached: boolean;
  finalizeDeadlineAt: string | null;
  expiresAt: string;
  /** 楽観的な更新世代。SSE イベントの revision に使う */
  revision: number;
  updatedAt: string;
}

export type LegRole = 'caller' | 'sip' | 'caller_ws' | 'operator_ws';

export interface LegDoc {
  legId: string;
  callId: string;
  role: LegRole;
  generation: number;
  vonageUuid: string | null;
  /** creating: API 呼出中 / unknown: API タイムアウト等で生成有無が不明 */
  status: string;
  createdAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export type TimestampQuality = 'vendor' | 'estimated';

export interface SegmentDoc {
  callId: string;
  segmentId: string;
  role: Role;
  streamEpoch: number;
  text: string;
  startMs: number;
  endMs: number;
  timestampQuality: TimestampQuality;
  isFinal: true;
  revision: number;
  providerResultId: string | null;
  receivedAt: string;
  updatedAt: string;
}

export interface LiveDoc {
  callId: string;
  role: Role;
  segmentId: string;
  streamEpoch: number;
  revision: number;
  text: string;
  startMs: number | null;
  /** 終話時に確定しなかった文字。不完全ログで独立項目として扱う */
  unconfirmed: boolean;
  updatedAt: string;
}

export type GapReason =
  | 'audio_queue_overflow'
  | 'asr_disconnected'
  | 'asr_failed'
  | 'monitor_ws_lost'
  | 'finalize_timeout'
  | 'db_write_failed'
  | 'limit_reached';

export interface GapDoc {
  callId: string;
  gapId: string;
  role: Role;
  startMs: number;
  endMs: number | null;
  reason: GapReason;
  createdAt: string;
}

export interface WebhookEventDoc {
  eventKey: string;
  status: 'processing' | 'done';
  result: unknown;
  /** 処理権の期限。処理中にプロセスが落ちても、期限後の再送で処理をやり直せる */
  leaseUntil: string;
  receivedAt: string;
  expiresAt: string;
}

export type JobOp = 'dialSip' | 'createMonitor' | 'hangupLegs' | 'announceAndHangup';

export interface JobDoc {
  jobId: string;
  callId: string;
  op: JobOp;
  /** 操作対象の世代番号（監視レッグ世代など）。冪等性キーの一部 */
  generation: number;
  params: Record<string, unknown>;
  status: 'pending' | 'enqueued' | 'running' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export function emptyRoleState(): RoleState {
  return {
    asrStatus: 'not_started',
    wsGeneration: 0,
    streamEpoch: 0,
    final: null,
    wsRecreateCount: 0,
    errorCode: null,
    startupGapMs: null,
    lastAudioMs: null,
    hadGap: false,
  };
}

/** 話者ごとの状態から通話全体の認識状態を導出する */
export function deriveTranscriptionStatus(call: Pick<CallDoc, 'roles' | 'callStatus' | 'transcriptionStatus'>): TranscriptionStatus {
  const states = ROLES.map((r) => call.roles[r]);
  const expected = states.filter((s) => s.wsGeneration > 0);
  const terminal = TERMINAL_CALL_STATUSES.includes(call.callStatus);

  if (expected.length === 0) {
    return terminal ? 'not_started' : call.transcriptionStatus === 'starting' ? 'starting' : 'not_started';
  }
  if (expected.every((s) => s.final !== null)) {
    if (expected.every((s) => s.asrStatus === 'failed')) return 'failed';
    return expected.every((s) => s.final === 'completed') ? 'completed' : 'partial';
  }
  if (terminal || states.some((s) => s.asrStatus === 'finalizing' || s.final !== null)) return 'finalizing';
  if (states.some((s) => s.asrStatus === 'failed' || s.asrStatus === 'reconnecting')) return 'degraded';
  if (expected.length === ROLES.length && expected.every((s) => s.asrStatus === 'streaming')) return 'streaming';
  if (expected.some((s) => s.asrStatus === 'streaming')) {
    // 片側だけ開始済み。もう片方が準備中なら starting のまま、それ以外は degraded
    return expected.some((s) => s.asrStatus === 'connecting' || s.asrStatus === 'not_started') ? 'starting' : 'degraded';
  }
  return 'starting';
}

/** 画面から変更できる運用設定（settings/app）。未設定の項目は環境変数の既定値を使う */
export interface SettingsDoc {
  sipTargetUri: string | null;
  revision: number;
  updatedAt: string | null;
}

export const EMPTY_SETTINGS: SettingsDoc = { sipTargetUri: null, revision: 0, updatedAt: null };

/** sip:user@host[:port][;params] 形式。空白・制御文字・山括弧などは拒否する */
export const SIP_URI_RE = /^sips?:[A-Za-z0-9._~%!$&'()*+,=:-]+@[A-Za-z0-9.-]+(:[0-9]{1,5})?(;[A-Za-z0-9._~%=-]+)*$/;

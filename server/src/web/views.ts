// ブラウザへ返す表現。内部用の Vonage UUID などは返さない。
import { ENGINE_LABEL, FINAL_TRANSCRIPTION_STATUSES, TERMINAL_CALL_STATUSES, type CallDoc } from '../shared/types.js';
import { displayNumber } from '../shared/phone.js';
import { shortCallId } from '../shared/ids.js';

export interface CallView {
  callId: string;
  shortCallId: string;
  callerDisplay: string;
  callerNumber: string | null;
  rawCallerNumber: string | null;
  calledDisplay: string;
  engine: CallDoc['engine'];
  engineLabel: string | null;
  engineConfigVersion: string | null;
  receivedAt: string;
  sipAnsweredAt: string | null;
  endedAt: string | null;
  recognitionBaseAt: string | null;
  callStatus: CallDoc['callStatus'];
  transcriptionStatus: CallDoc['transcriptionStatus'];
  endReason: CallDoc['endReason'];
  roles: Record<'caller' | 'operator', { asrStatus: string; errorCode: string | null; startupGapMs: number | null; final: string | null }>;
  limitReached: boolean;
  sipTargetUri: string | null;
  exportable: boolean;
  expiresAt: string;
  revision: number;
}

export function isExportable(c: CallDoc): boolean {
  return TERMINAL_CALL_STATUSES.includes(c.callStatus) && FINAL_TRANSCRIPTION_STATUSES.includes(c.transcriptionStatus);
}

export function toCallView(c: CallDoc): CallView {
  const role = (r: 'caller' | 'operator') => ({
    asrStatus: c.roles[r].asrStatus,
    errorCode: c.roles[r].errorCode,
    startupGapMs: c.roles[r].startupGapMs,
    final: c.roles[r].final,
  });
  return {
    callId: c.callId,
    shortCallId: shortCallId(c.callId),
    callerDisplay: displayNumber(c.callerNumber, c.callerNumberKind),
    callerNumber: c.callerNumber,
    rawCallerNumber: c.rawCallerNumber,
    calledDisplay: displayNumber(c.calledNumber, c.calledNumber ? 'normal' : 'unknown'),
    engine: c.engine,
    engineLabel: c.engine ? ENGINE_LABEL[c.engine] : null,
    engineConfigVersion: c.engineConfigVersion,
    receivedAt: c.receivedAt,
    sipAnsweredAt: c.sipAnsweredAt,
    endedAt: c.endedAt,
    recognitionBaseAt: c.recognitionBaseAt,
    callStatus: c.callStatus,
    transcriptionStatus: c.transcriptionStatus,
    endReason: c.endReason,
    roles: { caller: role('caller'), operator: role('operator') },
    limitReached: c.limitReached,
    sipTargetUri: c.sipTargetUri ?? null,
    exportable: isExportable(c),
    expiresAt: c.expiresAt,
    revision: c.revision,
  };
}

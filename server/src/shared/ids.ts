import { randomBytes, createHash } from 'node:crypto';

/** 時刻順に並ぶ callId（電話番号を含めない） */
export function newCallId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${ts}-${randomBytes(5).toString('hex')}`;
}

export function shortCallId(callId: string): string {
  return callId.slice(-6);
}

export function conversationName(callId: string): string {
  return `cw-${callId}`;
}

export function segmentId(role: string, epoch: number, seq: number): string {
  return `${role}-e${epoch}-s${seq}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomId(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

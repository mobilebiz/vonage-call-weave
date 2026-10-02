import type { CallStatus, TranscriptionStatus } from './api';

const tz = 'Asia/Tokyo';
const time = new Intl.DateTimeFormat('ja-JP', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTime = new Intl.DateTimeFormat('ja-JP', {
  timeZone: tz,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dayKey = new Intl.DateTimeFormat('ja-JP', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });

export const fmtTime = (iso: string | null) => (iso ? time.format(new Date(iso)) : '-');
export const fmtDateTime = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : '-');

/** 今日なら時刻のみ、それ以外は日付付き */
export function fmtReceived(iso: string): string {
  const d = new Date(iso);
  return dayKey.format(d) === dayKey.format(new Date()) ? time.format(d) : dateTime.format(d);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 応答基準からの相対 ms を Asia/Tokyo の時刻へ */
export function fmtAt(baseIso: string | null, offsetMs: number | null): string {
  if (!baseIso || offsetMs === null) return '';
  return time.format(new Date(Date.parse(baseIso) + offsetMs));
}

export const CALL_STATUS: Record<CallStatus, { label: string; tone: string }> = {
  ivr: { label: 'IVR中', tone: 'wait' },
  dialing: { label: '呼出中', tone: 'wait' },
  active: { label: '通話中', tone: 'live' },
  ended: { label: '終了', tone: 'done' },
  failed: { label: '接続失敗', tone: 'bad' },
  abandoned: { label: '途中切断', tone: 'muted' },
};

export const TX_STATUS: Record<TranscriptionStatus, { label: string; tone: string }> = {
  not_started: { label: '認識なし', tone: 'muted' },
  starting: { label: '認識準備中', tone: 'wait' },
  streaming: { label: '認識中', tone: 'live' },
  degraded: { label: '一部認識停止', tone: 'warn' },
  finalizing: { label: '最終化中', tone: 'wait' },
  completed: { label: '完了', tone: 'done' },
  partial: { label: '不完全', tone: 'warn' },
  failed: { label: '認識失敗', tone: 'bad' },
};

export const ROLE_ASR: Record<string, string> = {
  not_started: '未開始',
  connecting: '準備中',
  streaming: '認識中',
  reconnecting: '再接続中',
  failed: '認識停止',
  finalizing: '最終化中',
  done: '完了',
};

export const END_REASON: Record<string, string> = {
  caller_hangup: '発信者が終話',
  operator_hangup: 'オペレーター側が終話',
  ivr_hangup: 'IVR中に切断',
  ivr_no_selection: 'エンジン未選択',
  dialing_hangup: '呼出中に切断',
  sip_busy: 'PBX 話中',
  sip_rejected: 'PBX 拒否',
  sip_unanswered: 'PBX 無応答',
  sip_failed: 'PBX 接続失敗',
  sip_timeout: 'PBX 呼出タイムアウト',
  sip_cancelled: 'PBX 呼出取消',
  reconciled: '照合で終了',
};

export const GAP_REASON: Record<string, string> = {
  audio_queue_overflow: '音声キュー超過',
  asr_disconnected: '音声認識の切断',
  asr_failed: '音声認識の停止',
  monitor_ws_lost: '音声受信の切断',
  finalize_timeout: '最終化タイムアウト',
  db_write_failed: '保存失敗',
  limit_reached: '文字起こし上限',
};

export const ROLE_LABEL = { caller: '発信者', operator: 'オペレーター' } as const;

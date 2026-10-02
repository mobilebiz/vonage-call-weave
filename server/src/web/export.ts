// TXT / JSON エクスポート。ダウンロード時にデータから生成し、ファイルとしては保存しない。
import type { Store } from '../store/store.js';
import { ENGINE_LABEL, type CallDoc, type GapDoc, type LiveDoc, type SegmentDoc } from '../shared/types.js';
import { compactTokyo, formatOffset, formatTokyo } from '../shared/time.js';
import { displayNumber } from '../shared/phone.js';
import { shortCallId } from '../shared/ids.js';
import { compareSegments } from '../shared/ordering.js';

export const ROLE_LABEL = { caller: '発信者', operator: 'オペレーター' } as const;

const GAP_LABEL: Record<GapDoc['reason'], string> = {
  audio_queue_overflow: '音声キュー超過',
  asr_disconnected: '音声認識の切断',
  asr_failed: '音声認識の停止',
  monitor_ws_lost: '音声受信の切断',
  finalize_timeout: '最終化タイムアウト',
  db_write_failed: '保存失敗',
  limit_reached: '文字起こし上限',
};

const COMPLETENESS: Record<string, string> = {
  completed: '完了',
  partial: '不完全（一部の音声が含まれていません）',
  failed: '失敗（音声認識できませんでした）',
  not_started: '文字起こしなし（オペレーター接続前に終了）',
};

export interface ExportData {
  call: CallDoc;
  segments: SegmentDoc[];
  gaps: GapDoc[];
  unconfirmed: LiveDoc[];
}

export async function loadExportData(store: Store, call: CallDoc): Promise<ExportData> {
  const segments: SegmentDoc[] = [];
  let cursor: string | null = null;
  do {
    const page = await store.listSegments(call.callId, 500, cursor);
    segments.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  segments.sort(compareSegments);
  const gaps = await store.listGaps(call.callId);
  const unconfirmed = (await store.listLive(call.callId)).filter((l) => l.text);
  return { call, segments, gaps, unconfirmed };
}

export function exportFileName(call: CallDoc, ext: 'txt' | 'json'): string {
  return `callweave_${compactTokyo(call.receivedAt)}_${shortCallId(call.callId)}.${ext}`;
}

function wallClock(call: CallDoc, offsetMs: number): string {
  if (!call.recognitionBaseAt) return formatOffset(offsetMs);
  const t = formatTokyo(new Date(Date.parse(call.recognitionBaseAt) + offsetMs).toISOString());
  return t.split(' ')[1] ?? t;
}

export function renderTxt({ call, segments, gaps, unconfirmed }: ExportData): string {
  const lines: string[] = [];
  lines.push('CallWeave 通話文字起こし');
  lines.push('');
  lines.push(`callId: ${call.callId}`);
  lines.push(`発信番号: ${displayNumber(call.callerNumber, call.callerNumberKind)}`);
  lines.push(`着信日時: ${formatTokyo(call.receivedAt)}`);
  lines.push(`応答日時: ${formatTokyo(call.sipAnsweredAt)}`);
  lines.push(`終了日時: ${formatTokyo(call.endedAt)}`);
  lines.push(`音声認識エンジン: ${call.engine ? ENGINE_LABEL[call.engine] : '-'}（設定 ${call.engineConfigVersion ?? '-'}）`);
  lines.push(`認識の完全性: ${COMPLETENESS[call.transcriptionStatus] ?? call.transcriptionStatus}`);
  if (call.limitReached) lines.push('注記: 文字起こし上限（55分）に到達したため、以降の会話は含まれていません');
  lines.push('時刻: Asia/Tokyo（括弧内は応答からの経過時間）');
  lines.push('');
  lines.push('--- 会話 ---');
  if (!segments.length) lines.push('（発話なし）');
  for (const s of segments) {
    const mark = s.timestampQuality === 'estimated' ? '~' : '';
    lines.push(`[${wallClock(call, s.startMs)} ${mark}+${formatOffset(s.startMs)}] ${ROLE_LABEL[s.role]}: ${s.text}`);
  }
  if (gaps.length) {
    lines.push('');
    lines.push('--- 欠落区間 ---');
    for (const g of gaps) {
      const end = g.endMs === null ? '終了まで' : formatOffset(g.endMs);
      lines.push(`${ROLE_LABEL[g.role]}: +${formatOffset(g.startMs)} - ${end}  ${GAP_LABEL[g.reason]}`);
    }
  }
  if (unconfirmed.length) {
    lines.push('');
    lines.push('--- 未確定の認識結果（確定前に終了） ---');
    for (const u of unconfirmed) lines.push(`${ROLE_LABEL[u.role]}: ${u.text}`);
  }
  lines.push('');
  return lines.join('\r\n');
}

export function renderJson({ call, segments, gaps, unconfirmed }: ExportData): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      project: 'CallWeave',
      call: {
        callId: call.callId,
        callerNumber: call.callerNumber,
        rawCallerNumber: call.rawCallerNumber,
        callerNumberKind: call.callerNumberKind,
        calledNumber: call.calledNumber,
        receivedAt: call.receivedAt,
        sipAnsweredAt: call.sipAnsweredAt,
        endedAt: call.endedAt,
        callStatus: call.callStatus,
        endReason: call.endReason,
        transcriptionStatus: call.transcriptionStatus,
        limitReached: call.limitReached,
        recognitionBaseAt: call.recognitionBaseAt,
        startupGapMs: { caller: call.roles.caller.startupGapMs, operator: call.roles.operator.startupGapMs },
      },
      engine: { name: call.engine, configVersion: call.engineConfigVersion },
      segments: segments.map((s) => ({
        segmentId: s.segmentId,
        role: s.role,
        streamEpoch: s.streamEpoch,
        revision: s.revision,
        text: s.text,
        startMs: s.startMs,
        endMs: s.endMs,
        timestampQuality: s.timestampQuality,
        isFinal: true,
      })),
      gaps: gaps.map((g) => ({ gapId: g.gapId, role: g.role, startMs: g.startMs, endMs: g.endMs, reason: g.reason })),
      unconfirmed: unconfirmed.map((u) => ({ role: u.role, segmentId: u.segmentId, text: u.text, startMs: u.startMs, isFinal: false })),
    },
    null,
    2,
  );
}

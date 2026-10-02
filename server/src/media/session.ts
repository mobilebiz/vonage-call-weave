// 監視 WS 1 本（= 1 話者）の音声ストリームを管理する。
// Vonage からの PCM を ASR へ中継し、途中結果・確定結果・欠落区間を正規化して保存する。
// 各インスタンスは自分のストリームだけをメモリで持ち、終了要求や世代は Firestore の通話ドキュメントで共有する。
import type { WebSocket } from 'ws';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { errInfo } from '../log.js';
import type { Store, Unsubscribe } from '../store/store.js';
import type { AsrFactory } from './asr/index.js';
import { BYTES_PER_MS, type AsrAdapter, type AsrErrorInfo, type AsrResult } from './asr/types.js';
import {
  TERMINAL_CALL_STATUSES,
  deriveTranscriptionStatus,
  type CallDoc,
  type GapDoc,
  type GapReason,
  type LiveDoc,
  type Role,
  type RoleState,
  type SegmentDoc,
  type TimestampQuality,
} from '../shared/types.js';
import { nowIso, sleep } from '../shared/time.js';
import { segmentId } from '../shared/ids.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const READY_TIMEOUT_MS = 10_000;
const WAIT_FOR_CALL_END_MS = 20_000;
/** 時刻情報がない途中結果の推定遅延 */
const ESTIMATED_LATENCY_MS = 1000;

export interface SessionDeps {
  cfg: Config;
  store: Store;
  asrFactory: AsrFactory;
  log: Logger;
}

type EndReason = 'call_ended' | 'limit' | 'ws_closed' | 'superseded' | 'shutdown';

interface SegState {
  segmentId: string;
  revision: number;
  startMs: number | null;
  quality: TimestampQuality;
  final: boolean;
}

interface Queued {
  buf: Buffer;
  /** ストリーム内の音声位置 */
  startMs: number;
}

export class StreamSession {
  private state: 'init' | 'running' | 'finalizing' | 'closed' = 'init';
  private call!: CallDoc;
  private streamOffsetMs = 0;
  /** このストリームで受信した音声の長さ（サンプル数から計算） */
  private streamAudioMs = 0;

  private adapter: AsrAdapter | null = null;
  private asrReady = false;
  private asrFailed = false;
  private epoch = 0;
  private seq = 0;
  /** 現 ASR セッションに最初に送った音声のストリーム内位置 */
  private sessionStartMs: number | null = null;
  private lastFinalEndMs: number | null = null;
  private retries = 0;
  private readyTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private limitTimer: NodeJS.Timeout | null = null;

  private queue: Queued[] = [];
  private queueBytes = 0;
  private overflowGap: { startMs: number; endMs: number } | null = null;
  private failGap: GapDoc | null = null;

  private segs = new Map<string, SegState>();
  private currentLiveSegment: string | null = null;
  private pendingLive: LiveDoc | null = null;
  private lastLiveWrite = 0;
  private liveTimer: NodeJS.Timeout | null = null;

  private writes: Promise<unknown> = Promise.resolve();
  private pendingWrites = 0;
  private incomplete = false;
  private unwatch: Unsubscribe | null = null;
  private finalizePromise: Promise<void> | null = null;
  private readonly log: Logger;

  constructor(
    private readonly deps: SessionDeps,
    readonly callId: string,
    readonly role: Role,
    readonly gen: number,
    private readonly socket: WebSocket,
  ) {
    this.log = deps.log.child({ callId, role, gen });
  }

  private get cfg() {
    return this.deps.cfg;
  }
  private get store() {
    return this.deps.store;
  }
  /** 認識開始基準からの絶対位置（ms） */
  private abs(streamMs: number) {
    return Math.round(this.streamOffsetMs + streamMs);
  }

  // ------------------------------------------------------------------ 開始

  async start(): Promise<boolean> {
    const connectedAt = Date.now();
    const call = await this.store.getCall(this.callId);
    if (this.state !== 'init') return false; // 開始処理中に WS が閉じた
    const reject = (why: string) => {
      this.log.warn('media stream rejected', { why });
      this.state = 'closed';
      this.socket.close(1008, why);
      return false;
    };
    if (!call || !call.engine || !call.recognitionBaseAt) return reject('call_not_ready');
    if (TERMINAL_CALL_STATUSES.includes(call.callStatus) || call.limitReached) return reject('call_not_active');
    if (call.roles[this.role].wsGeneration !== this.gen) return reject('stale_generation');
    this.call = call;
    this.streamOffsetMs = Math.max(0, connectedAt - Date.parse(call.recognitionBaseAt));
    this.state = 'running';

    const prev = call.roles[this.role];
    // 監視 WS の再作成時は、前世代の終了位置から今回の開始位置までを欠落として記録する
    if (this.gen > 1 && prev.lastAudioMs !== null && this.streamOffsetMs > prev.lastAudioMs) {
      await this.putGap({ gapId: `${this.role}-wslost-g${this.gen}`, startMs: prev.lastAudioMs, endMs: this.streamOffsetMs, reason: 'monitor_ws_lost' });
    }
    await this.updateRole((rs) => ({
      ...rs,
      startupGapMs: rs.startupGapMs ?? this.streamOffsetMs,
      asrStatus: rs.asrStatus === 'failed' ? 'failed' : 'connecting',
    }));

    this.unwatch = this.store.watchCallDoc(this.callId, (c) => this.onCallChanged(c));
    const remaining = Date.parse(call.recognitionBaseAt) + this.cfg.transcriptionLimitMs - Date.now();
    this.limitTimer = setTimeout(() => void this.onLimit(), Math.max(0, remaining));
    this.log.info('media stream started', { streamOffsetMs: this.streamOffsetMs });
    await this.openAsr();
    return true;
  }

  private onCallChanged(c: CallDoc) {
    this.call = c;
    if (c.roles[this.role].wsGeneration > this.gen) void this.end('superseded');
    else if (TERMINAL_CALL_STATUSES.includes(c.callStatus)) void this.end('call_ended');
    else if (c.limitReached) void this.end('limit');
  }

  // ------------------------------------------------------------------ ASR

  private async openAsr() {
    if (this.state !== 'running') return;
    this.asrReady = false;
    this.sessionStartMs = null;
    this.lastFinalEndMs = null;
    this.segs.clear();
    this.epoch = await this.allocateEpoch();
    this.seq = 0;
    const adapter = this.deps.asrFactory(this.call.engine!, this.role, {
      onReady: () => this.onAsrReady(adapter),
      onPartial: (r) => adapter === this.adapter && this.onPartial(r),
      onFinal: (r) => adapter === this.adapter && this.onFinal(r),
      onError: (e) => adapter === this.adapter && this.onAsrError(e),
      onClose: (expected) => adapter === this.adapter && this.onAsrClose(expected),
    });
    this.adapter = adapter;
    this.readyTimer = setTimeout(() => {
      if (adapter === this.adapter && !this.asrReady) {
        this.log.warn('asr ready timeout');
        this.onAsrDisconnected('asr_ready_timeout');
      }
    }, READY_TIMEOUT_MS);
    try {
      await adapter.open();
    } catch (err) {
      this.log.warn('asr open failed', errInfo(err));
      this.onAsrDisconnected('asr_open_failed');
    }
  }

  private async allocateEpoch(): Promise<number> {
    let epoch = this.epoch + 1;
    await this.updateRole((rs) => {
      epoch = Math.max(rs.streamEpoch, this.epoch) + 1;
      return { ...rs, streamEpoch: epoch };
    });
    return epoch;
  }

  private onAsrReady(adapter: AsrAdapter) {
    if (adapter !== this.adapter || this.state === 'closed') return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.asrReady = true;
    this.retries = 0;
    this.flushQueue();
    this.log.info('asr ready', { engine: adapter.name, epoch: this.epoch });
    void this.updateRole((rs) => (rs.asrStatus === 'finalizing' || rs.asrStatus === 'done' ? null : { ...rs, asrStatus: 'streaming', errorCode: null }));
  }

  private flushQueue() {
    if (this.overflowGap) {
      const g = this.overflowGap;
      this.overflowGap = null;
      void this.putGap({ gapId: `${this.role}-ovf-e${this.epoch}-${g.startMs}`, startMs: g.startMs, endMs: g.endMs, reason: 'audio_queue_overflow' });
    }
    for (const q of this.queue) this.sendToAsr(q.buf, q.startMs);
    this.queue = [];
    this.queueBytes = 0;
  }

  private sendToAsr(buf: Buffer, streamMs: number) {
    this.sessionStartMs ??= streamMs;
    this.adapter!.writeAudio(buf);
  }

  private onAsrError(e: AsrErrorInfo) {
    // ベンダーのエラー文（認証失敗理由など）。認識本文や鍵は含まれない
    this.log.warn('asr error', { code: e.code, fatal: e.fatal, vendorMessage: e.message?.slice(0, 200) });
    if (e.fatal) this.failAsr(e.code);
  }

  private onAsrClose(expected: boolean) {
    if (expected || this.state !== 'running' || this.asrFailed) return;
    this.onAsrDisconnected('asr_disconnected');
  }

  /** 予期しない切断。送信済み・未確定の音声は再送せず不確実区間として記録し、新しい epoch で再開する */
  private onAsrDisconnected(code: string) {
    if (this.state !== 'running' || this.asrFailed) return;
    const adapter = this.adapter;
    this.adapter = null;
    this.asrReady = false;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    adapter?.close();

    if (this.sessionStartMs !== null) {
      const from = this.lastFinalEndMs ?? this.abs(this.sessionStartMs);
      const to = this.abs(this.streamAudioMs - this.queueBytes / BYTES_PER_MS);
      if (to > from) void this.putGap({ gapId: `${this.role}-disc-e${this.epoch}`, startMs: from, endMs: to, reason: 'asr_disconnected' });
    }
    this.clearLive();

    if (this.retries >= RETRY_DELAYS_MS.length) {
      this.failAsr(`${code}_retry_exhausted`);
      return;
    }
    const delay = RETRY_DELAYS_MS[this.retries]! + Math.floor(Math.random() * 300);
    this.retries++;
    this.log.warn('asr reconnecting', { code, attempt: this.retries, delay });
    void this.updateRole((rs) => ({ ...rs, asrStatus: 'reconnecting', errorCode: code }));
    this.retryTimer = setTimeout(() => void this.openAsr(), delay);
  }

  /** 認識不能（認証失敗・上限超過・再試行切れ）。人間同士の通話は継続する */
  private failAsr(code: string) {
    if (this.asrFailed) return;
    this.asrFailed = true;
    this.incomplete = true;
    this.asrReady = false;
    const adapter = this.adapter;
    this.adapter = null;
    adapter?.close();
    this.queue = [];
    this.queueBytes = 0;
    this.clearLive();
    this.failGap = this.makeGap(`${this.role}-failed-e${this.epoch}`, this.abs(this.streamAudioMs), null, 'asr_failed');
    void this.putGapDoc(this.failGap);
    this.log.error('asr failed', { code });
    void this.updateRole((rs) => ({ ...rs, asrStatus: 'failed', errorCode: code }));
  }

  // ------------------------------------------------------------------ 音声

  onAudio(buf: Buffer) {
    if (this.state !== 'running') return; // 終話後は新しい音声を取り込まない
    const startMs = this.streamAudioMs;
    this.streamAudioMs += buf.length / BYTES_PER_MS;
    if (this.asrFailed) return;
    if (this.asrReady && this.adapter) {
      this.sendToAsr(buf, startMs);
      return;
    }
    // ASR 準備中・再接続中は最大 N 秒だけ保持。超えた分は古い方から捨てて欠落として記録する
    this.queue.push({ buf, startMs });
    this.queueBytes += buf.length;
    const max = this.cfg.audioQueueMaxMs * BYTES_PER_MS;
    while (this.queueBytes > max && this.queue.length > 1) {
      const dropped = this.queue.shift()!;
      this.queueBytes -= dropped.buf.length;
      const end = this.abs(this.queue[0]!.startMs);
      if (this.overflowGap) this.overflowGap.endMs = end;
      else this.overflowGap = { startMs: this.abs(dropped.startMs), endMs: end };
    }
  }

  // ------------------------------------------------------------------ 結果

  private seg(key: string): SegState {
    let s = this.segs.get(key);
    if (!s) {
      s = { segmentId: segmentId(this.role, this.epoch, ++this.seq), revision: 0, startMs: null, quality: 'estimated', final: false };
      this.segs.set(key, s);
      if (this.segs.size > 200) {
        const oldest = this.segs.keys().next().value;
        if (oldest !== undefined) this.segs.delete(oldest);
      }
    }
    return s;
  }

  private toAbs(localMs: number | undefined): number | null {
    if (localMs === undefined || this.sessionStartMs === null) return null;
    return this.abs(this.sessionStartMs + localMs);
  }

  private estimateNow(): number {
    const base = this.sessionStartMs ?? this.streamAudioMs;
    return this.abs(Math.max(base, this.streamAudioMs - ESTIMATED_LATENCY_MS));
  }

  private onPartial(r: AsrResult) {
    if (!r.text) return;
    const s = this.seg(r.key);
    if (s.final) return;
    const vendorStart = this.toAbs(r.startMs);
    if (vendorStart !== null) {
      s.startMs = vendorStart;
      s.quality = 'vendor';
    } else if (s.startMs === null) {
      s.startMs = this.estimateNow();
    }
    s.revision++;
    this.currentLiveSegment = s.segmentId;
    this.scheduleLive({
      callId: this.callId,
      role: this.role,
      segmentId: s.segmentId,
      streamEpoch: this.epoch,
      revision: s.revision,
      text: r.text,
      startMs: s.startMs,
      unconfirmed: false,
      updatedAt: nowIso(),
    });
  }

  private onFinal(r: AsrResult) {
    const s = this.seg(r.key);
    const vendorStart = this.toAbs(r.startMs);
    const vendorEnd = this.toAbs(r.endMs);
    if (!r.text) {
      if (this.currentLiveSegment === s.segmentId) this.clearLive();
      this.segs.delete(r.key);
      return;
    }
    s.revision++;
    s.final = true;
    if (vendorStart !== null) {
      s.startMs = vendorStart;
      s.quality = 'vendor';
    }
    const startMs = s.startMs ?? this.estimateNow();
    const endMs = vendorEnd ?? Math.max(startMs, this.abs(this.streamAudioMs));
    this.lastFinalEndMs = Math.max(this.lastFinalEndMs ?? 0, endMs);
    const now = nowIso();
    // 保存内容はこの時点で固定する（書込み待ちの間に同じ発話の後着結果が来ても、revision を取り違えない）
    const doc: SegmentDoc = {
      callId: this.callId,
      segmentId: s.segmentId,
      role: this.role,
      streamEpoch: this.epoch,
      text: r.text,
      startMs,
      endMs,
      timestampQuality: s.quality,
      isFinal: true,
      revision: s.revision,
      providerResultId: r.providerResultId ?? null,
      receivedAt: now,
      updatedAt: now,
    };
    // 確定は即時書込み。同じ segmentId の後着（タイムスタンプ付き等）は revision で上書き
    this.write(() => this.store.upsertSegment(doc));
    if (this.currentLiveSegment === s.segmentId) this.clearLive();
  }

  /** 途中結果は話者ごとに最大 2 回/秒（初期値）に間引いて書く */
  private scheduleLive(live: LiveDoc) {
    this.pendingLive = live;
    const wait = this.lastLiveWrite + this.cfg.partialMinIntervalMs - Date.now();
    if (wait <= 0) this.flushLive();
    else this.liveTimer ??= setTimeout(() => this.flushLive(), wait);
  }

  private flushLive() {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    const live = this.pendingLive;
    if (!live) return;
    this.pendingLive = null;
    this.lastLiveWrite = Date.now();
    this.write(() => this.store.setLive(this.callId, this.role, live), true);
  }

  private clearLive() {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    this.pendingLive = null;
    this.currentLiveSegment = null;
    this.write(() => this.store.setLive(this.callId, this.role, null));
  }

  // ------------------------------------------------------------------ 永続化

  /** 書込みは順序を保って直列化し、有限回再試行する。上限を超えたら欠落として扱う */
  private write(fn: () => Promise<unknown>, droppable = false) {
    if (droppable && this.pendingWrites > 50) return;
    if (this.pendingWrites > 500) {
      this.incomplete = true;
      this.log.error('db write queue overflow');
      return;
    }
    this.pendingWrites++;
    this.writes = this.writes.then(async () => {
      for (let i = 0; i < 4; i++) {
        try {
          await fn();
          return;
        } catch (err) {
          if (i === 3) {
            this.incomplete = true;
            this.log.error('db write failed', errInfo(err));
          } else await sleep(200 * 3 ** i);
        }
      }
    }).finally(() => this.pendingWrites--);
  }

  private makeGap(gapId: string, startMs: number, endMs: number | null, reason: GapReason): GapDoc {
    return { callId: this.callId, gapId, role: this.role, startMs, endMs, reason, createdAt: nowIso() };
  }

  private putGap(g: { gapId: string; startMs: number; endMs: number | null; reason: GapReason }) {
    return this.putGapDoc(this.makeGap(g.gapId, g.startMs, g.endMs, g.reason));
  }

  private putGapDoc(gap: GapDoc) {
    this.incomplete = true;
    this.write(() => this.store.putGap(gap));
    return this.updateRole((rs) => (rs.hadGap ? null : { ...rs, hadGap: true }));
  }

  private async updateRole(fn: (rs: RoleState) => RoleState | null) {
    try {
      await this.store.mutateCall(this.callId, (c) => {
        // 監視 WS が再作成された後の旧世代セッションは、話者状態を書き換えない
        if (c.roles[this.role].wsGeneration !== this.gen) return null;
        const next = fn(c.roles[this.role]);
        if (!next) return null;
        c.roles[this.role] = next;
        c.transcriptionStatus = deriveTranscriptionStatus(c);
        return c;
      });
    } catch (err) {
      this.log.error('role state update failed', errInfo(err));
    }
  }

  // ------------------------------------------------------------------ 終了

  private async onLimit() {
    if (this.state !== 'running') return;
    this.log.info('transcription limit reached');
    await this.store.mutateCall(this.callId, (c) => (c.limitReached ? null : { ...c, limitReached: true }));
    await this.end('limit');
  }

  end(reason: EndReason): Promise<void> {
    this.finalizePromise ??= this.doEnd(reason).catch((err) => this.log.error('finalize failed', errInfo(err)));
    return this.finalizePromise;
  }

  private async doEnd(reason: EndReason) {
    if (this.state === 'init') {
      this.state = 'closed';
      return;
    }
    if (this.state !== 'running') return;
    this.state = 'finalizing';
    for (const t of [this.limitTimer, this.retryTimer, this.readyTimer]) if (t) clearTimeout(t);
    try {
      await this.finalizeStream(reason);
    } catch (err) {
      // 保存に失敗しても購読・ソケット・ASR は必ず解放する。最終化は照合処理の期限で不完全として確定する
      this.incomplete = true;
      this.log.error('finalize failed', errInfo(err));
    } finally {
      if (this.liveTimer) clearTimeout(this.liveTimer);
      this.adapter?.close();
      this.adapter = null;
      this.unwatch?.();
      this.state = 'closed';
      if (this.socket.readyState === this.socket.OPEN) this.socket.close(1000, reason);
      this.log.info('stream closed', { reason, incomplete: this.incomplete });
    }
  }

  private async finalizeStream(reason: EndReason) {
    const endAbs = this.abs(this.streamAudioMs);
    this.log.info('finalizing stream', { reason });

    const markFinal = reason === 'call_ended' || reason === 'limit';
    if (markFinal) await this.updateRole((rs) => (rs.asrStatus === 'failed' ? null : { ...rs, asrStatus: 'finalizing' }));

    // 残った受信キューを ASR へ送り、ベンダー別の finalize を待つ（最大 N 秒）
    const adapter = this.adapter;
    if (adapter && this.asrReady) {
      this.flushQueue();
      // ベンダーが確定できなかった（reject）場合も、待機切れと同じく不完全として扱う
      const done = await Promise.race([
        adapter.finalize().then(
          () => true,
          () => false,
        ),
        sleep(this.cfg.finalizeWaitMs).then(() => false),
      ]);
      if (!done) {
        this.incomplete = true;
        this.log.warn('asr finalize timeout');
      }
    } else if (!this.asrFailed && (this.queue.length || this.sessionStartMs !== null || !this.asrReady)) {
      // 準備が終わらないまま終話した。保持していた音声は認識できていない
      if (this.queue.length) {
        void this.putGap({ gapId: `${this.role}-unsent-e${this.epoch}`, startMs: this.abs(this.queue[0]!.startMs), endMs: endAbs, reason: 'asr_disconnected' });
      }
    }
    this.adapter = null;
    adapter?.close();

    // 確定しなかった途中結果は、確定として偽装せず「未確定」として残す
    if (this.pendingLive) this.flushLive();
    if (this.currentLiveSegment) {
      const live = (await this.store.listLive(this.callId)).find((l) => l.role === this.role);
      if (live && live.segmentId === this.currentLiveSegment) {
        this.incomplete = true;
        this.write(() => this.store.setLive(this.callId, this.role, { ...live, unconfirmed: true, updatedAt: nowIso() }));
      }
    }
    if (this.failGap) {
      const g = { ...this.failGap, endMs: endAbs };
      this.write(() => this.store.putGap(g));
    }
    await this.writes;

    if (markFinal) await this.markRoleFinal(endAbs);
    else if (reason === 'ws_closed') await this.awaitCallEnd(endAbs);
    else await this.updateRole((rs) => ({ ...rs, lastAudioMs: endAbs }));
  }

  /** WS が先に閉じた場合、終話（通常の切断）か監視レッグだけの切断かを見分ける */
  private async awaitCallEnd(endAbs: number) {
    await this.updateRole((rs) => ({ ...rs, lastAudioMs: endAbs }));
    const deadline = Date.now() + WAIT_FOR_CALL_END_MS;
    while (Date.now() < deadline) {
      const c = await this.store.getCall(this.callId);
      if (!c || c.roles[this.role].wsGeneration > this.gen) return;
      if (TERMINAL_CALL_STATUSES.includes(c.callStatus) || c.limitReached) {
        await this.markRoleFinal(endAbs);
        return;
      }
      await sleep(1000);
    }
  }

  private async markRoleFinal(endAbs: number) {
    const incomplete = this.incomplete;
    await this.updateRole((rs) => {
      if (rs.final !== null) return null;
      return {
        ...rs,
        final: incomplete || rs.hadGap || rs.asrStatus === 'failed' ? 'partial' : 'completed',
        asrStatus: rs.asrStatus === 'failed' ? 'failed' : 'done',
        lastAudioMs: endAbs,
      };
    });
  }
}

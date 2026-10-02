// 呼制御の中核。着信 → IVR → SIP 発信 → 監視 WS 作成 → 終話 の状態遷移と、
// 冪等な制御ジョブ（Cloud Tasks から実行）を扱う。
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { errInfo } from '../log.js';
import type { Store } from '../store/store.js';
import type { TaskQueue } from './queue.js';
import { VonageAmbiguousError, VonageApiError, type VonageClient } from '../vonage/client.js';
import {
  DIAL_FAILED,
  IVR_GIVE_UP,
  connectCallerNcco,
  ivrNcco,
  monitorLegNcco,
  sipLegNcco,
  talkAndEndNcco,
} from '../vonage/ncco.js';
import {
  ENGINE_BY_DIGIT,
  ROLES,
  TERMINAL_CALL_STATUSES,
  deriveTranscriptionStatus,
  emptyRoleState,
  type CallDoc,
  type EndReason,
  type JobDoc,
  type JobOp,
  type LegDoc,
  type LegRole,
  type Role,
} from '../shared/types.js';
import { addMs, nowIso } from '../shared/time.js';
import { conversationName, sha256 } from '../shared/ids.js';
import { ApiError } from '../shared/errors.js';
import { normalizeNumber } from '../shared/phone.js';
import { signMediaToken } from '../shared/mediaToken.js';

/** Vonage のレッグ終了系ステータス */
export const LEG_TERMINAL = ['completed', 'busy', 'cancelled', 'unanswered', 'rejected', 'failed', 'timeout'];

/** Webhook 処理権の期限。処理中に落ちたインスタンスの処理を、再送で引き継げるようにする */
const WEBHOOK_LEASE_MS = 30_000;
/** 処理中の重複 Webhook。5xx を返して Vonage に再送させる */
const retryLater = () => new ApiError(503, 'retry_later', 'webhook is being processed');

const SIP_REASON: Record<string, EndReason> = {
  busy: 'sip_busy',
  rejected: 'sip_rejected',
  unanswered: 'sip_unanswered',
  timeout: 'sip_timeout',
  failed: 'sip_failed',
  cancelled: 'sip_cancelled',
};

export interface VonageEvent {
  uuid?: string;
  status?: string;
  timestamp?: string;
  direction?: string;
  conversation_uuid?: string;
  [k: string]: unknown;
}

export class CallFlow {
  constructor(
    readonly cfg: Config,
    readonly store: Store,
    readonly vonage: VonageClient,
    readonly queue: TaskQueue,
    readonly log: Logger,
  ) {}

  private url(path: string, q: Record<string, string | number>): string {
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
    return `${this.cfg.controlBaseUrl}${path}?${qs}`;
  }

  private webhookExpiry(): string {
    return addMs(nowIso(), 2 * 24 * 3600_000);
  }

  // ---------------------------------------------------------------- Answer

  /** 着信。レコードを IVR より前に作成し、IVR の NCCO を返す。重複時も同じ NCCO を返す */
  async handleAnswer(body: Record<string, unknown>): Promise<unknown[]> {
    const inboundUuid = String(body.uuid ?? '');
    if (!inboundUuid) return talkAndEndNcco(DIAL_FAILED);
    const receivedAt = nowIso();
    const from = normalizeNumber(body.from);
    const to = normalizeNumber(body.to);
    // 接続先は着信時点の設定で固定する（設定変更は次の着信から反映）
    const settings = await this.store.getSettings();
    const sipTargetUri = settings.sipTargetUri || this.cfg.sip.targetUri || null;

    const { call, created } = await this.store.createCallForInbound(inboundUuid, (callId) => ({
      callId,
      callerNumber: from.normalized,
      rawCallerNumber: from.raw,
      callerNumberKind: from.kind,
      calledNumber: to.normalized,
      rawCalledNumber: to.raw,
      engine: null,
      engineConfigVersion: null,
      receivedAt,
      sipAnsweredAt: null,
      operatorAnsweredAt: null,
      endedAt: null,
      callStatus: 'ivr',
      transcriptionStatus: 'not_started',
      endReason: null,
      recognitionBaseAt: null,
      inboundUuid,
      conversationName: conversationName(callId),
      ivrAttempts: 1,
      roles: { caller: emptyRoleState(), operator: emptyRoleState() },
      limitReached: false,
      sipTargetUri,
      legsSettled: false,
      finalizeDeadlineAt: null,
      // 終話時に endedAt + 保存期間へ更新する。終話が記録されない場合の上限
      expiresAt: addMs(receivedAt, (this.cfg.retentionDays + 1) * 24 * 3600_000),
      revision: 1,
      updatedAt: receivedAt,
    }));

    if (created) {
      await this.store.putLeg({
        legId: 'caller',
        callId: call.callId,
        role: 'caller',
        generation: 1,
        vonageUuid: inboundUuid,
        status: 'answered',
        createdAt: receivedAt,
        connectedAt: receivedAt,
        endedAt: null,
        updatedAt: receivedAt,
      });
      this.log.info('inbound call registered', { callId: call.callId });
    }
    if (call.callStatus !== 'ivr') return talkAndEndNcco(DIAL_FAILED);
    return ivrNcco(this.url('/webhooks/vonage/input', { callId: call.callId, attempt: 1 }), false);
  }

  // ---------------------------------------------------------------- Input (DTMF)

  async handleInput(callId: string, attempt: number, body: Record<string, unknown>): Promise<unknown[]> {
    const key = `input-${callId}-${attempt}`;
    const begin = await this.store.beginWebhookEvent(key, this.webhookExpiry(), WEBHOOK_LEASE_MS);
    if (begin.state === 'done') return begin.result as unknown[];
    if (begin.state === 'processing') throw retryLater();
    try {
      const ncco = await this.decideInput(callId, attempt, body);
      await this.store.completeWebhookEvent(key, ncco);
      return ncco;
    } catch (err) {
      await this.store.abandonWebhookEvent(key);
      throw err;
    }
  }

  private async decideInput(callId: string, attempt: number, body: Record<string, unknown>): Promise<unknown[]> {
    const call = await this.store.getCall(callId);
    if (!call) return [];
    // 前回の処理が状態更新の後で失敗していた場合（再送）: 発信ジョブを保証して同じ NCCO を返す
    if (call.callStatus === 'dialing' && call.engine) return this.resumeDialing(call);
    if (call.callStatus !== 'ivr') return [];
    const dtmf = (body.dtmf ?? {}) as { digits?: string; timed_out?: boolean };
    const digit = (dtmf.digits ?? '').trim();
    const engine = ENGINE_BY_DIGIT[digit];

    if (engine) {
      const res = await this.store.mutateCall(callId, (c) => {
        if (c.callStatus !== 'ivr') return null;
        c.engine = engine;
        c.engineConfigVersion = this.cfg.asr.engineConfigVersion;
        c.callStatus = 'dialing';
        return c;
      });
      if (!res) return [];
      if (!res.changed) return res.call.callStatus === 'dialing' && res.call.engine ? this.resumeDialing(res.call) : [];
      this.log.info('engine selected', { callId, engine });
      return this.resumeDialing(res.call);
    }

    if (attempt < 2) {
      await this.store.mutateCall(callId, (c) => (c.callStatus === 'ivr' ? { ...c, ivrAttempts: attempt + 1 } : null));
      return ivrNcco(this.url('/webhooks/vonage/input', { callId, attempt: attempt + 1 }), true);
    }
    // 2 回とも選択できなかった。別エンジンへ勝手に切り替えず、案内して終了する
    await this.endCall(callId, 'ivr_no_selection', nowIso(), 'failed', { keepCaller: true });
    return talkAndEndNcco(IVR_GIVE_UP);
  }

  /** SIP 発信ジョブを（冪等に）保証し、発信者を会話へ入れる NCCO を返す */
  private async resumeDialing(call: CallDoc): Promise<unknown[]> {
    await this.submitJob(call.callId, 'dialSip', 1, {});
    return connectCallerNcco({ engine: call.engine!, conversationName: call.conversationName, holdMusicUrl: this.cfg.holdMusicUrl });
  }

  // ---------------------------------------------------------------- Events

  async handleEvent(query: Record<string, string | undefined>, body: VonageEvent, rawBody: string): Promise<void> {
    const uuid = body.uuid;
    const status = body.status;
    if (!uuid || !status) return;
    const key = `ev-${sha256(`${uuid}|${status}|${body.timestamp ?? ''}|${sha256(rawBody)}`)}`;
    const begin = await this.store.beginWebhookEvent(key, this.webhookExpiry(), WEBHOOK_LEASE_MS);
    if (begin.state === 'done') return;
    if (begin.state === 'processing') throw retryLater();
    try {
      await this.applyEvent(query, body);
      await this.store.completeWebhookEvent(key, null);
    } catch (err) {
      await this.store.abandonWebhookEvent(key);
      throw err;
    }
  }

  private async resolveLeg(query: Record<string, string | undefined>, uuid: string): Promise<LegDoc | null> {
    if (query.callId && query.leg) {
      const legId = query.leg === 'sip' ? 'sip' : `${query.leg}-g${query.gen ?? '1'}`;
      const leg = await this.store.getLeg(query.callId, legId);
      if (leg) {
        if (!leg.vonageUuid) {
          await this.store.mutateLeg(leg.callId, leg.legId, (l) => ({ ...l, vonageUuid: uuid }));
          await this.store.indexLeg(uuid, leg.callId, leg.legId, addMs(nowIso(), 9 * 24 * 3600_000));
          leg.vonageUuid = uuid;
        }
        return leg;
      }
    }
    const idx = await this.store.findLegByUuid(uuid);
    return idx ? this.store.getLeg(idx.callId, idx.legId) : null;
  }

  async applyEvent(query: Record<string, string | undefined>, body: VonageEvent): Promise<void> {
    const uuid = body.uuid!;
    const status = body.status!;
    const at = typeof body.timestamp === 'string' ? body.timestamp : nowIso();
    const leg = await this.resolveLeg(query, uuid);
    if (!leg) {
      this.log.debug('event for unknown leg', { status });
      return;
    }
    // 終話後に生きているレッグ（発信結果が不明だったレッグの遅延応答など）は追跡できないうちに切断する
    if (!LEG_TERMINAL.includes(status) && leg.role !== 'caller') {
      const call = await this.store.getCall(leg.callId);
      if (call && TERMINAL_CALL_STATUSES.includes(call.callStatus)) {
        this.log.warn('late leg event after call ended; hanging up', { callId: leg.callId, leg: leg.legId, status });
        await this.vonage.hangup(uuid);
        return;
      }
    }
    // 終了済みレッグへの順序逆転イベントは無視する
    if (LEG_TERMINAL.includes(leg.status) && !LEG_TERMINAL.includes(status)) return;

    const isTerminal = LEG_TERMINAL.includes(status);
    const tracked = ['started', 'ringing', 'answered', ...LEG_TERMINAL];
    // 終了済みレッグへの再送は記録を書き換えないが、呼全体の終了処理は再実行する
    // （レッグ記録後に呼の更新が失敗していた場合の回復。各ハンドラーは冪等）
    if (tracked.includes(status) && !LEG_TERMINAL.includes(leg.status)) {
      await this.store.mutateLeg(leg.callId, leg.legId, (l) => ({
        ...l,
        status,
        connectedAt: status === 'answered' ? (l.connectedAt ?? at) : l.connectedAt,
        endedAt: isTerminal ? at : l.endedAt,
      }));
    }
    // 失敗理由の調査用。番号などの個人情報を含まない項目だけを残す
    const why: Record<string, unknown> = {};
    for (const k of ['detail', 'sip_code', 'reason', 'network', 'duration']) if (body[k] !== undefined) why[k] = body[k];
    this.log.info('leg event', { callId: leg.callId, leg: leg.legId, status, ...why });

    switch (leg.role) {
      case 'caller':
        if (isTerminal) await this.onCallerEnded(leg.callId, at);
        break;
      case 'sip':
        if (status === 'answered') await this.onSipAnswered(leg.callId, at);
        else if (isTerminal) await this.onSipEnded(leg.callId, status, at);
        break;
      case 'caller_ws':
      case 'operator_ws':
        if (isTerminal) await this.onMonitorEnded(leg, status);
        break;
    }
  }

  private async onCallerEnded(callId: string, at: string) {
    const call = await this.store.getCall(callId);
    if (!call || TERMINAL_CALL_STATUSES.includes(call.callStatus)) return;
    const reason: EndReason =
      call.callStatus === 'ivr' ? 'ivr_hangup' : call.callStatus === 'dialing' ? 'dialing_hangup' : 'caller_hangup';
    await this.endCall(callId, reason, at);
  }

  private async onSipAnswered(callId: string, at: string) {
    const res = await this.store.mutateCall(callId, (c) => {
      if (c.callStatus !== 'dialing') return null;
      c.callStatus = 'active';
      c.sipAnsweredAt = at;
      // PBX 本人応答イベントは対象外。SIP レッグの answered を認識開始基準にする
      c.recognitionBaseAt = at;
      for (const r of ROLES) c.roles[r] = { ...c.roles[r], wsGeneration: 1, asrStatus: 'connecting' };
      c.transcriptionStatus = 'starting';
      return c;
    });
    if (!res) return;
    const c = res.call;
    if (c.callStatus !== 'active') return;
    // 再送時も、初代の監視レッグ作成ジョブを（冪等に）保証する
    await Promise.all(
      ROLES.filter((role) => c.roles[role].wsGeneration === 1).map((role) => this.submitJob(callId, 'createMonitor', 1, { role })),
    );
  }

  private async onSipEnded(callId: string, status: string, at: string) {
    const call = await this.store.getCall(callId);
    if (!call || TERMINAL_CALL_STATUSES.includes(call.callStatus)) return;
    if (call.callStatus === 'dialing') {
      // 呼出失敗。理由を残し、発信者へ案内して終了する
      await this.endCall(callId, SIP_REASON[status] ?? 'sip_failed', at, 'failed', { announce: DIAL_FAILED });
      return;
    }
    await this.endCall(callId, 'operator_hangup', at);
  }

  private async onMonitorEnded(leg: LegDoc, status: string) {
    const role: Role = leg.role === 'caller_ws' ? 'caller' : 'operator';
    let nextGen = 0;
    const res = await this.store.mutateCall(leg.callId, (c) => {
      const rs = c.roles[role];
      if (c.callStatus !== 'active' || c.limitReached || rs.wsGeneration !== leg.generation) return null;
      if (rs.wsRecreateCount >= this.cfg.maxWsRecreate) {
        c.roles[role] = { ...rs, asrStatus: 'failed', errorCode: 'monitor_ws_lost' };
      } else {
        nextGen = rs.wsGeneration + 1;
        c.roles[role] = { ...rs, wsGeneration: nextGen, wsRecreateCount: rs.wsRecreateCount + 1, asrStatus: 'reconnecting' };
      }
      c.transcriptionStatus = deriveTranscriptionStatus(c);
      return c;
    });
    if (res?.changed && nextGen > 0) {
      this.log.warn('monitor leg lost; recreating', { callId: leg.callId, role, status, gen: nextGen });
      await this.submitJob(leg.callId, 'createMonitor', nextGen, { role });
    }
  }

  /** 通話を終了状態にする。認識は finalizing となり、音声中継サービスが最終化する */
  async endCall(
    callId: string,
    reason: EndReason,
    at: string,
    status?: CallDoc['callStatus'],
    opts: { announce?: string; keepCaller?: boolean } = {},
  ): Promise<boolean> {
    const res = await this.store.mutateCall(callId, (c) => {
      if (TERMINAL_CALL_STATUSES.includes(c.callStatus)) return null;
      c.callStatus =
        status ?? (c.callStatus === 'ivr' || c.callStatus === 'dialing' ? 'abandoned' : 'ended');
      c.endedAt = at;
      c.endReason = reason;
      c.expiresAt = addMs(at, this.cfg.retentionDays * 24 * 3600_000);
      c.transcriptionStatus = deriveTranscriptionStatus(c);
      if (c.transcriptionStatus === 'finalizing') c.finalizeDeadlineAt = addMs(nowIso(), this.cfg.finalizeDeadlineMs);
      return c;
    });
    if (!res) return false;
    if (res.changed) this.log.info('call ended', { callId, reason, callStatus: res.call.callStatus });
    // 相手レッグと監視 WS を終了させる（課金が続く孤児レッグを残さない）。
    // 発信者へ案内を流す場合は、発信者レッグは案内 NCCO の終了で切れるため残す
    const keepCaller = opts.keepCaller || !!opts.announce;
    await this.submitJob(callId, 'hangupLegs', 1, { keepCaller });
    if (opts.announce) await this.submitJob(callId, 'announceAndHangup', 1, { text: opts.announce });
    return res.changed;
  }

  // ---------------------------------------------------------------- Jobs

  async submitJob(callId: string, op: JobOp, generation: number, params: Record<string, unknown>): Promise<void> {
    const suffix = op === 'createMonitor' ? `-${String(params.role)}` : '';
    const jobId = `${callId}-${op}${suffix}-g${generation}`;
    const now = nowIso();
    const job: JobDoc = {
      jobId,
      callId,
      op,
      generation,
      params,
      status: 'pending',
      attempts: 0,
      lastError: null,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: addMs(now, 3 * 24 * 3600_000),
    };
    const { created, job: existing } = await this.store.createJob(job);
    if (!created && existing.status !== 'pending') return;
    // 作成後・投入前に落ちた場合は、照合処理が pending のジョブを再投入する
    await this.queue.enqueue(jobId);
    // 投入直後にキューが実行を始めている場合があるため、pending のときだけ enqueued にする
    await this.store.updateJobIf(jobId, (j) => j.status === 'pending', { status: 'enqueued' });
  }

  /** ジョブ実行。'retry' を返すとキューが再試行する */
  async runJob(jobId: string): Promise<'done' | 'retry'> {
    const job = await this.store.claimJob(jobId, 60_000);
    if (!job) return 'done';
    try {
      switch (job.op) {
        case 'dialSip':
          await this.jobDialSip(job);
          break;
        case 'createMonitor':
          await this.jobCreateMonitor(job);
          break;
        case 'hangupLegs':
          await this.jobHangupLegs(job);
          break;
        case 'announceAndHangup':
          await this.jobAnnounce(job);
          break;
      }
      await this.store.updateJob(jobId, { status: 'done', lockedUntil: null });
      return 'done';
    } catch (err) {
      const final = job.attempts >= 5;
      this.log.error('job failed', { jobId, op: job.op, attempt: job.attempts, final, ...errInfo(err) });
      await this.store.updateJob(jobId, {
        status: final ? 'failed' : 'pending',
        lastError: (err as Error).message?.slice(0, 200) ?? 'error',
        lockedUntil: null,
      });
      return final ? 'done' : 'retry';
    }
  }

  private async jobDialSip(job: JobDoc) {
    const call = await this.store.getCall(job.callId);
    if (!call || call.callStatus !== 'dialing') return;
    const existing = await this.store.getLeg(call.callId, 'sip');
    // 生成済み・生成有無不明のレッグがあれば再発信しない（同じ SIP 呼の二重発信を防ぐ）
    if (existing && existing.status !== 'failed') return;
    // 着信時点で固定した接続先（設定画面 → 環境変数の順）
    const targetUri = call.sipTargetUri || this.cfg.sip.targetUri;
    if (!targetUri) throw new Error('SIP target URI is not configured');
    const now = nowIso();
    await this.store.putLeg({
      legId: 'sip',
      callId: call.callId,
      role: 'sip',
      generation: 1,
      vonageUuid: null,
      status: 'creating',
      createdAt: now,
      connectedAt: null,
      endedAt: null,
      updatedAt: now,
    });
    const fromNumber =
      this.cfg.sip.fromMode === 'caller' && call.callerNumber ? call.callerNumber : this.cfg.vonage.number;
    let created: { uuid: string };
    try {
      created = await this.vonage.createCall({
        to: [{ type: 'sip', uri: targetUri, headers: { ...this.cfg.sip.headers, 'CallWeave-CallId': call.callId } }],
        from: { type: 'phone', number: fromNumber },
        ncco: sipLegNcco(call.conversationName, call.inboundUuid),
        event_url: [this.url('/webhooks/vonage/events', { callId: call.callId, leg: 'sip' })],
        event_method: 'POST',
        ringing_timer: this.cfg.sip.ringingTimeoutSec,
      });
    } catch (err) {
      if (err instanceof VonageAmbiguousError) {
        // 失敗と即断しない。生成済みならイベントが届き、届かなければ照合処理が判断する
        await this.store.mutateLeg(call.callId, 'sip', (l) => (l.vonageUuid ? null : { ...l, status: 'unknown' }));
        this.log.warn('sip dial outcome unknown', { callId: call.callId });
        return;
      }
      await this.store.mutateLeg(call.callId, 'sip', (l) => ({ ...l, status: 'failed', endedAt: nowIso() }));
      this.log.error('sip dial rejected', { callId: call.callId, status: (err as VonageApiError).status });
      await this.endCall(call.callId, 'sip_failed', nowIso(), 'failed', { announce: DIAL_FAILED });
      return;
    }
    // 発信は成功している。ここでの失敗は保存の失敗であり、発信拒否として扱わない
    await this.attachUuid(call.callId, 'sip', created.uuid);
  }

  /**
   * 生成済みレッグの UUID を保存する。保存できなければ追跡できないレッグを残さないよう切断する。
   * 保存後に通話が既に終わっていた場合（API 応答前の切断など）も、その場で切断する。
   */
  private async attachUuid(callId: string, legId: string, uuid: string) {
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await this.store.mutateLeg(callId, legId, (l) => ({
          ...l,
          vonageUuid: uuid,
          status: l.status === 'creating' || l.status === 'unknown' ? 'started' : l.status,
        }));
        await this.store.indexLeg(uuid, callId, legId, addMs(nowIso(), (this.cfg.retentionDays + 2) * 24 * 3600_000));
        const call = await this.store.getCall(callId);
        if (call && TERMINAL_CALL_STATUSES.includes(call.callStatus)) {
          this.log.warn('leg created after call ended; hanging up', { callId, leg: legId });
          await this.vonage.hangup(uuid);
        }
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300 * 2 ** i));
      }
    }
    this.log.error('failed to persist leg uuid; hanging up', { callId, leg: legId, ...errInfo(lastErr) });
    await this.vonage.hangup(uuid).catch(() => undefined);
    throw lastErr;
  }

  private async jobCreateMonitor(job: JobDoc) {
    const role = job.params.role as Role;
    const gen = job.generation;
    const call = await this.store.getCall(job.callId);
    if (!call || call.callStatus !== 'active' || call.limitReached) return;
    if (call.roles[role].wsGeneration !== gen) return; // 新しい世代に置き換え済み
    const legRole: LegRole = role === 'caller' ? 'caller_ws' : 'operator_ws';
    const legId = `${legRole}-g${gen}`;
    if (await this.store.getLeg(call.callId, legId)) return;

    const targetUuid = role === 'caller' ? call.inboundUuid : (await this.store.getLeg(call.callId, 'sip'))?.vonageUuid;
    if (!targetUuid) throw new Error('target leg uuid is not known yet');

    const now = nowIso();
    await this.store.putLeg({
      legId,
      callId: call.callId,
      role: legRole,
      generation: gen,
      vonageUuid: null,
      status: 'creating',
      createdAt: now,
      connectedAt: null,
      endedAt: null,
      updatedAt: now,
    });
    const token = await signMediaToken(this.cfg.mediaTokenSecret, { callId: call.callId, role, gen }, this.cfg.mediaTokenTtlSec);
    let created: { uuid: string };
    try {
      created = await this.vonage.createCall({
        to: [
          {
            type: 'websocket',
            uri: this.cfg.mediaWsUrl,
            'content-type': 'audio/l16;rate=16000',
            // headers は WS 確立後の最初の JSON メタデータ。認証には使わない
            headers: { callId: call.callId, role, gen },
            authorization: { type: 'custom', value: `Bearer ${token}` },
          },
        ],
        from: { type: 'phone', number: this.cfg.vonage.number || 'CallWeave' },
        ncco: monitorLegNcco(call.conversationName, targetUuid),
        event_url: [this.url('/webhooks/vonage/events', { callId: call.callId, leg: legRole, gen })],
        event_method: 'POST',
      });
    } catch (err) {
      if (err instanceof VonageAmbiguousError) {
        // 世代付きトークンのため、照合処理が新世代で作り直しても旧レッグは音声中継に拒否される
        await this.store.mutateLeg(call.callId, legId, (l) => (l.vonageUuid ? null : { ...l, status: 'unknown' }));
        return;
      }
      await this.store.mutateLeg(call.callId, legId, (l) => ({ ...l, status: 'failed', endedAt: nowIso() }));
      await this.store.mutateCall(call.callId, (c) => {
        if (c.roles[role].wsGeneration !== gen) return null;
        c.roles[role] = { ...c.roles[role], asrStatus: 'failed', errorCode: 'monitor_create_failed' };
        c.transcriptionStatus = deriveTranscriptionStatus(c);
        return c;
      });
      return;
    }
    await this.attachUuid(call.callId, legId, created.uuid);
  }

  private async jobHangupLegs(job: JobDoc) {
    const legs = await this.store.listLegs(job.callId);
    for (const leg of legs) {
      if (!leg.vonageUuid || LEG_TERMINAL.includes(leg.status)) continue;
      if (leg.role === 'caller' && job.params.keepCaller) continue;
      await this.vonage.hangup(leg.vonageUuid);
    }
  }

  private async jobAnnounce(job: JobDoc) {
    const call = await this.store.getCall(job.callId);
    if (!call) return;
    const caller = await this.store.getLeg(call.callId, 'caller');
    if (!caller || LEG_TERMINAL.includes(caller.status)) return;
    await this.vonage.transferNcco(call.inboundUuid, talkAndEndNcco(String(job.params.text ?? DIAL_FAILED)));
  }
}

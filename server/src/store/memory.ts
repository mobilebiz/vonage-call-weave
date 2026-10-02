// ローカル開発・テスト用のメモリストア。単一プロセス（CW_SERVICE=all）でのみ使う。
import { EventEmitter } from 'node:events';
import { EMPTY_SETTINGS, type SettingsDoc } from '../shared/types.js';
import type { CallDoc, GapDoc, JobDoc, LegDoc, LiveDoc, Role, SegmentDoc, WebhookEventDoc } from '../shared/types.js';
import { nowIso } from '../shared/time.js';
import { newCallId } from '../shared/ids.js';
import { compareSegments } from '../shared/ordering.js';
import {
  type CallFilter,
  type CallStreamEvent,
  type Page,
  type Store,
  type Unsubscribe,
  type WebhookBegin,
  decodeCursor,
  encodeCursor,
  isOpenCall,
  matchesFilter,
} from './store.js';

const clone = <T>(v: T): T => structuredClone(v);

interface CallBucket {
  call: CallDoc;
  legs: Map<string, LegDoc>;
  segments: Map<string, SegmentDoc>;
  live: Map<Role, LiveDoc>;
  gaps: Map<string, GapDoc>;
}

export class MemoryStore implements Store {
  private calls = new Map<string, CallBucket>();
  private inbound = new Map<string, string>();
  private legIndex = new Map<string, { callId: string; legId: string; expiresAt: string }>();
  private webhookEvents = new Map<string, WebhookEventDoc>();
  private jobs = new Map<string, JobDoc>();
  private bus = new EventEmitter().setMaxListeners(0);
  private settings: SettingsDoc = { ...EMPTY_SETTINGS };

  private bucket(callId: string): CallBucket | undefined {
    return this.calls.get(callId);
  }

  private emitCall(call: CallDoc) {
    this.bus.emit('calls', clone(call));
    this.bus.emit(`call:${call.callId}`, { kind: 'call', call: clone(call) } satisfies CallStreamEvent);
  }

  async createCallForInbound(inboundUuid: string, build: (callId: string) => CallDoc) {
    const existing = this.inbound.get(inboundUuid);
    if (existing) {
      const b = this.bucket(existing);
      if (b) return { call: clone(b.call), created: false };
    }
    const call = build(newCallId());
    this.calls.set(call.callId, { call: clone(call), legs: new Map(), segments: new Map(), live: new Map(), gaps: new Map() });
    this.inbound.set(inboundUuid, call.callId);
    this.legIndex.set(inboundUuid, { callId: call.callId, legId: 'caller', expiresAt: call.expiresAt });
    this.emitCall(call);
    return { call: clone(call), created: true };
  }

  async getCall(callId: string) {
    const b = this.bucket(callId);
    return b ? clone(b.call) : null;
  }

  async mutateCall(callId: string, fn: (call: CallDoc) => CallDoc | null) {
    const b = this.bucket(callId);
    if (!b) return null;
    const next = fn(clone(b.call));
    if (!next) return { call: clone(b.call), changed: false };
    next.revision = b.call.revision + 1;
    next.updatedAt = nowIso();
    b.call = clone(next);
    this.emitCall(next);
    return { call: clone(next), changed: true };
  }

  async listCalls(filter: CallFilter, limit: number, cursor: string | null): Promise<Page<CallDoc>> {
    const now = nowIso();
    const after = decodeCursor(cursor);
    const all = [...this.calls.values()]
      .map((b) => b.call)
      .filter((c) => c.expiresAt > now && matchesFilter(c, filter))
      .sort((a, b) => (a.receivedAt === b.receivedAt ? (a.callId < b.callId ? 1 : -1) : a.receivedAt < b.receivedAt ? 1 : -1));
    const start = after
      ? all.findIndex((c) => c.receivedAt < String(after[0]) || (c.receivedAt === after[0] && c.callId < String(after[1])))
      : 0;
    const items = start < 0 ? [] : all.slice(start, start + limit);
    const last = items.at(-1);
    const nextCursor = items.length === limit && last ? encodeCursor([last.receivedAt, last.callId]) : null;
    return { items: items.map(clone), nextCursor };
  }

  async listOpenCalls(limit: number) {
    return [...this.calls.values()].map((b) => b.call).filter(isOpenCall).slice(0, limit).map(clone);
  }

  async listExpiredCallIds(now: string, limit: number) {
    return [...this.calls.values()].filter((b) => b.call.expiresAt <= now).slice(0, limit).map((b) => b.call.callId);
  }

  async deleteCallCascade(callId: string) {
    const b = this.bucket(callId);
    if (!b) return;
    this.calls.delete(callId);
    this.inbound.delete(b.call.inboundUuid);
    for (const [uuid, v] of this.legIndex) if (v.callId === callId) this.legIndex.delete(uuid);
  }

  async putLeg(leg: LegDoc) {
    this.bucket(leg.callId)?.legs.set(leg.legId, clone(leg));
  }
  async getLeg(callId: string, legId: string) {
    const l = this.bucket(callId)?.legs.get(legId);
    return l ? clone(l) : null;
  }
  async mutateLeg(callId: string, legId: string, fn: (leg: LegDoc) => LegDoc | null) {
    const b = this.bucket(callId);
    const cur = b?.legs.get(legId);
    if (!b || !cur) return null;
    const next = fn(clone(cur));
    if (!next) return clone(cur);
    next.updatedAt = nowIso();
    b.legs.set(legId, clone(next));
    return clone(next);
  }
  async listLegs(callId: string) {
    return [...(this.bucket(callId)?.legs.values() ?? [])].map(clone);
  }
  async indexLeg(vonageUuid: string, callId: string, legId: string, expiresAt: string) {
    this.legIndex.set(vonageUuid, { callId, legId, expiresAt });
  }
  async findLegByUuid(vonageUuid: string) {
    const v = this.legIndex.get(vonageUuid);
    return v ? { callId: v.callId, legId: v.legId } : null;
  }

  async upsertSegment(seg: SegmentDoc) {
    const b = this.bucket(seg.callId);
    if (!b) return false;
    const cur = b.segments.get(seg.segmentId);
    if (cur && cur.revision >= seg.revision) return false;
    b.segments.set(seg.segmentId, clone(seg));
    this.bus.emit(`call:${seg.callId}`, { kind: 'segment', segment: clone(seg) } satisfies CallStreamEvent);
    return true;
  }

  async listSegments(callId: string, limit: number, cursor: string | null): Promise<Page<SegmentDoc>> {
    const all = [...(this.bucket(callId)?.segments.values() ?? [])].sort(compareSegments);
    const after = decodeCursor(cursor);
    const start = after
      ? all.findIndex((s) => s.startMs > Number(after[0]) || (s.startMs === Number(after[0]) && s.segmentId > String(after[1])))
      : 0;
    const items = start < 0 ? [] : all.slice(start, start + limit);
    const last = items.at(-1);
    return {
      items: items.map(clone),
      nextCursor: items.length === limit && last ? encodeCursor([last.startMs, last.segmentId]) : null,
    };
  }

  async setLive(callId: string, role: Role, live: LiveDoc | null) {
    const b = this.bucket(callId);
    if (!b) return;
    if (live) b.live.set(role, clone(live));
    else b.live.delete(role);
    this.bus.emit(`call:${callId}`, { kind: 'live', role, live: live ? clone(live) : null } satisfies CallStreamEvent);
  }
  async listLive(callId: string) {
    return [...(this.bucket(callId)?.live.values() ?? [])].map(clone);
  }

  async putGap(gap: GapDoc) {
    const b = this.bucket(gap.callId);
    if (!b) return;
    b.gaps.set(gap.gapId, clone(gap));
    this.bus.emit(`call:${gap.callId}`, { kind: 'gap', gap: clone(gap) } satisfies CallStreamEvent);
  }
  async listGaps(callId: string) {
    return [...(this.bucket(callId)?.gaps.values() ?? [])].sort((a, b) => a.startMs - b.startMs).map(clone);
  }

  async beginWebhookEvent(eventKey: string, expiresAt: string, leaseMs: number): Promise<WebhookBegin> {
    const cur = this.webhookEvents.get(eventKey);
    const now = nowIso();
    if (cur?.status === 'done') return { state: 'done', result: clone(cur.result) };
    if (cur && cur.leaseUntil > now) return { state: 'processing' };
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    this.webhookEvents.set(eventKey, { eventKey, status: 'processing', result: null, receivedAt: now, expiresAt, leaseUntil });
    return { state: 'new' };
  }
  async completeWebhookEvent(eventKey: string, result: unknown) {
    const cur = this.webhookEvents.get(eventKey);
    if (cur) this.webhookEvents.set(eventKey, { ...cur, status: 'done', result: clone(result) });
  }
  async abandonWebhookEvent(eventKey: string) {
    this.webhookEvents.delete(eventKey);
  }

  async createJob(job: JobDoc) {
    const cur = this.jobs.get(job.jobId);
    if (cur) return { job: clone(cur), created: false };
    this.jobs.set(job.jobId, clone(job));
    return { job: clone(job), created: true };
  }
  async claimJob(jobId: string, lockMs: number) {
    const cur = this.jobs.get(jobId);
    if (!cur || cur.status === 'done' || cur.status === 'failed') return null;
    const now = nowIso();
    if (cur.status === 'running' && cur.lockedUntil && cur.lockedUntil > now) return null;
    const next: JobDoc = {
      ...cur,
      status: 'running',
      attempts: cur.attempts + 1,
      lockedUntil: new Date(Date.now() + lockMs).toISOString(),
      updatedAt: now,
    };
    this.jobs.set(jobId, next);
    return clone(next);
  }
  async updateJob(jobId: string, patch: Partial<JobDoc>) {
    const cur = this.jobs.get(jobId);
    if (cur) this.jobs.set(jobId, { ...cur, ...clone(patch), updatedAt: nowIso() });
  }
  async updateJobIf(jobId: string, pred: (job: JobDoc) => boolean, patch: Partial<JobDoc>) {
    const cur = this.jobs.get(jobId);
    if (!cur || !pred(clone(cur))) return false;
    this.jobs.set(jobId, { ...cur, ...clone(patch), updatedAt: nowIso() });
    return true;
  }
  async listStaleJobs(olderThanIso: string, limit: number) {
    return [...this.jobs.values()]
      .filter((j) => (j.status === 'pending' || j.status === 'enqueued' || j.status === 'running') && j.updatedAt < olderThanIso)
      .slice(0, limit)
      .map(clone);
  }

  async deleteExpiredAux(now: string, limit: number) {
    let n = 0;
    for (const [k, v] of this.webhookEvents) if (v.expiresAt <= now && n < limit) (this.webhookEvents.delete(k), n++);
    for (const [k, v] of this.jobs) if (v.expiresAt <= now && n < limit) (this.jobs.delete(k), n++);
    for (const [k, v] of this.legIndex) if (v.expiresAt <= now && n < limit) (this.legIndex.delete(k), n++);
    return n;
  }

  async getSettings() {
    return clone(this.settings);
  }
  async updateSettings(patch: Pick<SettingsDoc, 'sipTargetUri'>, expectedRevision: number) {
    if (this.settings.revision !== expectedRevision) return null;
    this.settings = { ...this.settings, ...patch, revision: this.settings.revision + 1, updatedAt: nowIso() };
    return clone(this.settings);
  }

  watchCalls(cb: (call: CallDoc) => void): Unsubscribe {
    this.bus.on('calls', cb);
    return () => this.bus.off('calls', cb);
  }
  watchCall(callId: string, cb: (ev: CallStreamEvent) => void): Unsubscribe {
    const ch = `call:${callId}`;
    this.bus.on(ch, cb);
    return () => this.bus.off(ch, cb);
  }
  watchCallDoc(callId: string, cb: (call: CallDoc) => void): Unsubscribe {
    return this.watchCall(callId, (ev) => {
      if (ev.kind === 'call') cb(ev.call);
    });
  }
  async close() {
    this.bus.removeAllListeners();
  }
}

// Firestore (Native mode) 実装。projectId は必ず設定値から明示的に渡す。
// GOOGLE_CLOUD_PROJECT や gcloud の既定プロジェクトには依存しない。
import { Firestore, FieldPath, type DocumentReference, type Query } from '@google-cloud/firestore';
import { EMPTY_SETTINGS, type SettingsDoc } from '../shared/types.js';
import type { CallDoc, GapDoc, JobDoc, LegDoc, LiveDoc, Role, SegmentDoc, WebhookEventDoc } from '../shared/types.js';
import { nowIso } from '../shared/time.js';
import { newCallId } from '../shared/ids.js';
import {
  type CallFilter,
  type CallStreamEvent,
  type Page,
  type Store,
  type Unsubscribe,
  type WebhookBegin,
  decodeCursor,
  encodeCursor,
} from './store.js';

const ACTIVE_STATUSES = ['ivr', 'dialing', 'active'];
const ENDED_STATUSES = ['ended', 'failed', 'abandoned'];
const OPEN_TRANSCRIPTION = ['starting', 'streaming', 'degraded', 'finalizing'];

export class FirestoreStore implements Store {
  readonly db: Firestore;

  constructor(projectId: string, databaseId: string) {
    this.db = new Firestore({ projectId, databaseId, ignoreUndefinedProperties: true });
  }

  private callRef(callId: string) {
    return this.db.collection('calls').doc(callId) as DocumentReference<CallDoc>;
  }
  private legRef(callId: string, legId: string) {
    return this.callRef(callId).collection('legs').doc(legId) as DocumentReference<LegDoc>;
  }

  async createCallForInbound(inboundUuid: string, build: (callId: string) => CallDoc) {
    const idxRef = this.db.collection('legIndex').doc(inboundUuid);
    return this.db.runTransaction(async (tx) => {
      const idx = await tx.get(idxRef);
      if (idx.exists) {
        const callId = idx.get('callId') as string;
        const snap = await tx.get(this.callRef(callId));
        if (snap.exists) return { call: snap.data() as CallDoc, created: false };
      }
      const call = build(newCallId());
      tx.create(this.callRef(call.callId), call);
      tx.set(idxRef, { callId: call.callId, legId: 'caller', expiresAt: call.expiresAt });
      return { call, created: true };
    });
  }

  async getCall(callId: string) {
    const snap = await this.callRef(callId).get();
    return snap.exists ? (snap.data() as CallDoc) : null;
  }

  async mutateCall(callId: string, fn: (call: CallDoc) => CallDoc | null) {
    const ref = this.callRef(callId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const cur = snap.data() as CallDoc;
      const next = fn(structuredClone(cur));
      if (!next) return { call: cur, changed: false };
      next.revision = cur.revision + 1;
      next.updatedAt = nowIso();
      tx.set(ref, next);
      return { call: next, changed: true };
    });
  }

  async listCalls(filter: CallFilter, limit: number, cursor: string | null): Promise<Page<CallDoc>> {
    let q: Query = this.db.collection('calls');
    if (filter === 'active') q = q.where('callStatus', 'in', ACTIVE_STATUSES);
    if (filter === 'ended') q = q.where('callStatus', 'in', ENDED_STATUSES);
    q = q.orderBy('receivedAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    const after = decodeCursor(cursor);
    if (after) q = q.startAfter(String(after[0]), String(after[1]));
    const now = nowIso();
    const snap = await q.limit(limit).get();
    const docs = snap.docs.map((d) => d.data() as CallDoc);
    const last = docs.at(-1);
    return {
      items: docs.filter((c) => c.expiresAt > now),
      nextCursor: docs.length === limit && last ? encodeCursor([last.receivedAt, last.callId]) : null,
    };
  }

  async listOpenCalls(limit: number) {
    const [a, b, c] = await Promise.all([
      this.db.collection('calls').where('callStatus', 'in', ACTIVE_STATUSES).limit(limit).get(),
      this.db.collection('calls').where('transcriptionStatus', 'in', OPEN_TRANSCRIPTION).limit(limit).get(),
      // 文字起こしが確定しても、残存レッグの回収が終わるまでは照合対象にする
      this.db.collection('calls').where('legsSettled', '==', false).limit(limit).get(),
    ]);
    const byId = new Map<string, CallDoc>();
    for (const d of [...a.docs, ...b.docs, ...c.docs]) byId.set(d.id, d.data() as CallDoc);
    return [...byId.values()];
  }

  async listExpiredCallIds(now: string, limit: number) {
    const snap = await this.db.collection('calls').where('expiresAt', '<=', now).limit(limit).select().get();
    return snap.docs.map((d) => d.id);
  }

  async deleteCallCascade(callId: string) {
    const idx = await this.db.collection('legIndex').where('callId', '==', callId).get();
    const batch = this.db.batch();
    for (const d of idx.docs) batch.delete(d.ref);
    await batch.commit();
    // サブコレクション（legs / segments / live / gaps）を含めて削除。TTL だけに頼らない
    await this.db.recursiveDelete(this.callRef(callId));
  }

  async putLeg(leg: LegDoc) {
    await this.legRef(leg.callId, leg.legId).set(leg);
  }
  async getLeg(callId: string, legId: string) {
    const s = await this.legRef(callId, legId).get();
    return s.exists ? (s.data() as LegDoc) : null;
  }
  async mutateLeg(callId: string, legId: string, fn: (leg: LegDoc) => LegDoc | null) {
    const ref = this.legRef(callId, legId);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const cur = s.data() as LegDoc;
      const next = fn(structuredClone(cur));
      if (!next) return cur;
      next.updatedAt = nowIso();
      tx.set(ref, next);
      return next;
    });
  }
  async listLegs(callId: string) {
    const s = await this.callRef(callId).collection('legs').get();
    return s.docs.map((d) => d.data() as LegDoc);
  }
  async indexLeg(vonageUuid: string, callId: string, legId: string, expiresAt: string) {
    await this.db.collection('legIndex').doc(vonageUuid).set({ callId, legId, expiresAt });
  }
  async findLegByUuid(vonageUuid: string) {
    const s = await this.db.collection('legIndex').doc(vonageUuid).get();
    return s.exists ? { callId: s.get('callId') as string, legId: s.get('legId') as string } : null;
  }

  async upsertSegment(seg: SegmentDoc) {
    const ref = this.callRef(seg.callId).collection('segments').doc(seg.segmentId);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists && (s.get('revision') as number) >= seg.revision) return false;
      tx.set(ref, seg);
      return true;
    });
  }

  async listSegments(callId: string, limit: number, cursor: string | null): Promise<Page<SegmentDoc>> {
    // segmentId は role 名で始まるため、startMs → segmentId の順で role の固定順も満たす
    let q: Query = this.callRef(callId).collection('segments').orderBy('startMs').orderBy('segmentId');
    const after = decodeCursor(cursor);
    if (after) q = q.startAfter(Number(after[0]), String(after[1]));
    const snap = await q.limit(limit).get();
    const items = snap.docs.map((d) => d.data() as SegmentDoc);
    const last = items.at(-1);
    return { items, nextCursor: items.length === limit && last ? encodeCursor([last.startMs, last.segmentId]) : null };
  }

  async setLive(callId: string, role: Role, live: LiveDoc | null) {
    const ref = this.callRef(callId).collection('live').doc(role);
    if (live) await ref.set(live);
    else await ref.delete();
  }
  async listLive(callId: string) {
    const s = await this.callRef(callId).collection('live').get();
    return s.docs.map((d) => d.data() as LiveDoc);
  }

  async putGap(gap: GapDoc) {
    await this.callRef(gap.callId).collection('gaps').doc(gap.gapId).set(gap);
  }
  async listGaps(callId: string) {
    const s = await this.callRef(callId).collection('gaps').orderBy('startMs').get();
    return s.docs.map((d) => d.data() as GapDoc);
  }

  async beginWebhookEvent(eventKey: string, expiresAt: string, leaseMs: number): Promise<WebhookBegin> {
    const ref = this.db.collection('webhookEvents').doc(eventKey);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const now = nowIso();
      if (s.exists) {
        const d = s.data() as WebhookEventDoc;
        if (d.status === 'done') return { state: 'done' as const, result: d.result };
        if ((d.leaseUntil ?? '') > now) return { state: 'processing' as const };
      }
      const doc: WebhookEventDoc = {
        eventKey,
        status: 'processing',
        result: null,
        receivedAt: now,
        expiresAt,
        leaseUntil: new Date(Date.now() + leaseMs).toISOString(),
      };
      tx.set(ref, doc);
      return { state: 'new' as const };
    });
  }
  async completeWebhookEvent(eventKey: string, result: unknown) {
    await this.db.collection('webhookEvents').doc(eventKey).update({ status: 'done', result: result ?? null });
  }
  async abandonWebhookEvent(eventKey: string) {
    await this.db.collection('webhookEvents').doc(eventKey).delete();
  }

  async createJob(job: JobDoc) {
    const ref = this.db.collection('controlJobs').doc(job.jobId);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists) return { job: s.data() as JobDoc, created: false };
      tx.create(ref, job);
      return { job, created: true };
    });
  }
  async claimJob(jobId: string, lockMs: number) {
    const ref = this.db.collection('controlJobs').doc(jobId);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const cur = s.data() as JobDoc;
      if (cur.status === 'done' || cur.status === 'failed') return null;
      const now = nowIso();
      if (cur.status === 'running' && cur.lockedUntil && cur.lockedUntil > now) return null;
      const next: JobDoc = {
        ...cur,
        status: 'running',
        attempts: cur.attempts + 1,
        lockedUntil: new Date(Date.now() + lockMs).toISOString(),
        updatedAt: now,
      };
      tx.set(ref, next);
      return next;
    });
  }
  async updateJob(jobId: string, patch: Partial<JobDoc>) {
    await this.db.collection('controlJobs').doc(jobId).update({ ...patch, updatedAt: nowIso() });
  }
  async updateJobIf(jobId: string, pred: (job: JobDoc) => boolean, patch: Partial<JobDoc>) {
    const ref = this.db.collection('controlJobs').doc(jobId);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || !pred(s.data() as JobDoc)) return false;
      tx.update(ref, { ...patch, updatedAt: nowIso() });
      return true;
    });
  }
  async listStaleJobs(olderThanIso: string, limit: number) {
    const s = await this.db
      .collection('controlJobs')
      .where('status', 'in', ['pending', 'enqueued', 'running'])
      .where('updatedAt', '<', olderThanIso)
      .limit(limit)
      .get();
    return s.docs.map((d) => d.data() as JobDoc);
  }

  async deleteExpiredAux(now: string, limit: number) {
    let n = 0;
    for (const col of ['webhookEvents', 'controlJobs', 'legIndex']) {
      const s = await this.db.collection(col).where('expiresAt', '<=', now).limit(limit).get();
      if (s.empty) continue;
      const batch = this.db.batch();
      s.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      n += s.size;
    }
    return n;
  }

  async getSettings(): Promise<SettingsDoc> {
    const snap = await this.db.collection('settings').doc('app').get();
    return snap.exists ? { ...EMPTY_SETTINGS, ...(snap.data() as Partial<SettingsDoc>) } : { ...EMPTY_SETTINGS };
  }

  async updateSettings(patch: Pick<SettingsDoc, 'sipTargetUri'>, expectedRevision: number) {
    const ref = this.db.collection('settings').doc('app');
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur: SettingsDoc = snap.exists ? { ...EMPTY_SETTINGS, ...(snap.data() as Partial<SettingsDoc>) } : { ...EMPTY_SETTINGS };
      if (cur.revision !== expectedRevision) return null;
      const next: SettingsDoc = { ...cur, ...patch, revision: cur.revision + 1, updatedAt: nowIso() };
      tx.set(ref, next);
      // 変更履歴（誰が変えたかは Basic 認証の単一ユーザーのため記録できない）
      tx.create(ref.collection('history').doc(String(next.revision)), { ...next, previous: cur.sipTargetUri });
      return next;
    });
  }

  watchCalls(cb: (call: CallDoc) => void): Unsubscribe {
    const since = nowIso();
    return this.db
      .collection('calls')
      .where('updatedAt', '>', since)
      .onSnapshot(
        (snap) => {
          for (const ch of snap.docChanges()) if (ch.type !== 'removed') cb(ch.doc.data() as CallDoc);
        },
        (err) => console.error(JSON.stringify({ severity: 'ERROR', msg: 'watchCalls error', code: (err as { code?: unknown }).code })),
      );
  }

  watchCall(callId: string, cb: (ev: CallStreamEvent) => void): Unsubscribe {
    const since = nowIso();
    const ref = this.callRef(callId);
    const unsubs: Unsubscribe[] = [];
    const onErr = (err: Error) =>
      console.error(JSON.stringify({ severity: 'ERROR', msg: 'watchCall error', callId, code: (err as { code?: unknown }).code }));

    let firstCall = true;
    unsubs.push(
      ref.onSnapshot((s) => {
        if (firstCall) return void (firstCall = false);
        if (s.exists) cb({ kind: 'call', call: s.data() as CallDoc });
      }, onErr),
    );
    unsubs.push(
      ref
        .collection('segments')
        .where('updatedAt', '>', since)
        .onSnapshot((snap) => {
          for (const ch of snap.docChanges()) if (ch.type !== 'removed') cb({ kind: 'segment', segment: ch.doc.data() as SegmentDoc });
        }, onErr),
    );
    let firstLive = true;
    unsubs.push(
      ref.collection('live').onSnapshot((snap) => {
        if (firstLive) return void (firstLive = false);
        for (const ch of snap.docChanges()) {
          const role = ch.doc.id as Role;
          cb({ kind: 'live', role, live: ch.type === 'removed' ? null : (ch.doc.data() as LiveDoc) });
        }
      }, onErr),
    );
    let firstGap = true;
    unsubs.push(
      ref.collection('gaps').onSnapshot((snap) => {
        if (firstGap) return void (firstGap = false);
        for (const ch of snap.docChanges()) if (ch.type !== 'removed') cb({ kind: 'gap', gap: ch.doc.data() as GapDoc });
      }, onErr),
    );
    return () => unsubs.forEach((u) => u());
  }

  watchCallDoc(callId: string, cb: (call: CallDoc) => void): Unsubscribe {
    let first = true;
    return this.callRef(callId).onSnapshot(
      (s) => {
        if (first) return void (first = false);
        if (s.exists) cb(s.data() as CallDoc);
      },
      (err) => console.error(JSON.stringify({ severity: 'ERROR', msg: 'watchCallDoc error', callId, code: (err as { code?: unknown }).code })),
    );
  }

  async close() {
    await this.db.terminate();
  }
}

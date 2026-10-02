// 定期照合（Cloud Scheduler から 1 分ごと）と保存期限切れデータの削除。
import { errInfo } from '../log.js';
import type { CallFlow } from './callFlow.js';
import { LEG_TERMINAL } from './callFlow.js';
import {
  ROLES,
  TERMINAL_CALL_STATUSES,
  deriveTranscriptionStatus,
  type CallDoc,
  type GapDoc,
  type LegDoc,
} from '../shared/types.js';
import { addMs, nowIso } from '../shared/time.js';

const LEG_UNKNOWN_AFTER_MS = 60_000;
/** dialing のまま SIP レッグが無い（発信ジョブの作成失敗など）と判断するまで */
const DIAL_STUCK_AFTER_MS = 20_000;
/** 終話後、UUID 不明のレッグを回収済みとみなすまで（SIP 呼出タイムアウト + Webhook 遅延を十分に超える） */
const ORPHAN_UNKNOWN_SETTLE_MS = 10 * 60_000;
const MONITOR_CONNECT_TIMEOUT_MS = 45_000;

export interface ReconcileReport {
  checked: number;
  endedByReconcile: number;
  finalizeTimeouts: number;
  monitorsRecreated: number;
  orphanHangups: number;
  jobsRequeued: number;
}

export class Maintenance {
  constructor(private readonly flow: CallFlow) {}

  private get store() {
    return this.flow.store;
  }
  private get log() {
    return this.flow.log;
  }

  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      checked: 0,
      endedByReconcile: 0,
      finalizeTimeouts: 0,
      monitorsRecreated: 0,
      orphanHangups: 0,
      jobsRequeued: 0,
    };
    const calls = await this.store.listOpenCalls(200);
    for (const call of calls) {
      report.checked++;
      try {
        await this.reconcileCall(call, report);
      } catch (err) {
        this.log.error('reconcile call failed', { callId: call.callId, ...errInfo(err) });
      }
    }
    // 作成済みだが投入されていない・止まったジョブを再投入する
    const stale = await this.store.listStaleJobs(addMs(nowIso(), -60_000), 100);
    for (const job of stale) {
      // 取得後に他インスタンスが実行を始めていれば触らない（updatedAt による比較交換）
      const taken = await this.store.updateJobIf(
        job.jobId,
        (j) => j.updatedAt === job.updatedAt && (j.status !== 'running' || !j.lockedUntil || j.lockedUntil <= nowIso()),
        { status: 'pending' },
      );
      if (!taken) continue;
      await this.flow.queue.enqueue(job.jobId, { attempt: job.attempts + 1 });
      await this.store.updateJobIf(job.jobId, (j) => j.status === 'pending', { status: 'enqueued' });
      report.jobsRequeued++;
    }
    return report;
  }

  private async legStatusFromVonage(leg: LegDoc): Promise<string | null> {
    if (!leg.vonageUuid) return null;
    const info = await this.flow.vonage.getCall(leg.vonageUuid);
    return info?.status ?? null;
  }

  private async reconcileCall(call: CallDoc, report: ReconcileReport) {
    const now = Date.now();
    const legs = await this.store.listLegs(call.callId);
    const byId = new Map(legs.map((l) => [l.legId, l]));

    if (!TERMINAL_CALL_STATUSES.includes(call.callStatus)) {
      // 発信ジョブが作られないまま dialing に留まっている → 発信ジョブを（冪等に）保証する
      if (call.callStatus === 'dialing' && !byId.has('sip') && now - Date.parse(call.updatedAt) > DIAL_STUCK_AFTER_MS) {
        await this.flow.submitJob(call.callId, 'dialSip', 1, {});
      }
      // Webhook 欠落: Vonage 側でレッグが終わっているのに通知が届いていない
      for (const legId of ['caller', 'sip']) {
        const leg = byId.get(legId);
        if (!leg) continue;
        if (LEG_TERMINAL.includes(leg.status)) {
          // レッグの終了は記録済みだが呼の終了処理が失敗していた → 呼全体の処理だけ再実行
          if (leg.vonageUuid) {
            await this.flow.applyEvent({ callId: call.callId, leg: leg.role === 'sip' ? 'sip' : undefined }, {
              uuid: leg.vonageUuid,
              status: leg.status,
              timestamp: leg.endedAt ?? nowIso(),
            });
            report.endedByReconcile++;
          }
          continue;
        }
        if (leg.vonageUuid) {
          const status = await this.legStatusFromVonage(leg);
          if (status && LEG_TERMINAL.includes(status)) {
            await this.flow.applyEvent({ callId: call.callId, leg: leg.role === 'sip' ? 'sip' : undefined }, {
              uuid: leg.vonageUuid,
              status,
              timestamp: nowIso(),
            });
            report.endedByReconcile++;
          }
        } else if (now - Date.parse(leg.createdAt) > LEG_UNKNOWN_AFTER_MS) {
          // SIP 発信結果が不明のまま。再発信はせず、失敗として案内・終了する
          await this.store.mutateLeg(call.callId, leg.legId, (l) => ({ ...l, status: 'failed', endedAt: nowIso() }));
          if (leg.role === 'sip') {
            await this.flow.endCall(call.callId, 'sip_failed', nowIso(), 'failed', {
              announce: '申し訳ございません。ただいま担当者におつなぎできません。時間をおいておかけ直しください。',
            });
            report.endedByReconcile++;
          }
        }
      }

      const fresh = await this.store.getCall(call.callId);
      if (fresh?.callStatus === 'active') {
        await this.checkMonitors(fresh, byId, report);
        await this.checkLimit(fresh);
      }
    } else {
      // 終話後の孤児レッグ（監視 WS を含む）を回収する
      let unsettled = 0;
      for (const leg of legs) {
        if (LEG_TERMINAL.includes(leg.status)) continue;
        if (!leg.vonageUuid) {
          // UUID 未確定（作成 API の結果が不明）。遅れて Webhook が届けば applyEvent が切断する。
          // 呼出タイムアウトを十分に超えるまでは回収済みにせず追跡を続ける
          if (now - Date.parse(leg.createdAt) > ORPHAN_UNKNOWN_SETTLE_MS) {
            await this.store.mutateLeg(call.callId, leg.legId, (l) => (l.vonageUuid ? null : { ...l, status: 'failed', endedAt: nowIso() }));
          } else unsettled++;
          continue;
        }
        const status = await this.legStatusFromVonage(leg);
        if (status && LEG_TERMINAL.includes(status)) {
          await this.store.mutateLeg(call.callId, leg.legId, (l) => ({ ...l, status, endedAt: l.endedAt ?? nowIso() }));
          continue;
        }
        unsettled++;
        // 案内を流している発信者レッグは、案内の終了で切れるのを待つ（終話から 2 分で強制切断）
        const announcing = leg.role === 'caller' && !!call.endedAt && now - Date.parse(call.endedAt) < 120_000;
        if (!announcing) {
          await this.flow.vonage.hangup(leg.vonageUuid);
          report.orphanHangups++;
        }
      }
      if (unsettled === 0 && call.legsSettled === false) {
        await this.store.mutateCall(call.callId, (c) => (c.legsSettled === false ? { ...c, legsSettled: true } : null));
      }
      await this.checkFinalizeDeadline(call, report);
    }
  }

  /** 監視 WS が一定時間内に音声中継へ接続しない場合は、新世代で作り直す */
  private async checkMonitors(call: CallDoc, legs: Map<string, LegDoc>, report: ReconcileReport) {
    if (call.limitReached) return;
    for (const role of ROLES) {
      const rs = call.roles[role];
      if (rs.asrStatus !== 'connecting' && rs.asrStatus !== 'reconnecting') continue;
      const leg = legs.get(`${role}_ws-g${rs.wsGeneration}`);
      const since = leg ? Date.parse(leg.createdAt) : Date.parse(call.updatedAt);
      if (now() - since < MONITOR_CONNECT_TIMEOUT_MS) continue;
      if (leg?.status === 'answered') continue; // Vonage 側は接続済み。ASR 側の状態は音声中継が管理する
      let nextGen = 0;
      await this.store.mutateCall(call.callId, (c) => {
        const cur = c.roles[role];
        if (cur.wsGeneration !== rs.wsGeneration || c.callStatus !== 'active') return null;
        if (cur.wsRecreateCount >= this.flow.cfg.maxWsRecreate) {
          c.roles[role] = { ...cur, asrStatus: 'failed', errorCode: 'monitor_connect_timeout' };
        } else {
          nextGen = cur.wsGeneration + 1;
          c.roles[role] = { ...cur, wsGeneration: nextGen, wsRecreateCount: cur.wsRecreateCount + 1, asrStatus: 'reconnecting' };
        }
        c.transcriptionStatus = deriveTranscriptionStatus(c);
        return c;
      });
      if (leg?.vonageUuid) await this.flow.vonage.hangup(leg.vonageUuid).catch(() => undefined);
      if (nextGen) {
        await this.flow.submitJob(call.callId, 'createMonitor', nextGen, { role });
        report.monitorsRecreated++;
      }
    }
  }

  /** 55 分上限の保険。通常は音声中継サービスが上限到達を処理する */
  private async checkLimit(call: CallDoc) {
    if (call.limitReached || !call.recognitionBaseAt) return;
    if (now() - Date.parse(call.recognitionBaseAt) < this.flow.cfg.transcriptionLimitMs + 60_000) return;
    await this.store.mutateCall(call.callId, (c) => (c.limitReached ? null : { ...c, limitReached: true }));
    const legs = await this.store.listLegs(call.callId);
    for (const l of legs) {
      if ((l.role === 'caller_ws' || l.role === 'operator_ws') && l.vonageUuid && !LEG_TERMINAL.includes(l.status)) {
        await this.flow.vonage.hangup(l.vonageUuid);
      }
    }
  }

  /** 最終化が期限内に終わらなかった話者を不完全として確定させる */
  private async checkFinalizeDeadline(call: CallDoc, report: ReconcileReport) {
    if (call.transcriptionStatus !== 'finalizing') return;
    if (call.finalizeDeadlineAt && call.finalizeDeadlineAt > nowIso()) return;
    const timedOut: typeof ROLES[number][] = [];
    await this.store.mutateCall(call.callId, (c) => {
      if (c.transcriptionStatus !== 'finalizing') return null;
      for (const r of ROLES) {
        const rs = c.roles[r];
        if (rs.wsGeneration > 0 && rs.final === null) {
          c.roles[r] = { ...rs, final: 'partial', asrStatus: rs.asrStatus === 'failed' ? 'failed' : 'done' };
          timedOut.push(r);
        }
      }
      c.transcriptionStatus = deriveTranscriptionStatus(c);
      return c;
    });
    for (const role of timedOut) {
      const gap: GapDoc = {
        callId: call.callId,
        gapId: `${role}-finalize-timeout`,
        role,
        startMs: call.endedAt && call.recognitionBaseAt ? Math.max(0, Date.parse(call.endedAt) - Date.parse(call.recognitionBaseAt)) : 0,
        endMs: null,
        reason: 'finalize_timeout',
        createdAt: nowIso(),
      };
      await this.store.putGap(gap);
      // 未確定のまま残った途中結果は、確定扱いせず「未確定」として残す
      const live = (await this.store.listLive(call.callId)).find((l) => l.role === role);
      if (live && !live.unconfirmed) await this.store.setLive(call.callId, role, { ...live, unconfirmed: true, updatedAt: nowIso() });
    }
    if (timedOut.length) report.finalizeTimeouts++;
  }

  /** 保存期限切れ通話をサブコレクションごと削除する（TTL だけに頼らない） */
  async cleanup(): Promise<{ calls: number; aux: number }> {
    const now = nowIso();
    let calls = 0;
    for (;;) {
      const ids = await this.store.listExpiredCallIds(now, 50);
      if (!ids.length) break;
      for (const id of ids) {
        await this.store.deleteCallCascade(id);
        calls++;
      }
      if (ids.length < 50) break;
    }
    const aux = await this.store.deleteExpiredAux(now, 500);
    this.log.info('cleanup done', { calls, aux });
    return { calls, aux };
  }
}

const now = () => Date.now();

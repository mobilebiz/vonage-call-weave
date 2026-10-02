import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  exportUrl,
  fetchAllSegments,
  fetchCall,
  HttpError,
  subscribe,
  type CallView,
  type ConnState,
  type Gap,
  type Live,
  type Role,
  type Segment,
} from './api';
import { CALL_STATUS, END_REASON, GAP_REASON, ROLE_ASR, ROLE_LABEL, TX_STATUS, fmtAt, fmtDateTime, fmtDuration } from './format';

const ROLE_ORDER: Record<Role, number> = { caller: 0, operator: 1 };

type Row =
  | { kind: 'seg'; key: string; role: Role; startMs: number | null; text: string; estimated: boolean; segmentId: string }
  | { kind: 'live'; key: string; role: Role; startMs: number | null; text: string; unconfirmed: boolean; segmentId: string }
  | { kind: 'gap'; key: string; role: Role; startMs: number | null; endMs: number | null; reason: string; segmentId: string };

function compareRows(a: Row, b: Row) {
  const as = a.startMs ?? Number.MAX_SAFE_INTEGER;
  const bs = b.startMs ?? Number.MAX_SAFE_INTEGER;
  if (as !== bs) return as - bs;
  if (a.role !== b.role) return ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
  return a.segmentId < b.segmentId ? -1 : a.segmentId > b.segmentId ? 1 : 0;
}

export function CallDetail(props: { callId: string; summary: CallView | null; onBack: () => void; onCall: (c: CallView) => void }) {
  const { callId, onCall } = props;
  const [call, setCall] = useState<CallView | null>(props.summary);
  const [segs, setSegs] = useState<Map<string, Segment>>(new Map());
  const [live, setLive] = useState<Partial<Record<Role, Live | null>>>({});
  const [gaps, setGaps] = useState<Map<string, Gap>>(new Map());
  const [conn, setConn] = useState<ConnState>('connecting');
  const [error, setError] = useState<string | null>(null);

  const mergeCall = useCallback(
    (c: CallView) => {
      if (c.callId !== callId) return;
      setCall((prev) => (prev && prev.revision > c.revision ? prev : c));
      onCall(c);
    },
    [callId, onCall],
  );

  const mergeSegs = useCallback(
    (items: Segment[]) => {
      setSegs((prev) => {
        let next: Map<string, Segment> | null = null;
        for (const s of items) {
          if (s.callId !== callId) continue; // 遅れて届いた別通話のイベントは拒否
          const cur = (next ?? prev).get(s.segmentId);
          if (cur && cur.revision >= s.revision) continue;
          next ??= new Map(prev);
          next.set(s.segmentId, s);
        }
        return next ?? prev;
      });
    },
    [callId],
  );

  const mergeLive = useCallback(
    (role: Role, l: Live | null) => {
      if (l && l.callId !== callId) return;
      setLive((prev) => {
        const cur = prev[role];
        if (l && cur && cur.segmentId === l.segmentId && cur.revision > l.revision) return prev;
        return { ...prev, [role]: l };
      });
    },
    [callId],
  );

  const mergeGap = useCallback(
    (g: Gap) => {
      if (g.callId !== callId) return;
      setGaps((prev) => new Map(prev).set(g.gapId, g));
    },
    [callId],
  );

  // 選択通話の購読。別通話を選んだら（key 変更で）アンマウントされ購読も解除される
  useEffect(() => {
    const ctrl = new AbortController();
    const snapshot = async () => {
      try {
        const d = await fetchCall(callId, ctrl.signal);
        mergeCall(d.call);
        setLive(Object.fromEntries(d.live.map((l) => [l.role, l])));
        setGaps(new Map(d.gaps.map((g) => [g.gapId, g])));
        await fetchAllSegments(callId, mergeSegs, ctrl.signal);
        setError(null);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof HttpError && e.status === 410) setError('保存期間を過ぎたため閲覧できません。');
        else if (e instanceof HttpError && e.status === 404) setError('通話が見つかりません。');
        else setError(`読み込みに失敗しました: ${(e as Error).message}`);
      }
    };
    const unsub = subscribe(
      `/api/events?scope=call&callId=${encodeURIComponent(callId)}`,
      {
        'call.upsert': (d) => mergeCall(d.call),
        'call.finalized': (d) => mergeCall(d.call),
        'transcript.upsert': (d) => {
          if (d.callId !== callId) return;
          if (d.kind === 'final') {
            mergeSegs([d.segment]);
          } else mergeLive(d.role, d.live);
        },
        gap: (d) => mergeGap(d.gap),
      },
      setConn,
      // 接続・再接続のたびに保存済み発話を再取得する（途中結果は消えても確定結果を正とする）
      () => void snapshot(),
    );
    return () => {
      ctrl.abort();
      unsub();
    };
  }, [callId, mergeCall, mergeSegs, mergeLive, mergeGap]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const s of segs.values()) {
      out.push({ kind: 'seg', key: s.segmentId, role: s.role, startMs: s.startMs, text: s.text, estimated: s.timestampQuality === 'estimated', segmentId: s.segmentId });
    }
    for (const role of ['caller', 'operator'] as Role[]) {
      const l = live[role];
      if (l && l.text && !segs.has(l.segmentId)) {
        out.push({ kind: 'live', key: `live-${role}`, role, startMs: l.startMs, text: l.text, unconfirmed: l.unconfirmed, segmentId: l.segmentId });
      }
    }
    for (const g of gaps.values()) {
      out.push({ kind: 'gap', key: `gap-${g.gapId}`, role: g.role, startMs: g.startMs, endMs: g.endMs, reason: g.reason, segmentId: `~${g.gapId}` });
    }
    return out.sort(compareRows);
  }, [segs, live, gaps]);

  // 自動スクロールは最下部を見ているときだけ。過去を読んでいるときは位置を保ち新着数を出す
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const seenCount = useRef(0);
  const [unseen, setUnseen] = useState(0);
  const finalCount = segs.size;

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom.current) {
      seenCount.current = finalCount;
      setUnseen(0);
    }
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      seenCount.current = finalCount;
      setUnseen(0);
    } else {
      setUnseen(Math.max(0, finalCount - seenCount.current));
    }
  }, [rows, finalCount]);

  const jumpToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    seenCount.current = finalCount;
    setUnseen(0);
  };

  if (error) {
    return (
      <div className="detail">
        <button className="back" onClick={props.onBack}>
          ← 一覧へ
        </button>
        <div className="banner bad">{error}</div>
      </div>
    );
  }
  if (!call) return <div className="detail loading">読み込み中…</div>;

  const cs = CALL_STATUS[call.callStatus];
  const ts = TX_STATUS[call.transcriptionStatus];
  const base = call.recognitionBaseAt;
  const ended = ['ended', 'failed', 'abandoned'].includes(call.callStatus);

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="back" onClick={props.onBack}>
          ← 一覧へ
        </button>
        <div className="title">
          <h1>{call.callerDisplay}</h1>
          <span className={`badge ${cs.tone}`}>{cs.label}</span>
          {call.callStatus !== 'ivr' && call.callStatus !== 'dialing' && <span className={`badge ${ts.tone}`}>{ts.label}</span>}
          {conn !== 'open' && <span className="badge warn">{conn === 'reconnecting' ? '再接続中' : '接続中…'}</span>}
        </div>
        <dl className="meta">
          <div>
            <dt>着信</dt>
            <dd>{fmtDateTime(call.receivedAt)}</dd>
          </div>
          <div>
            <dt>応答</dt>
            <dd>{fmtDateTime(call.sipAnsweredAt)}</dd>
          </div>
          <div>
            <dt>終了</dt>
            <dd>
              {fmtDateTime(call.endedAt)}
              {call.endReason && <span className="reason">（{END_REASON[call.endReason] ?? call.endReason}）</span>}
            </dd>
          </div>
          <div>
            <dt>エンジン</dt>
            <dd>{call.engineLabel ?? '-'}</dd>
          </div>
          {call.sipTargetUri && (
            <div>
              <dt>接続先</dt>
              <dd className="mono">{call.sipTargetUri}</dd>
            </div>
          )}
          <div>
            <dt>callId</dt>
            <dd className="mono">{call.callId}</dd>
          </div>
        </dl>
        <div className="roles">
          {(['caller', 'operator'] as Role[]).map((r) => {
            const rv = call.roles[r];
            const bad = rv.asrStatus === 'failed' || rv.asrStatus === 'reconnecting';
            return (
              <div key={r} className={`role-state ${r} ${bad ? 'bad' : ''}`}>
                <span className="who">{ROLE_LABEL[r]}側</span>
                <span>{ROLE_ASR[rv.asrStatus] ?? rv.asrStatus}</span>
                {rv.errorCode && <span className="err">({rv.errorCode})</span>}
                {rv.startupGapMs !== null && rv.startupGapMs >= 100 && (
                  <span className="gapinfo" title="応答から音声受信開始までの未収録時間">冒頭未収録 {(rv.startupGapMs / 1000).toFixed(1)}秒</span>
                )}
              </div>
            );
          })}
        </div>
        {call.limitReached && (
          <div className="banner warn">文字起こし上限（55分）に到達しました。通話は継続していますが、以降は文字起こしされません。</div>
        )}
        {call.transcriptionStatus === 'finalizing' && <div className="banner wait">終話しました。最後の認識結果を確定しています…</div>}
        {call.transcriptionStatus === 'partial' && <div className="banner warn">一部の音声が含まれていません。欠落区間は会話中に表示しています。</div>}
        {call.exportable && (
          <div className="downloads">
            <a className="btn" href={exportUrl(call.callId, 'txt')} download>
              TXT をダウンロード
            </a>
            <a className="btn" href={exportUrl(call.callId, 'json')} download>
              JSON をダウンロード
            </a>
          </div>
        )}
      </div>

      <div className="conversation" ref={scroller} onScroll={onScroll} aria-live="polite">
        {rows.length === 0 && (
          <div className="none">
            {call.callStatus === 'ivr' || call.callStatus === 'dialing'
              ? 'オペレーターへの接続を待っています。'
              : ended
                ? '発話は記録されていません。'
                : '発話を待っています…'}
          </div>
        )}
        {rows.map((row) => {
          if (row.kind === 'gap') {
            const len = row.endMs !== null && row.startMs !== null ? ` ${fmtDuration(row.endMs - row.startMs)}` : '';
            return (
              <div key={row.key} className={`gap ${row.role}`}>
                {ROLE_LABEL[row.role]}側 欠落: {GAP_REASON[row.reason] ?? row.reason}
                {len}
                <span className="at">{fmtAt(base, row.startMs)}</span>
              </div>
            );
          }
          const isLive = row.kind === 'live';
          return (
            <div key={row.key} className={`msg ${row.role} ${isLive ? 'partial' : ''} ${isLive && row.unconfirmed ? 'unconfirmed' : ''}`}>
              <div className="who">
                {ROLE_LABEL[row.role]}
                <span className="at">
                  {row.kind === 'seg' && row.estimated ? '≈' : ''}
                  {fmtAt(base, row.startMs)}
                </span>
                {isLive && <span className="tag">{row.unconfirmed ? '未確定' : '認識中'}</span>}
              </div>
              {/* 認識文はテキストとして描画する（HTML として解釈しない） */}
              <div className="bubble">{row.text}</div>
            </div>
          );
        })}
      </div>
      {unseen > 0 && (
        <button className="new-pill" onClick={jumpToBottom}>
          新着 {unseen} 件 ↓
        </button>
      )}
    </div>
  );
}

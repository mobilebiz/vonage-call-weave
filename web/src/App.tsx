import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchCalls, subscribe, type CallView, type ConnState, type ListFilter } from './api';
import { CallList } from './CallList';
import { CallDetail } from './CallDetail';
import { SettingsDialog } from './Settings';

const ACTIVE = new Set(['ivr', 'dialing', 'active']);

function matches(c: CallView, f: ListFilter) {
  if (f === 'all') return true;
  return f === 'active' ? ACTIVE.has(c.callStatus) : !ACTIVE.has(c.callStatus);
}

function readHash(): string | null {
  const m = /^#\/calls\/([\w-]+)$/.exec(window.location.hash);
  return m?.[1] ?? null;
}

export function App() {
  const [filter, setFilter] = useState<ListFilter>('active');
  const [calls, setCalls] = useState<Map<string, CallView>>(new Map());
  const [conn, setConn] = useState<ConnState>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(readHash);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const onHash = () => setSelected(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = useCallback((callId: string | null) => {
    window.location.hash = callId ? `#/calls/${callId}` : '';
    setSelected(callId);
  }, []);

  // 一覧の取得中に SSE で届いた通話。スナップショットに含まれなくても消さない
  const seenDuringLoad = useRef<Set<string> | null>(null);

  const upsert = useCallback((c: CallView) => {
    seenDuringLoad.current?.add(c.callId);
    setCalls((prev) => {
      const cur = prev.get(c.callId);
      if (cur && cur.revision >= c.revision) return prev;
      const next = new Map(prev);
      next.set(c.callId, c);
      return next;
    });
  }, []);

  // 一覧の購読。接続・再接続ごとにスナップショットを取り直す
  useEffect(() => {
    const ctrl = new AbortController();
    const reload = () => {
      const seen = new Set<string>();
      seenDuringLoad.current = seen;
      fetchCalls(filter, ctrl.signal)
        .then((items) => {
          setLoadError(null);
          if (seenDuringLoad.current === seen) seenDuringLoad.current = null;
          setCalls((prev) => {
            const next = new Map<string, CallView>();
            for (const c of items) {
              const cur = prev.get(c.callId);
              next.set(c.callId, cur && cur.revision > c.revision ? cur : c);
            }
            // 取得中に届いた新規・更新は、スナップショットより新しいので残す
            for (const id of seen) {
              const cur = prev.get(id);
              if (cur && !next.has(id)) next.set(id, cur);
            }
            return next;
          });
        })
        .catch((e: Error) => {
          if (!ctrl.signal.aborted) setLoadError(e.message);
        });
    };
    const unsub = subscribe(
      '/api/events?scope=calls',
      { 'call.upsert': (d) => upsert(d.call), 'call.finalized': (d) => upsert(d.call) },
      setConn,
      reload,
    );
    return () => {
      ctrl.abort();
      unsub();
    };
  }, [filter, upsert]);

  const list = useMemo(
    () => [...calls.values()].filter((c) => matches(c, filter)).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)),
    [calls, filter],
  );

  return (
    <div className={`app ${selected ? 'has-selection' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ≋
          </span>
          CallWeave
          <span className="sub">通話リアルタイム文字起こし</span>
        </div>
        <div className="top-actions">
          <div className={`conn conn-${conn}`} role="status">
            {conn === 'open' ? '接続中' : conn === 'connecting' ? '接続しています…' : '再接続中…'}
          </div>
          <button className="gear" onClick={() => setShowSettings(true)} aria-label="設定" title="設定">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
                transform="translate(-1 0)"
              />
            </svg>
            <span>設定</span>
          </button>
        </div>
      </header>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      <main className="layout">
        <CallList
          calls={list}
          filter={filter}
          onFilter={setFilter}
          selected={selected}
          onSelect={select}
          error={loadError}
        />
        <section className="detail-pane">
          {selected ? (
            <CallDetail key={selected} callId={selected} summary={calls.get(selected) ?? null} onBack={() => select(null)} onCall={upsert} />
          ) : (
            <div className="empty">
              <p>左の一覧から通話を選択してください。</p>
              <p className="hint">選択しても通話の応答や音声認識の開始には影響しません。</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

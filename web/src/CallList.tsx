import { useEffect, useState } from 'react';
import type { CallView, ListFilter } from './api';
import { CALL_STATUS, TX_STATUS, fmtDuration, fmtReceived } from './format';

const FILTERS: { key: ListFilter; label: string }[] = [
  { key: 'active', label: '通話中' },
  { key: 'ended', label: '終了' },
  { key: 'all', label: '全件' },
];

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function elapsed(c: CallView, now: number): string {
  const start = Date.parse(c.receivedAt);
  const end = c.endedAt ? Date.parse(c.endedAt) : now;
  return fmtDuration(end - start);
}

export function CallList(props: {
  calls: CallView[];
  filter: ListFilter;
  onFilter: (f: ListFilter) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  error: string | null;
}) {
  const now = useNow(1000);
  return (
    <nav className="list-pane" aria-label="通話一覧">
      <div className="filters" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={props.filter === f.key}
            className={props.filter === f.key ? 'on' : ''}
            onClick={() => props.onFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {props.error && <div className="banner bad">一覧を取得できません: {props.error}</div>}
      <ul className="calls">
        {props.calls.length === 0 && <li className="none">該当する通話はありません</li>}
        {props.calls.map((c) => {
          const cs = CALL_STATUS[c.callStatus];
          const ts = TX_STATUS[c.transcriptionStatus];
          return (
            <li key={c.callId}>
              <button className={`call ${props.selected === c.callId ? 'sel' : ''}`} onClick={() => props.onSelect(c.callId)}>
                <div className="row1">
                  <span className="num">{c.callerDisplay}</span>
                  <span className="elapsed" title="経過時間">
                    {elapsed(c, now)}
                  </span>
                </div>
                <div className="row2">
                  <span className="time">{fmtReceived(c.receivedAt)}</span>
                  <span className="engine">{c.engineLabel ?? 'エンジン未選択'}</span>
                  <span className="cid" title={c.callId}>
                    #{c.shortCallId}
                  </span>
                </div>
                <div className="row3">
                  <span className={`badge ${cs.tone}`}>{cs.label}</span>
                  {c.callStatus !== 'ivr' && c.callStatus !== 'dialing' && <span className={`badge ${ts.tone}`}>{ts.label}</span>}
                  {c.limitReached && <span className="badge warn">55分上限</span>}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

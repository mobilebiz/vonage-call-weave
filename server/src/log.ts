// Cloud Logging 向けの構造化ログ。原音声・認識本文・電話番号全文・トークンは出さない。
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SEVERITY: Record<Level, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(level: string, base: Record<string, unknown> = {}): Logger {
  const min = ORDER[(level as Level) in ORDER ? (level as Level) : 'info'];
  const write = (lv: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lv] < min) return;
    const line = JSON.stringify({ severity: SEVERITY[lv], time: new Date().toISOString(), msg, ...base, ...fields });
    (lv === 'error' || lv === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (f) => createLogger(level, { ...base, ...f }),
  };
}

export function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { err: err.name, errMsg: err.message.slice(0, 300) };
  return { err: String(err).slice(0, 300) };
}

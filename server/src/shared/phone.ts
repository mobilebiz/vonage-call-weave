// 発信番号の正規化と表示整形。内部には正規化値と元値の両方を保持する。

export interface NormalizedNumber {
  normalized: string | null;
  raw: string | null;
  kind: 'normal' | 'withheld' | 'unknown';
}

const WITHHELD = new Set(['anonymous', 'private', 'withheld', 'unavailable', 'restricted', 'unknown']);

export function normalizeNumber(raw: unknown): NormalizedNumber {
  if (typeof raw !== 'string' || raw.trim() === '') return { normalized: null, raw: null, kind: 'unknown' };
  const value = raw.trim();
  if (WITHHELD.has(value.toLowerCase())) return { normalized: null, raw: value, kind: 'withheld' };
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 3) return { normalized: null, raw: value, kind: 'unknown' };
  return { normalized: digits, raw: value, kind: 'normal' };
}

/** 日本の番号を読みやすく整形（81 始まりは国内表記へ） */
export function displayNumber(normalized: string | null, kind: NormalizedNumber['kind']): string {
  if (kind === 'withheld') return '非通知';
  if (!normalized) return '番号不明';
  let d = normalized;
  if (d.startsWith('81') && d.length >= 11) d = `0${d.slice(2)}`;
  if (!d.startsWith('0')) return `+${d}`;
  if (/^0[5789]0\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (/^0120\d{6}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  if (/^0[36]\d{8}$/.test(d)) return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`;
  if (/^0\d{9}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}

/** ログ用。電話番号全文を出さない */
export function maskNumber(n: string | null): string {
  if (!n) return '-';
  return n.length <= 4 ? '****' : `***${n.slice(-4)}`;
}

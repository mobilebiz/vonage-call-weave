export const nowIso = (): string => new Date().toISOString();

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

const tokyo = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 2026/10/02 09:30:15 形式（Asia/Tokyo） */
export function formatTokyo(iso: string | null | undefined): string {
  if (!iso) return '-';
  return tokyo.format(new Date(iso));
}

/** callweave_YYYYMMDD_HHmmss 用（Asia/Tokyo） */
export function compactTokyo(iso: string): string {
  const parts = Object.fromEntries(tokyo.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

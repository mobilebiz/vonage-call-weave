import type { Role } from './types.js';

const ROLE_ORDER: Record<Role, number> = { caller: 0, operator: 1 };

export interface Orderable {
  startMs: number | null;
  role: Role;
  segmentId: string;
}

/** 表示順: startMs → role の固定順 → segmentId。到着順は使わない */
export function compareSegments(a: Orderable, b: Orderable): number {
  const as = a.startMs ?? Number.MAX_SAFE_INTEGER;
  const bs = b.startMs ?? Number.MAX_SAFE_INTEGER;
  if (as !== bs) return as - bs;
  if (a.role !== b.role) return ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
  return a.segmentId < b.segmentId ? -1 : a.segmentId > b.segmentId ? 1 : 0;
}

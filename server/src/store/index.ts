import type { Config } from '../config.js';
import { forbiddenProjectPattern } from '../config.js';
import { MemoryStore } from './memory.js';
import type { Store } from './store.js';

export async function createStore(cfg: Config): Promise<Store> {
  if (cfg.store === 'memory') {
    if (cfg.service !== 'all') throw new Error('CW_STORE=memory requires CW_SERVICE=all (single process)');
    return new MemoryStore();
  }
  const projectId = cfg.gcpProjectId;
  if (!projectId || forbiddenProjectPattern()?.test(projectId)) throw new Error('refusing to open Firestore: invalid CW_GCP_PROJECT_ID');
  const { FirestoreStore } = await import('./firestore.js');
  return new FirestoreStore(projectId, cfg.firestoreDatabase);
}

export type { Store } from './store.js';

import { monotonicFactory } from 'ulid';
import type { SqlDb } from './db/sql';

/** Full-text strategy chosen at DO boot (see search/index.ts). */
export type SearchMode = 'fts5' | 'trigram';

/**
 * Who performs a CRM operation. Resolved by the auth layer from a verified
 * session or API key; the DO trusts it because only the core worker can reach
 * the DO, and only after the tenant/permission checks.
 */
export interface CrmActor {
  type: 'user' | 'api_key' | 'system';
  id: string | null;
  /** False for roles without `contacts:read_sensitive` (sensitive fields masked). */
  canReadSensitive: boolean;
}

export interface CrmContext {
  readonly db: SqlDb;
  readonly actor: CrmActor;
  readonly searchMode: SearchMode;
  now(): number;
  newId(): string;
}

const nextUlid = monotonicFactory();

export function createCrmContext(
  db: SqlDb,
  actor: CrmActor,
  searchMode: SearchMode,
  options: { now?: () => number; newId?: () => string } = {},
): CrmContext {
  const now = options.now ?? (() => Date.now());
  return {
    db,
    actor,
    searchMode,
    now,
    newId: options.newId ?? (() => nextUlid(now())),
  };
}

export const SYSTEM_ACTOR: CrmActor = { type: 'system', id: null, canReadSensitive: true };

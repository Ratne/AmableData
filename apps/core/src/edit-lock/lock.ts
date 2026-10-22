import type { EditLockState } from '@amable/api-types';

/** Resources edited by one person at a time; also the prefix of the takeover audit action. */
export type EditLockKind = 'pages' | 'automations' | 'broadcasts' | 'templates' | 'forms';

/** Identity forwarded by the core route after authentication; never read from the client. */
export const EDIT_SESSION_HEADERS = {
  userId: 'x-amable-user-id',
  userName: 'x-amable-user-name',
  canTakeover: 'x-amable-can-takeover',
  tenantId: 'x-amable-tenant-id',
  kind: 'x-amable-lock-kind',
  resourceId: 'x-amable-lock-resource-id',
  takeoverPermission: 'x-amable-lock-takeover-permission',
} as const;

/** A connection silent for longer than this loses its place (holder or waiter). */
export const LOCK_GRACE_MS = 30_000;

export interface LockMember {
  connId: string;
  userId: string;
  userName: string;
  /** Epoch ms: when it became holder (holder) or joined the queue (waiter). */
  since: number;
  lastSeen: number;
}

export interface LockSnapshot {
  holder: LockMember | null;
  waiters: LockMember[];
}

/**
 * Exclusive editing lock of one resource: one holder, FIFO waiters. Pure and
 * serializable so the Durable Object can persist it across hibernation and
 * vitest can drive it with a fake clock. Every mutation returns whether the
 * state changed (the DO then broadcasts it).
 */
export class EditLock {
  holder: LockMember | null;
  waiters: LockMember[];

  constructor(snapshot: LockSnapshot = { holder: null, waiters: [] }) {
    this.holder = snapshot.holder;
    this.waiters = [...snapshot.waiters];
  }

  snapshot(): LockSnapshot {
    return { holder: this.holder, waiters: [...this.waiters] };
  }

  isMember(connId: string): boolean {
    return this.holder?.connId === connId || this.waiters.some((w) => w.connId === connId);
  }

  private promote(now: number): void {
    const next = this.waiters.shift();
    this.holder = next === undefined ? null : { ...next, since: now, lastSeen: now };
  }

  join(member: { connId: string; userId: string; userName: string }, now: number): boolean {
    if (this.isMember(member.connId)) return this.heartbeat(member.connId, now);
    const entry: LockMember = { ...member, since: now, lastSeen: now };
    if (this.holder === null) this.holder = entry;
    else this.waiters.push(entry);
    return true;
  }

  heartbeat(connId: string, now: number): boolean {
    if (this.holder?.connId === connId) {
      this.holder = { ...this.holder, lastSeen: now };
      return false;
    }
    const waiter = this.waiters.find((w) => w.connId === connId);
    if (waiter !== undefined) waiter.lastSeen = now;
    return false;
  }

  /** Release or disconnect: a leaving holder hands the lock to the first waiter. */
  leave(connId: string, now: number): boolean {
    if (this.holder?.connId === connId) {
      this.promote(now);
      return true;
    }
    const before = this.waiters.length;
    this.waiters = this.waiters.filter((w) => w.connId !== connId);
    return this.waiters.length !== before;
  }

  /** Forced takeover: the caller becomes holder, the previous holder waits first in line. */
  takeover(connId: string, now: number): { changed: boolean; previous: LockMember | null } {
    if (this.holder?.connId === connId) return { changed: false, previous: null };
    const waiter = this.waiters.find((w) => w.connId === connId);
    if (waiter === undefined) return { changed: false, previous: null };
    const previous = this.holder;
    this.waiters = this.waiters.filter((w) => w.connId !== connId);
    if (previous !== null) this.waiters.unshift({ ...previous, since: now, lastSeen: now });
    this.holder = { ...waiter, since: now, lastSeen: now };
    return { changed: true, previous };
  }

  /** Drops members whose heartbeat is older than the grace period. */
  expire(now: number): boolean {
    let changed = false;
    const alive = (m: LockMember) => now - m.lastSeen <= LOCK_GRACE_MS;
    const before = this.waiters.length;
    this.waiters = this.waiters.filter(alive);
    if (this.waiters.length !== before) changed = true;
    while (this.holder !== null && !alive(this.holder)) {
      this.promote(now);
      changed = true;
    }
    return changed;
  }

  holds(userId: string): boolean {
    return this.holder?.userId === userId;
  }

  /** Earliest moment a member may expire (for the DO alarm); null when empty. */
  nextExpiry(): number | null {
    const all = [...(this.holder === null ? [] : [this.holder]), ...this.waiters];
    if (all.length === 0) return null;
    return Math.min(...all.map((m) => m.lastSeen)) + LOCK_GRACE_MS + 1;
  }

  /** State as seen by a connection (`connId` null: a user without a socket, via the status endpoint). */
  stateFor(connId: string | null, userId?: string): EditLockState {
    const isHolder = connId === null ? this.holder !== null && this.holder.userId === userId : this.holder?.connId === connId;
    return {
      type: 'state',
      holder:
        this.holder === null
          ? null
          : { user_id: this.holder.userId, user_name: this.holder.userName, since: this.holder.since },
      role: isHolder ? 'holder' : 'waiting',
      waiting: this.waiters.length,
    };
  }
}

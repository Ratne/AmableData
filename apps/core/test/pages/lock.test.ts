import { describe, expect, it } from 'vitest';
import { EditLock, LOCK_GRACE_MS } from '../../src/pages/lock';

const ada = { connId: 'c1', userId: 'u_ada', userName: 'Ada' };
const bob = { connId: 'c2', userId: 'u_bob', userName: 'Bob' };
const eve = { connId: 'c3', userId: 'u_eve', userName: 'Eve' };

describe('edit lock', () => {
  it('gives the lock to the first comer and queues the others FIFO', () => {
    const lock = new EditLock();
    lock.join(ada, 1000);
    lock.join(bob, 1001);
    lock.join(eve, 1002);
    expect(lock.stateFor('c1')).toEqual({
      type: 'state',
      holder: { user_id: 'u_ada', user_name: 'Ada', since: 1000 },
      role: 'holder',
      waiting: 2,
    });
    expect(lock.stateFor('c2').role).toBe('waiting');
    expect(lock.holds('u_ada')).toBe(true);
    expect(lock.holds('u_bob')).toBe(false);
  });

  it('promotes the next waiter on release and drops leaving waiters', () => {
    const lock = new EditLock();
    lock.join(ada, 0);
    lock.join(bob, 1);
    lock.join(eve, 2);
    expect(lock.leave('c2', 3)).toBe(true);
    expect(lock.leave('c1', 4)).toBe(true);
    expect(lock.stateFor('c3')).toMatchObject({ role: 'holder', holder: { user_id: 'u_eve', since: 4 }, waiting: 0 });
    expect(lock.leave('c3', 5)).toBe(true);
    expect(lock.holder).toBeNull();
  });

  it('expires a silent holder after the heartbeat grace and keeps a beating one', () => {
    const lock = new EditLock();
    lock.join(ada, 0);
    lock.join(bob, 0);
    lock.heartbeat('c2', LOCK_GRACE_MS);
    expect(lock.expire(LOCK_GRACE_MS)).toBe(false);
    expect(lock.expire(LOCK_GRACE_MS + 1)).toBe(true);
    expect(lock.holder?.userId).toBe('u_bob');
    expect(lock.nextExpiry()).toBe(LOCK_GRACE_MS + 1 + LOCK_GRACE_MS + 1);
    lock.heartbeat('c2', 3 * LOCK_GRACE_MS);
    expect(lock.expire(3 * LOCK_GRACE_MS + 10)).toBe(false);
  });

  it('lets a waiter take over; the previous holder waits first in line', () => {
    const lock = new EditLock();
    lock.join(ada, 0);
    lock.join(bob, 1);
    lock.join(eve, 2);
    const result = lock.takeover('c3', 10);
    expect(result).toMatchObject({ changed: true, previous: { userId: 'u_ada' } });
    expect(lock.holder?.userId).toBe('u_eve');
    expect(lock.waiters.map((w) => w.userId)).toEqual(['u_ada', 'u_bob']);
    expect(lock.takeover('c3', 11).changed).toBe(false);
    expect(lock.takeover('unknown', 11).changed).toBe(false);
  });

  it('survives a snapshot round trip (hibernation)', () => {
    const lock = new EditLock();
    lock.join(ada, 0);
    lock.join(bob, 1);
    const restored = new EditLock(JSON.parse(JSON.stringify(lock.snapshot())));
    expect(restored.stateFor('c2')).toEqual(lock.stateFor('c2'));
    expect(restored.stateFor(null, 'u_ada').role).toBe('holder');
  });
});

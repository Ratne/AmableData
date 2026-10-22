import { EditLock } from '../../src/edit-lock/lock';
import type { Env } from '../../src/env';

/**
 * In-memory `EDIT_SESSION` namespace: one `EditLock` per instance name
 * (`<tenantId>:<pageId>` for pages, `<tenantId>:<kind>:<id>` otherwise) and
 * the headers each WebSocket upgrade forwarded to the Durable Object.
 */
export function fakeEditSessions() {
  const locks = new Map<string, EditLock>();
  const forwarded: Headers[] = [];
  const lockOf = (name: string) => {
    let lock = locks.get(name);
    if (lock === undefined) {
      lock = new EditLock();
      locks.set(name, lock);
    }
    return lock;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      canSave: (userId: string) => Promise.resolve(lockOf(name).holder === null || lockOf(name).holds(userId)),
      status: (userId: string) => Promise.resolve(lockOf(name).stateFor(null, userId)),
      fetch: (request: Request) => {
        forwarded.push(request.headers);
        return Promise.resolve(new Response('forwarded', { status: 200 }));
      },
    }),
  } as unknown as NonNullable<Env['EDIT_SESSION']>;
  return {
    namespace,
    locks,
    forwarded,
    /** `userId` becomes the holder of the lock `name`. */
    hold(name: string, userId: string, userName = 'Holder') {
      const lock = new EditLock();
      lock.join({ connId: `held-${userId}`, userId, userName }, Date.now());
      locks.set(name, lock);
    },
    release(name: string) {
      locks.delete(name);
    },
  };
}

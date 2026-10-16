import { useCallback, useEffect, useRef, useState } from 'react';
import { LandingApiError, type LandingClient } from '../api/client';
import type { LockHolder, LockState } from '../api/types';

/**
 * - `connecting`: socket not open yet (editing stays disabled);
 * - `holder`: we hold the exclusive lock;
 * - `waiting`: someone else holds it, we are queued;
 * - `unavailable`: the lock service is not deployed (503): editing allowed,
 *   the server does not enforce the lock either;
 * - `offline`: the socket dropped, reconnecting.
 */
export type EditLockStatus = 'connecting' | 'holder' | 'waiting' | 'unavailable' | 'offline';

const HEARTBEAT_MS = 10_000;
const MAX_BACKOFF_MS = 15_000;

function parseState(data: unknown): LockState | null {
  if (typeof data !== 'string') return null;
  try {
    const msg = JSON.parse(data) as Partial<LockState>;
    if (msg.type !== 'state' || (msg.role !== 'holder' && msg.role !== 'waiting')) return null;
    return { type: 'state', holder: msg.holder ?? null, role: msg.role, waiting: typeof msg.waiting === 'number' ? msg.waiting : 0 };
  } catch {
    return null;
  }
}

/** Exclusive edit lock of a page over the lock WebSocket (heartbeat, release on leave, takeover). */
export function useEditLock(api: LandingClient, pageId: string) {
  const [status, setStatus] = useState<EditLockStatus>('connecting');
  const [holder, setHolder] = useState<LockHolder | null>(null);
  const [waiting, setWaiting] = useState(0);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let heartbeat: number | undefined;
    let retry: number | undefined;

    const send = (type: 'heartbeat' | 'release' | 'takeover') => {
      const ws = socket.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type }));
    };

    const scheduleRetry = () => {
      if (closed) return;
      attempt += 1;
      retry = window.setTimeout(connect, Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt));
    };

    /** The socket never opened: ask the status endpoint whether the lock service exists at all. */
    const probe = async () => {
      try {
        const state = await api.pages.lockStatus(pageId);
        if (closed) return;
        setHolder(state.holder);
        setWaiting(state.waiting);
        setStatus('offline');
        scheduleRetry();
      } catch (error) {
        if (closed) return;
        if (error instanceof LandingApiError && (error.status === 503 || error.status === 501 || error.status === 404)) {
          setStatus('unavailable');
          return;
        }
        setStatus('offline');
        scheduleRetry();
      }
    };

    function connect() {
      if (closed) return;
      let opened = false;
      const ws = new WebSocket(api.pages.lockSocketUrl(pageId));
      socket.current = ws;
      ws.addEventListener('open', () => {
        opened = true;
        attempt = 0;
        window.clearInterval(heartbeat);
        heartbeat = window.setInterval(() => send('heartbeat'), HEARTBEAT_MS);
      });
      ws.addEventListener('message', (event) => {
        const state = parseState(event.data);
        if (!state) return;
        setHolder(state.holder);
        setWaiting(state.waiting);
        setStatus(state.role);
      });
      ws.addEventListener('close', () => {
        window.clearInterval(heartbeat);
        if (socket.current === ws) socket.current = null;
        if (closed) return;
        if (opened) {
          setStatus('offline');
          scheduleRetry();
        } else {
          void probe();
        }
      });
    }

    const onHide = () => send('release');
    window.addEventListener('pagehide', onHide);
    connect();

    return () => {
      closed = true;
      window.removeEventListener('pagehide', onHide);
      window.clearInterval(heartbeat);
      window.clearTimeout(retry);
      send('release');
      socket.current?.close();
      socket.current = null;
    };
  }, [api, pageId]);

  const takeover = useCallback(() => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'takeover' }));
  }, []);

  const release = useCallback(() => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'release' }));
  }, []);

  return { status, holder, waiting, canEdit: status === 'holder' || status === 'unavailable', takeover, release };
}

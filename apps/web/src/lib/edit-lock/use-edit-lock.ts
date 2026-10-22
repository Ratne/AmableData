import type { EditLockHolder, EditLockState } from '@amable/api-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '../api';

/**
 * - `disabled`: no lock requested (e.g. the caller cannot edit anyway);
 * - `connecting`: socket not open yet (editing stays disabled);
 * - `holder`: we hold the exclusive lock;
 * - `waiting`: someone else holds it, we are queued;
 * - `unavailable`: the lock service is not deployed (503): editing allowed,
 *   the server does not enforce the lock either;
 * - `offline`: the socket dropped, reconnecting.
 */
export type EditLockStatus = 'disabled' | 'connecting' | 'holder' | 'waiting' | 'unavailable' | 'offline';

export type EditLockCollection = 'pages' | 'automations' | 'broadcasts' | 'emailTemplates' | 'forms' | 'checkouts';

const HEARTBEAT_MS = 10_000;
const MAX_BACKOFF_MS = 15_000;
const WAITING_REFRESH_MS = 15_000;

/** REST path of a lockable resource; its lock lives at `<path>/lock`. */
export function editLockPath(slug: string, collection: EditLockCollection, id: string): string {
  return `/api/v2/t/${encodeURIComponent(slug)}/${collection}/${encodeURIComponent(id)}`;
}

function parseState(data: unknown): EditLockState | null {
  if (typeof data !== 'string') return null;
  try {
    const msg = JSON.parse(data) as Partial<EditLockState>;
    if (msg.type !== 'state' || (msg.role !== 'holder' && msg.role !== 'waiting')) return null;
    return { type: 'state', holder: msg.holder ?? null, role: msg.role, waiting: typeof msg.waiting === 'number' ? msg.waiting : 0 };
  } catch {
    return null;
  }
}

export interface EditLockOptions {
  /** Called when someone else takes the lock away from us (takeover). */
  onLost?: (holder: EditLockHolder | null) => void;
  /**
   * The server copy may have changed under us: every 15 s while waiting, and
   * when the lock comes to us after waiting. Not after a reconnect as holder,
   * so unsaved edits survive a network blip.
   */
  onStale?: () => void;
}

/**
 * Exclusive edit lock of a resource over the lock WebSocket (heartbeat,
 * release on leave, takeover). `path` null: no lock (status `disabled`).
 */
export function useEditLock(path: string | null, options: EditLockOptions = {}) {
  const [status, setStatus] = useState<EditLockStatus>(path === null ? 'disabled' : 'connecting');
  const [holder, setHolder] = useState<EditLockHolder | null>(null);
  const [waiting, setWaiting] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const onLost = useRef(options.onLost);
  onLost.current = options.onLost;
  const onStale = useRef(options.onStale);
  onStale.current = options.onStale;

  useEffect(() => {
    if (path === null) {
      setStatus('disabled');
      return undefined;
    }
    setStatus('connecting');
    let closed = false;
    let attempt = 0;
    let heartbeat: number | undefined;
    let retry: number | undefined;
    let role: EditLockState['role'] | null = null;

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
        const state = await apiFetch<Omit<EditLockState, 'type'>>(`${path}/lock/status`);
        if (closed) return;
        setHolder(state.holder);
        setWaiting(state.waiting);
        setStatus('offline');
        scheduleRetry();
      } catch (error) {
        if (closed) return;
        if (error instanceof ApiError && (error.status === 503 || error.status === 501 || error.status === 404)) {
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
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}${path}/lock`);
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
        if (role === 'holder' && state.role === 'waiting') onLost.current?.(state.holder);
        if (role === 'waiting' && state.role === 'holder') onStale.current?.();
        role = state.role;
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
  }, [path]);

  useEffect(() => {
    if (status !== 'waiting') return undefined;
    const timer = window.setInterval(() => onStale.current?.(), WAITING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [status]);

  const takeover = useCallback(() => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'takeover' }));
  }, []);

  const release = useCallback(() => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'release' }));
  }, []);

  return {
    status,
    holder,
    waiting,
    canEdit: status === 'holder' || status === 'unavailable' || status === 'disabled',
    takeover,
    release,
  };
}

export type EditLock = ReturnType<typeof useEditLock>;

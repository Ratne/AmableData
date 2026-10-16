import type {
  AnalyticsRealtime,
  RealtimeClientMessage,
  RealtimeEvent,
  RealtimeServerMessage,
} from '@amable/api-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { realtimeSocketUrl, reportUrl, sourceKey, type AnalyticsSource } from '../api';

const MAX_EVENTS = 80;
const PING_MS = 30_000;
const POLL_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** Failed connection attempts before polling the REST snapshot as well. */
const POLL_AFTER_FAILURES = 2;

export type RealtimeStatus = 'connecting' | 'live' | 'polling' | 'offline';

export interface RealtimeFeed {
  readonly snapshot: AnalyticsRealtime | null;
  readonly events: readonly RealtimeEvent[];
  readonly status: RealtimeStatus;
  /** Subscribe to new events (globe pulses). Returns the unsubscribe function. */
  readonly subscribe: (listener: (event: RealtimeEvent) => void) => () => void;
}

function isServerMessage(value: unknown): value is RealtimeServerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}

function mergeEvent(
  snapshot: AnalyticsRealtime | null,
  event: RealtimeEvent,
): AnalyticsRealtime | null {
  if (!snapshot) return snapshot;
  const known = snapshot.visitors.find((visitor) => visitor.visitor_id === event.visitor_id);
  const visitors = known
    ? snapshot.visitors.map((visitor) =>
        visitor.visitor_id === event.visitor_id
          ? {
              ...visitor,
              last_seen: event.ts,
              page: event.type === 'pageview' ? event.path : visitor.page,
              pageviews: visitor.pageviews + (event.type === 'pageview' ? 1 : 0),
              revenue_minor:
                visitor.revenue_minor + (event.type === 'payment' ? (event.amount_minor ?? 0) : 0),
            }
          : visitor,
      )
    : [
        ...snapshot.visitors,
        {
          visitor_id: event.visitor_id,
          session_id: event.visitor_id,
          country: event.country,
          region: null,
          city: event.city,
          latitude: event.latitude,
          longitude: event.longitude,
          page: event.path,
          hostname: null,
          referrer_host: null,
          channel: event.channel ?? 'Direct',
          device: event.device,
          browser: null,
          os: null,
          started_at: event.ts,
          last_seen: event.ts,
          pageviews: event.type === 'pageview' ? 1 : 0,
          revenue_minor: event.type === 'payment' ? (event.amount_minor ?? 0) : 0,
          name: event.label,
          contact_id: null,
        },
      ];
  return {
    ...snapshot,
    online: known ? snapshot.online : snapshot.online + 1,
    visitors,
    events: [event, ...snapshot.events].slice(0, MAX_EVENTS),
  };
}

/**
 * Live feed of a site: WebSocket (snapshot, then one message per event) with
 * exponential reconnect, ping every 30 s, and REST polling every 10 s while
 * the socket is down.
 */
export function useRealtimeFeed(source: AnalyticsSource | null): RealtimeFeed {
  const [snapshot, setSnapshot] = useState<AnalyticsRealtime | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const listeners = useRef(new Set<(event: RealtimeEvent) => void>());
  const key = source ? sourceKey(source) : null;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    const current = sourceRef.current;
    if (!current || key === null) return;
    setSnapshot(null);
    setStatus('connecting');
    let socket: WebSocket | null = null;
    let disposed = false;
    let failures = 0;
    let reconnectTimer: number | undefined;
    let pingTimer: number | undefined;
    let pollTimer: number | undefined;

    const poll = async () => {
      try {
        const data = await apiFetch<AnalyticsRealtime>(reportUrl(current, 'realtime'));
        if (!disposed) setSnapshot(data);
      } catch {
        if (!disposed && failures > POLL_AFTER_FAILURES + 3) setStatus('offline');
      }
    };
    const startPolling = () => {
      if (pollTimer !== undefined) return;
      setStatus('polling');
      void poll();
      pollTimer = window.setInterval(() => void poll(), POLL_MS);
    };
    const stopPolling = () => {
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      pollTimer = undefined;
    };
    const send = (message: RealtimeClientMessage) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    const connect = () => {
      if (disposed) return;
      if (typeof WebSocket === 'undefined') {
        startPolling();
        return;
      }
      try {
        socket = new WebSocket(realtimeSocketUrl(current));
      } catch {
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        failures = 0;
        stopPolling();
        setStatus('live');
        window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => send({ type: 'ping' }), PING_MS);
      };
      socket.onmessage = (message) => {
        if (typeof message.data !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }
        if (!isServerMessage(parsed)) return;
        if (parsed.type === 'snapshot') setSnapshot(parsed.data);
        else if (parsed.type === 'event') {
          const event = parsed.data;
          setSnapshot((previous) => mergeEvent(previous, event));
          for (const listener of listeners.current) listener(event);
        }
      };
      socket.onclose = () => {
        window.clearInterval(pingTimer);
        socket = null;
        if (!disposed) scheduleReconnect();
      };
      socket.onerror = () => socket?.close();
    };

    function scheduleReconnect() {
      failures += 1;
      if (failures >= POLL_AFTER_FAILURES) startPolling();
      else setStatus('connecting');
      const delay =
        Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1)) * (0.8 + Math.random() * 0.4);
      reconnectTimer = window.setTimeout(connect, delay);
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') send({ type: 'snapshot' });
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pingTimer);
      stopPolling();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [key]);

  const subscribe = useCallback((listener: (event: RealtimeEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return { snapshot, events: snapshot?.events ?? [], status, subscribe };
}

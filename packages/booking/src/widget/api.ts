import type { BookPayload, BookResult, ManageView, PublicBookingConfig, PublicSlotsResult } from '../public';

/** HTTP client of the edge booking routes (same origin as the script) and the live availability stream. */

export interface ApiFailure {
  readonly status: number;
  readonly error: string;
  readonly message: string;
  readonly details: ReadonlyArray<{ path: string; message: string }>;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

async function call<T>(url: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      credentials: 'omit',
      headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { ok: true, value: body as T };
    return {
      ok: false,
      failure: {
        status: response.status,
        error: typeof body['error'] === 'string' ? body['error'] : 'error',
        message: typeof body['message'] === 'string' ? body['message'] : '',
        details: Array.isArray(body['details']) ? (body['details'] as ApiFailure['details']) : [],
      },
    };
  } catch {
    return { ok: false, failure: { status: 0, error: 'network', message: '', details: [] } };
  }
}

export class BookingApi {
  constructor(
    readonly base: string,
    readonly tenant: string,
  ) {}

  private eventUrl(slug: string, path = ''): string {
    return `${this.base}/b/${encodeURIComponent(this.tenant)}/${encodeURIComponent(slug)}${path}`;
  }

  private manageUrl(token: string, path = ''): string {
    return `${this.base}/b/${encodeURIComponent(this.tenant)}/manage/${encodeURIComponent(token)}${path}`;
  }

  config(slug: string): Promise<ApiResult<PublicBookingConfig>> {
    return call(this.eventUrl(slug, '/config'));
  }

  slots(slug: string, from: string, to: string, timeZone: string): Promise<ApiResult<PublicSlotsResult>> {
    const query = new URLSearchParams({ from, to, tz: timeZone });
    return call(this.eventUrl(slug, `/slots?${query.toString()}`));
  }

  version(slug: string): Promise<ApiResult<{ version: number }>> {
    return call(this.eventUrl(slug, '/version'));
  }

  book(slug: string, payload: BookPayload): Promise<ApiResult<BookResult>> {
    return call(this.eventUrl(slug, '/book'), { method: 'POST', body: JSON.stringify(payload) });
  }

  cancel(token: string, reason: string): Promise<ApiResult<ManageView>> {
    return call(this.manageUrl(token, '/cancel'), { method: 'POST', body: JSON.stringify({ reason }) });
  }

  reschedule(token: string, start: string, timeZone: string): Promise<ApiResult<ManageView>> {
    return call(this.manageUrl(token, '/reschedule'), {
      method: 'POST',
      body: JSON.stringify({ start, time_zone: timeZone }),
    });
  }

  /**
   * Live availability: a WebSocket pushes `{ type: 'version', version }`;
   * without it (blocked, proxy) the version is polled every 30 s.
   */
  watch(slug: string, onVersion: (version: number) => void): () => void {
    let closed = false;
    let socket: WebSocket | null = null;
    let poll: number | null = null;
    let retries = 0;
    const startPolling = () => {
      if (poll !== null) return;
      poll = window.setInterval(() => {
        void this.version(slug).then((result) => {
          if (result.ok) onVersion(result.value.version);
        });
      }, 30_000);
    };
    const open = () => {
      if (closed || typeof WebSocket === 'undefined') {
        startPolling();
        return;
      }
      try {
        socket = new WebSocket(this.eventUrl(slug, '/live').replace(/^http/, 'ws'));
      } catch {
        startPolling();
        return;
      }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; version?: number };
          if (message.type === 'version' && typeof message.version === 'number') onVersion(message.version);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onopen = () => {
        retries = 0;
      };
      socket.onclose = () => {
        if (closed) return;
        startPolling();
        retries += 1;
        if (retries <= 5) window.setTimeout(open, Math.min(1000 * 2 ** retries, 30_000));
      };
    };
    open();
    return () => {
      closed = true;
      if (poll !== null) window.clearInterval(poll);
      socket?.close();
    };
  }
}

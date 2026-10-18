import type { Interval } from '@amable/booking';
import type { EmailSendRequest } from '@amable/core';
import { DurableObject } from 'cloudflare:workers';
import { createDoSqlDb } from '../crm/db/do-sql';
import type { Env } from '../env';
import {
  CalendarCore,
  type CalendarDoRef,
  type CalendarEventChange,
  type CalendarEventState,
  type ReminderJob,
  type SyncResult,
} from './calendar-core';
import { oauthProviderFor } from './runtime';

/**
 * One instance per booking calendar (`<tenantId>:<calendarId>`): external
 * busy cache (Google Calendar), reminder alarm and the live availability
 * version pushed to open widgets over hibernatable WebSockets. Logic lives in
 * `CalendarCore`; this class only adapts the Durable Object APIs.
 */
export class BookingCalendar extends DurableObject<Env> {
  private readonly core: CalendarCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new CalendarCore({
      db: createDoSqlDb(ctx.storage),
      now: () => Date.now(),
      oauth: oauthProviderFor(env),
      // Fixed Google API endpoint: no user-controlled URL reaches this fetch.
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
      broadcast: (message) => {
        for (const ws of ctx.getWebSockets()) {
          try {
            ws.send(message);
          } catch {
            // closed socket: the runtime drops it
          }
        }
      },
      setAlarm: async (at) => {
        if (at === null) await ctx.storage.deleteAlarm();
        else await ctx.storage.setAlarm(at);
      },
      sendEmail: async (request: EmailSendRequest) => {
        await env.EMAIL_SEND.send(request);
      },
    });
  }

  async busy(ref: CalendarDoRef, from: number, to: number): Promise<{ intervals: Interval[]; sync: SyncResult }> {
    return this.core.busy(ref, from, to);
  }

  async sync(ref: CalendarDoRef): Promise<SyncResult> {
    return this.core.sync(ref);
  }

  async bookingChanged(bookingId: string, reminders: ReminderJob[], change?: CalendarEventChange): Promise<number> {
    return this.core.bookingChanged(bookingId, reminders, change);
  }

  eventState(bookingId: string): CalendarEventState | null {
    return this.core.eventState(bookingId);
  }

  /** Availability changed outside a booking (calendar or event type settings). */
  touch(): number {
    return this.core.bump();
  }

  version(): number {
    return this.core.version();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'version', version: this.core.version() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping') ws.send(JSON.stringify({ type: 'version', version: this.core.version() }));
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      // already closed
    }
  }

  override async alarm(): Promise<void> {
    await this.core.fireDue();
  }
}

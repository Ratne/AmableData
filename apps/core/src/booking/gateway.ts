import type { BookingEventType } from '@amable/api-types';
import {
  acceptLanguageList,
  addDays,
  BOOKING_LIVE_RAW_OP,
  DAY_MS,
  isValidTimeZone,
  parseDateKey,
  resolveBookingLocale,
  zonedToUtc,
  type BookingGatewayOps,
  type ManageView,
  type PublicBookingConfig,
} from '@amable/booking';
import { z } from 'zod';
import { GatewayError, type GatewayContext, type GatewayHandlers, type GatewayRawHandlers } from '../public/context';
import type { BookingOutcome, BookingSource } from './bookings';
import type { CalendarRef } from './calendars';
import { afterChange, calendarStub, externalBusy, hashToken, hostNames, manageUrl, newManageToken, versionOf } from './flow';
import { bookingRuntime, type BookingRuntime } from './runtime';

type Output<K extends keyof BookingGatewayOps> = BookingGatewayOps[K]['output'];

const SLUG = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const TOKEN = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const eventRefSchema = z.strictObject({ eventSlug: SLUG });
const slotsInputSchema = z.strictObject({
  eventSlug: SLUG,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().min(1).max(64),
});
const text = (max: number) => z.string().max(max).optional();
const payloadSchema = z.object({
  start: z.iso.datetime({ offset: true }),
  time_zone: z.string().min(1).max(64),
  locale: text(16),
  given_name: z.string().max(200),
  family_name: text(200),
  email: z.string().max(320),
  phone: text(40),
  answers: z.record(z.string().max(64), z.unknown()).optional(),
  hp: text(500),
  turnstile_token: text(4096),
  tracking: z.record(z.string().max(64), z.string().max(500)).optional(),
  meta: z
    .object({ page_url: text(2048), referrer: text(2048), page_id: text(64), visitor_id: text(64) })
    .optional(),
});
const bookInputSchema = z.strictObject({ eventSlug: SLUG, payload: payloadSchema });
const manageInputSchema = z.strictObject({ token: TOKEN });
const cancelInputSchema = z.strictObject({ token: TOKEN, reason: z.string().max(500).optional() });
const rescheduleInputSchema = z.strictObject({
  token: TOKEN,
  start: z.iso.datetime({ offset: true }),
  timeZone: z.string().min(1).max(64),
});

const BOOK_RATE = { name: 'booking:book:ip', limit: 20, windowMs: 10 * 60_000 } as const;
const MAX_SLOT_DAYS = 62;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new GatewayError(
      422,
      'validation_failed',
      'invalid input',
      result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
  return result.data;
}

function timeZoneOf(value: string): string {
  if (!isValidTimeZone(value)) throw new GatewayError(422, 'validation_failed', 'unknown time zone', [{ path: 'time_zone', message: 'invalid_value' }]);
  return value;
}

function turnstileRequired(eventType: BookingEventType, runtime: BookingRuntime): boolean {
  return eventType.turnstile_enabled && runtime.turnstile.enabled;
}

async function publicConfig(
  ctx: GatewayContext,
  eventType: BookingEventType,
  calendars: readonly CalendarRef[],
  runtime: BookingRuntime,
): Promise<PublicBookingConfig> {
  const showHosts = eventType.assignment === 'collective' || calendars.length === 1;
  const names = showHosts ? await hostNames(ctx.env, calendars.map((c) => c.hostUserId)) : new Map<string, string>();
  return {
    tenant: ctx.tenant.slug,
    slug: eventType.slug,
    title: eventType.title,
    description: eventType.description,
    duration_minutes: eventType.duration_minutes,
    location: eventType.location,
    color: eventType.color,
    host_names: calendars.map((c) => names.get(c.hostUserId)).filter((n): n is string => n !== undefined),
    assignment: eventType.assignment,
    time_zone: calendars[0]?.timeZone ?? 'UTC',
    locale: eventType.locale,
    phone: eventType.phone,
    questions: eventType.questions.map(({ map_to: _mapTo, ...q }) => q),
    max_days_ahead: eventType.max_days_ahead,
    success_message: eventType.success_message,
    redirect_url: eventType.redirect_url,
    turnstile_site_key: turnstileRequired(eventType, runtime) ? runtime.turnstileSiteKey : null,
  };
}

async function context(ctx: GatewayContext, eventSlug: string) {
  return ctx.crm('booking.eventTypeContext', { slug: eventSlug, publicOnly: true });
}

async function config(ctx: GatewayContext, input: unknown): Promise<Output<'booking.config'>> {
  const { eventSlug } = parse(eventRefSchema, input);
  const found = await context(ctx, eventSlug);
  return publicConfig(ctx, found.eventType, found.calendars, await bookingRuntime(ctx.env));
}

async function hosted(ctx: GatewayContext, input: unknown): Promise<Output<'booking.hosted'>> {
  return { config: await config(ctx, input), tenantName: ctx.tenant.name };
}

async function slots(ctx: GatewayContext, input: unknown): Promise<Output<'booking.slots'>> {
  const parsed = parse(slotsInputSchema, input);
  const timeZone = timeZoneOf(parsed.timeZone);
  const fromDate = parseDateKey(parsed.from);
  const toDate = parseDateKey(parsed.to);
  if (fromDate === null || toDate === null) throw new GatewayError(422, 'validation_failed', 'invalid dates');
  const from = zonedToUtc(fromDate, 0, timeZone);
  const to = zonedToUtc(addDays(toDate, 1), 0, timeZone) - 1;
  if (to < from || to - from > MAX_SLOT_DAYS * DAY_MS) {
    throw new GatewayError(422, 'validation_failed', `the range must cover 1 to ${String(MAX_SLOT_DAYS)} days`);
  }
  const found = await context(ctx, parsed.eventSlug);
  const [busy, version] = await Promise.all([
    externalBusy(ctx.env, ctx.tenant.id, found.calendars, from, to + DAY_MS),
    versionOf(ctx.env, ctx.tenant.id, found.calendars[0]?.calendarId),
  ]);
  const result = await ctx.crm('booking.slots', { eventTypeId: found.eventType.id, from, to, externalBusy: busy, publicOnly: true });
  return {
    time_zone: timeZone,
    version,
    slots: result.slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })),
  };
}

async function version(ctx: GatewayContext, input: unknown): Promise<Output<'booking.version'>> {
  const { eventSlug } = parse(eventRefSchema, input);
  const found = await context(ctx, eventSlug);
  return { version: await versionOf(ctx.env, ctx.tenant.id, found.calendars[0]?.calendarId) };
}

function nullable(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

async function bookSlot(ctx: GatewayContext, input: unknown): Promise<Output<'booking.book'>> {
  const { eventSlug, payload } = parse(bookInputSchema, input);
  if ((payload.hp ?? '') !== '') throw new GatewayError(400, 'bad_request', 'invalid submission');
  const runtime = await bookingRuntime(ctx.env);
  if (ctx.client.ip !== null) {
    const limit = await runtime.limiter.consume(BOOK_RATE, `${ctx.tenant.id}:${ctx.client.ip}`);
    if (!limit.allowed) throw new GatewayError(429, 'rate_limited', 'too many bookings, retry later');
  }
  const found = await context(ctx, eventSlug);
  if (turnstileRequired(found.eventType, runtime)) {
    const ok = await runtime.turnstile.verify(payload.turnstile_token || undefined, ctx.client.ip);
    if (!ok) throw new GatewayError(403, 'turnstile_failed', 'bot verification failed');
  }
  const timeZone = timeZoneOf(payload.time_zone);
  const start = Date.parse(payload.start);
  const end = start + found.eventType.duration_minutes * 60_000;
  const busy = await externalBusy(ctx.env, ctx.tenant.id, found.calendars, start - DAY_MS, end + DAY_MS);
  const { token, hash } = await newManageToken();
  const tracking = payload.tracking ?? {};
  const meta = payload.meta ?? {};
  const source: BookingSource = {
    utm_source: nullable(tracking['utm_source']),
    utm_medium: nullable(tracking['utm_medium']),
    utm_campaign: nullable(tracking['utm_campaign']),
    utm_term: nullable(tracking['utm_term']),
    utm_content: nullable(tracking['utm_content']),
    referrer: nullable(meta.referrer) ?? nullable(ctx.client.referer ?? undefined),
    page_url: nullable(meta.page_url),
    page_id: nullable(meta.page_id),
  };
  const locale =
    payload.locale === 'it' || payload.locale === 'en'
      ? payload.locale
      : resolveBookingLocale(found.eventType.locale, acceptLanguageList(ctx.client.acceptLanguage));
  const outcome = await ctx.crm('booking.book', {
    eventTypeId: found.eventType.id,
    start,
    timeZone,
    locale,
    invitee: {
      given_name: payload.given_name,
      family_name: payload.family_name ?? '',
      email: payload.email,
      phone: payload.phone ?? '',
    },
    answers: payload.answers ?? {},
    source,
    visitorId: nullable(meta.visitor_id) ?? ctx.client.visitorId,
    manageTokenHash: hash,
    externalBusy: busy,
    channel: 'public',
  });
  ctx.executionCtx.waitUntil(
    afterChange(ctx.env, { tenantId: ctx.tenant.id, tenantSlug: ctx.tenant.slug, outcome, token, notify: true, now: runtime.now() }),
  );
  const names = await hostNames(ctx.env, outcome.calendars.map((c) => c.hostUserId));
  return {
    ok: true,
    booking_id: outcome.booking.id,
    start: outcome.booking.starts_at,
    end: outcome.booking.ends_at,
    time_zone: outcome.booking.time_zone,
    title: outcome.eventType.title,
    host_names: outcome.calendars.map((c) => names.get(c.hostUserId)).filter((n): n is string => n !== undefined),
    manage_url: manageUrl(ctx.env, ctx.tenant.slug, token),
    success_message: outcome.eventType.success_message,
    redirect_url: outcome.eventType.redirect_url,
  };
}

async function manageView(ctx: GatewayContext, outcome: BookingOutcome, runtime: BookingRuntime): Promise<ManageView> {
  const found = await ctx.crm('booking.eventTypeContext', { id: outcome.eventType.id });
  const booking = outcome.booking;
  return {
    booking_id: booking.id,
    status: booking.status,
    start: booking.starts_at,
    end: booking.ends_at,
    time_zone: booking.time_zone,
    invitee_name: booking.invitee_name,
    cancelled_at: booking.cancelled_at,
    can_change: booking.status === 'confirmed' && Date.parse(booking.starts_at) > runtime.now(),
    config: await publicConfig(ctx, found.eventType, found.calendars, runtime),
  };
}

async function manage(ctx: GatewayContext, input: unknown): Promise<Output<'booking.manage'>> {
  const { token } = parse(manageInputSchema, input);
  const outcome = await ctx.crm('booking.manageContext', { tokenHash: await hashToken(token) });
  return manageView(ctx, outcome, await bookingRuntime(ctx.env));
}

async function cancel(ctx: GatewayContext, input: unknown): Promise<Output<'booking.cancel'>> {
  const { token, reason } = parse(cancelInputSchema, input);
  const runtime = await bookingRuntime(ctx.env);
  const outcome = await ctx.crm('booking.cancel', {
    tokenHash: await hashToken(token),
    by: 'invitee',
    ...(reason === undefined ? {} : { reason }),
  });
  ctx.executionCtx.waitUntil(
    afterChange(ctx.env, { tenantId: ctx.tenant.id, tenantSlug: ctx.tenant.slug, outcome, token, notify: true, now: runtime.now() }),
  );
  return manageView(ctx, outcome, runtime);
}

async function reschedule(ctx: GatewayContext, input: unknown): Promise<Output<'booking.reschedule'>> {
  const parsed = parse(rescheduleInputSchema, input);
  const timeZone = timeZoneOf(parsed.timeZone);
  const runtime = await bookingRuntime(ctx.env);
  const tokenHash = await hashToken(parsed.token);
  const current = await ctx.crm('booking.manageContext', { tokenHash });
  const hosts = await ctx.crm('booking.eventTypeContext', { id: current.eventType.id });
  const start = Date.parse(parsed.start);
  const end = start + current.eventType.duration_minutes * 60_000;
  const calendars = [...current.calendars, ...hosts.calendars.filter((c) => !current.calendars.some((k) => k.calendarId === c.calendarId))];
  const busy = await externalBusy(ctx.env, ctx.tenant.id, calendars, start - DAY_MS, end + DAY_MS);
  const outcome = await ctx.crm('booking.reschedule', { tokenHash, start, externalBusy: busy, by: 'invitee', timeZone });
  ctx.executionCtx.waitUntil(
    afterChange(ctx.env, {
      tenantId: ctx.tenant.id,
      tenantSlug: ctx.tenant.slug,
      outcome,
      token: parsed.token,
      notify: true,
      now: runtime.now(),
    }),
  );
  return manageView(ctx, outcome, runtime);
}

/** WebSocket upgrade to the first host calendar's DO (pushes `{ type: 'version' }`). */
async function live(ctx: GatewayContext, input: unknown): Promise<Response> {
  const { eventSlug } = parse(eventRefSchema, input);
  const found = await context(ctx, eventSlug);
  const first = found.calendars[0];
  const stub = first === undefined ? null : calendarStub(ctx.env, ctx.tenant.id, first.calendarId);
  if (stub === null) return new Response('live availability unavailable', { status: 503 });
  return stub.fetch('https://booking-calendar/live', { headers: { upgrade: 'websocket' } });
}

/** Public ops reachable from the edge worker (see `BookingGatewayOps` in @amable/booking). */
export const bookingGatewayHandlers: GatewayHandlers = {
  'booking.config': config,
  'booking.hosted': hosted,
  'booking.slots': slots,
  'booking.version': version,
  'booking.book': bookSlot,
  'booking.manage': manage,
  'booking.cancel': cancel,
  'booking.reschedule': reschedule,
};
export const bookingGatewayRawHandlers: GatewayRawHandlers = {
  [BOOKING_LIVE_RAW_OP]: live,
};

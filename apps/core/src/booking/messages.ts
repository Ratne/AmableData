import type { BookingMessages } from '@amable/api-types';
import type { EmailSendRequest } from '@amable/core';

/**
 * Invitee emails of bookings (confirmation, reminder, rescheduled, cancelled)
 * as inline `EmailSendRequest`s: `{{ booking.* }}` variables are filled here,
 * contact Liquid (`{{ contact.first_name }}` …) is left to the email pipeline.
 * They go out as `transactional` sends: delivered to contacts who opted out of
 * marketing, outside the quota guard (see `EmailSendSource`).
 */

export type MessageKind = 'confirmation' | 'reminder' | 'rescheduled' | 'cancelled';
export type MessageLocale = 'en' | 'it';

export interface BookingMessageVars {
  eventTitle: string;
  startsAt: number;
  endsAt: number;
  timeZone: string;
  locale: MessageLocale;
  hostName: string;
  location: string;
  manageUrl: string;
  inviteeName: string;
}

const DEFAULTS: Record<MessageLocale, Record<MessageKind, { subject: string; body: string }>> = {
  en: {
    confirmation: {
      subject: 'Confirmed: {{ booking.event_title }} on {{ booking.start_date }}',
      body: 'Hi {{ contact.first_name | default: "there" }},\n\nyour booking is confirmed.\n\n{{ booking.event_title }}\n{{ booking.start_date }}, {{ booking.start_time }} - {{ booking.end_time }} ({{ booking.time_zone }})\n{{ booking.location }}\n\nNeed to change it? Cancel or reschedule here: {{ booking.manage_url }}',
    },
    reminder: {
      subject: 'Reminder: {{ booking.event_title }} on {{ booking.start_date }} at {{ booking.start_time }}',
      body: 'Hi {{ contact.first_name | default: "there" }},\n\nthis is a reminder of your booking.\n\n{{ booking.event_title }}\n{{ booking.start_date }}, {{ booking.start_time }} - {{ booking.end_time }} ({{ booking.time_zone }})\n{{ booking.location }}\n\nCancel or reschedule: {{ booking.manage_url }}',
    },
    rescheduled: {
      subject: 'Rescheduled: {{ booking.event_title }} on {{ booking.start_date }}',
      body: 'Hi {{ contact.first_name | default: "there" }},\n\nyour booking has a new time.\n\n{{ booking.event_title }}\n{{ booking.start_date }}, {{ booking.start_time }} - {{ booking.end_time }} ({{ booking.time_zone }})\n\nManage it here: {{ booking.manage_url }}',
    },
    cancelled: {
      subject: 'Cancelled: {{ booking.event_title }} on {{ booking.start_date }}',
      body: 'Hi {{ contact.first_name | default: "there" }},\n\nyour booking of {{ booking.event_title }} on {{ booking.start_date }} at {{ booking.start_time }} has been cancelled.',
    },
  },
  it: {
    confirmation: {
      subject: 'Confermato: {{ booking.event_title }} il {{ booking.start_date }}',
      body: 'Ciao {{ contact.first_name | default: "" }},\n\nla tua prenotazione è confermata.\n\n{{ booking.event_title }}\n{{ booking.start_date }}, {{ booking.start_time }} - {{ booking.end_time }} ({{ booking.time_zone }})\n{{ booking.location }}\n\nDevi cambiarla? Annulla o sposta qui: {{ booking.manage_url }}',
    },
    reminder: {
      subject: 'Promemoria: {{ booking.event_title }} il {{ booking.start_date }} alle {{ booking.start_time }}',
      body: 'Ciao {{ contact.first_name | default: "" }},\n\nti ricordiamo la tua prenotazione.\n\n{{ booking.event_title }}\n{{ booking.start_date }}, {{ booking.start_time }} - {{ booking.end_time }} ({{ booking.time_zone }})\n{{ booking.location }}\n\nAnnulla o sposta: {{ booking.manage_url }}',
    },
    rescheduled: {
      subject: 'Spostato: {{ booking.event_title }} il {{ booking.start_date }}',
      body: 'Ciao {{ contact.first_name | default: "" }},\n\nla tua prenotazione ha un nuovo orario.\n\n{{ booking.event_title }}\n{{ booking.start_date }}, {{ booking.start_time }} - {{ booking.end_time }} ({{ booking.time_zone }})\n\nGestiscila qui: {{ booking.manage_url }}',
    },
    cancelled: {
      subject: 'Annullato: {{ booking.event_title }} il {{ booking.start_date }}',
      body: 'Ciao {{ contact.first_name | default: "" }},\n\nla tua prenotazione di {{ booking.event_title }} del {{ booking.start_date }} alle {{ booking.start_time }} è stata annullata.',
    },
  },
};

/** Subject/body of a kind: the event type's own text when set (confirmation, reminder), else the built-in one. */
export function templateFor(kind: MessageKind, locale: MessageLocale, messages: BookingMessages): { subject: string; body: string } {
  const fallback = DEFAULTS[locale][kind];
  if (kind === 'confirmation' || kind === 'reminder') {
    const subject = messages[`${kind}_subject`].trim();
    const body = messages[`${kind}_body`].trim();
    return { subject: subject === '' ? fallback.subject : subject, body: body === '' ? fallback.body : body };
  }
  return fallback;
}

function format(ms: number, timeZone: string, locale: MessageLocale, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', { ...options, timeZone }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Visitor-provided values must not open Liquid tags. */
const inert = (value: string): string => value.replace(/[{}%]/g, '');

export function variables(vars: BookingMessageVars): Record<string, string> {
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  return {
    event_title: inert(vars.eventTitle),
    start_date: format(vars.startsAt, vars.timeZone, vars.locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    start_time: format(vars.startsAt, vars.timeZone, vars.locale, time),
    end_time: format(vars.endsAt, vars.timeZone, vars.locale, time),
    time_zone: vars.timeZone,
    host_name: inert(vars.hostName),
    location: inert(vars.location),
    manage_url: vars.manageUrl,
    invitee_name: inert(vars.inviteeName),
  };
}

/** Fills `{{ booking.<key> }}`; unknown booking keys become empty, other Liquid is kept. */
export function fillBookingVars(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*booking\.([a-z_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '');
}

type TiptapNode = Record<string, unknown>;

const LIQUID_OUTPUT_RE = /\{\{\s*([A-Za-z_][\w.]*)\s*((?:\|[^{}]*)?)\}\}/g;
const DEFAULT_FILTER_RE = /^default:\s*(?:"([^"]*)"|'([^']*)')$/;

/** Text is escaped by the renderer, so `{{ contact.* }}` must become variable nodes to stay Liquid. */
function inline(line: string): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  let last = 0;
  for (const match of line.matchAll(LIQUID_OUTPUT_RE)) {
    if (match.index > last) nodes.push(...linkified(line.slice(last, match.index)));
    let fallback: string | null = null;
    let filter: string | null = null;
    for (const part of (match[2] ?? '').split('|').map((p) => p.trim()).filter((p) => p !== '')) {
      const def = DEFAULT_FILTER_RE.exec(part);
      if (def !== null) fallback = def[1] ?? def[2] ?? null;
      else filter ??= part;
    }
    nodes.push({ type: 'liquidVariable', attrs: { path: match[1], label: null, fallback, filter } });
    last = match.index + match[0].length;
  }
  if (last < line.length) nodes.push(...linkified(line.slice(last)));
  return nodes;
}

function linkified(line: string): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  let last = 0;
  for (const match of line.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const index = match.index;
    if (index > last) nodes.push({ type: 'text', text: line.slice(last, index) });
    nodes.push({ type: 'text', text: match[0], marks: [{ type: 'link', attrs: { href: match[0] } }] });
    last = index + match[0].length;
  }
  if (last < line.length) nodes.push({ type: 'text', text: line.slice(last) });
  return nodes;
}

/** Plain text → Tiptap document: blank lines split paragraphs, single newlines become hard breaks, URLs links. */
export function textToDoc(text: string): Record<string, unknown> {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.split('\n').filter((line) => line.trim() !== ''))
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const content: TiptapNode[] = [];
      lines.forEach((line, i) => {
        if (i > 0) content.push({ type: 'hardBreak' });
        content.push(...inline(line));
      });
      return { type: 'paragraph', content };
    });
  return { type: 'doc', content: paragraphs };
}

export function emailRequest(input: {
  id: string;
  tenantId: string;
  contactId: string;
  bookingId: string;
  hostUserId: string;
  kind: MessageKind;
  messages: BookingMessages;
  vars: BookingMessageVars;
  now: number;
  /** ISO; dropped when processed later (reminders: the booking start). */
  notAfter: string | null;
}): EmailSendRequest {
  const template = templateFor(input.kind, input.vars.locale, input.messages);
  const values = variables(input.vars);
  return {
    kind: 'email.send',
    version: 1,
    id: input.id,
    tenantId: input.tenantId,
    contactId: input.contactId,
    content: {
      templateId: null,
      subject: fillBookingVars(template.subject, values),
      preheader: null,
      body: textToDoc(fillBookingVars(template.body, values)),
      fromName: null,
      replyTo: null,
    },
    source: { type: 'transactional', purpose: 'booking', referenceId: input.bookingId, userId: input.hostUserId },
    requestedAt: new Date(input.now).toISOString(),
    notAfter: input.notAfter,
  };
}

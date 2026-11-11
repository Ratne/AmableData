import { kindOfLabel, normalizeValue, type Contact } from './capture';

/**
 * Third-party embeds (schedulers, form builders) run in their own iframe or
 * script and tell the page through `postMessage`. Each shim accepts messages
 * only from its provider's origins and maps them to a goal and, when the
 * provider shares them, the submitted contact fields.
 */
export interface EmbedSignal {
  goal: 'booking_scheduled' | 'form_submit';
  form: string;
  contact?: Contact;
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
};
const from = (origin: string, ...domains: string[]): boolean => {
  const host = hostOf(origin);
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
};
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 64) : '');

/** Fields given as `[{name|label, value}]` or `{name: value}`. */
function contactOf(fields: unknown): Contact | undefined {
  const pairs: Array<[string, unknown]> = Array.isArray(fields)
    ? fields.map((f) => [
        String(obj(f)['name'] ?? obj(f)['label'] ?? obj(f)['key'] ?? ''),
        obj(f)['value'],
      ])
    : Object.entries(obj(fields));
  const out: Contact = {};
  for (const [label, raw] of pairs) {
    const kind = kindOfLabel(label);
    const value =
      kind === undefined || typeof raw !== 'string' ? undefined : normalizeValue(kind, raw);
    if (kind !== undefined && value !== undefined && out[kind] === undefined) out[kind] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function embedSignal(
  origin: string,
  pageOrigin: string,
  raw: unknown,
): EmbedSignal | undefined {
  const data = obj(typeof raw === 'string' ? safeJson(raw) : raw);
  if (from(origin, 'calendly.com') && data['event'] === 'calendly.event_scheduled') {
    return { goal: 'booking_scheduled', form: 'calendly' };
  }
  if (from(origin, 'cal.com') && str(data['type']).startsWith('bookingSuccessful')) {
    return { goal: 'booking_scheduled', form: 'cal' };
  }
  if (from(origin, 'typeform.com') && data['type'] === 'form-submit') {
    return { goal: 'form_submit', form: `typeform:${str(data['embedId'] ?? data['formId'])}` };
  }
  if (from(origin, 'tally.so') && data['event'] === 'Tally.FormSubmitted') {
    const payload = obj(data['payload']);
    const contact = contactOf(payload['fields']);
    return {
      goal: 'form_submit',
      form: `tally:${str(payload['formId'])}`,
      ...(contact ? { contact } : {}),
    };
  }
  // HubSpot forms post on the page itself (or from their own iframe).
  if (
    (origin === pageOrigin || from(origin, 'hsforms.com', 'hubspot.com', 'hsforms.net')) &&
    data['type'] === 'hsFormCallback' &&
    data['eventName'] === 'onFormSubmitted'
  ) {
    const d = obj(data['data']);
    const contact = contactOf(d['submissionValues'] ?? data['data']);
    return {
      goal: 'form_submit',
      form: `hubspot:${str(data['id'])}`,
      ...(contact ? { contact } : {}),
    };
  }
  return undefined;
}

function safeJson(raw: string): unknown {
  if (raw.length > 65_536 || !raw.startsWith('{')) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

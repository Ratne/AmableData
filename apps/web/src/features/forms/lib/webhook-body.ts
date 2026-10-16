import { collectsValue, UTM_PARAMS, type FormField } from '@amable/forms';

/**
 * JSON body template of the webhook connector. String values hold `{{key}}`
 * merge tags (the connector's syntax, `renderTags` in apps/core): field keys
 * plus the submission facts of `mergeContext`.
 */

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

const tag = (key: string) => `{{${key}}}`;

/** A form contact exists when a field maps to email or phone (the CRM matching keys). */
export function mapsContact(fields: readonly FormField[]): boolean {
  return fields.some((field) => field.map_to === 'email' || field.map_to === 'phone');
}

/** Every value field by key, then submission facts under `meta` (`_meta` if a field is called `meta`). */
export function buildWebhookBody(fields: readonly FormField[]): JsonObject {
  const body: JsonObject = {};
  for (const field of fields) {
    if (collectsValue(field.kind) && field.key !== '') body[field.key] = tag(field.key);
  }
  const meta: JsonObject = {
    event: 'form.submitted',
    form: { id: tag('form_id'), name: tag('form_name') },
    submission_id: tag('submission_id'),
    submitted_at: tag('submitted_at'),
    page_url: tag('page_url'),
    referrer: tag('referrer'),
    visitor_id: tag('visitor_id'),
    utm: Object.fromEntries(UTM_PARAMS.map((key) => [key, tag(key)])),
  };
  if (mapsContact(fields)) meta['contact_id'] = tag('contact_id');
  body[Object.hasOwn(body, 'meta') ? '_meta' : 'meta'] = meta;
  return body;
}

export type ParsedTemplate = { ok: true; value: JsonObject | null } | { ok: false };

/** `null` for an empty template; `ok: false` when it is not a JSON object. */
export function parseBodyTemplate(text: string): ParsedTemplate {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as JsonObject };
    }
  } catch {
    // not JSON
  }
  return { ok: false };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adds what `base` lacks from `extra`, recursively; values already in `base` win. */
export function mergeMissing(base: JsonObject, extra: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    if (current === undefined) out[key] = value;
    else if (isObject(current) && isObject(value)) out[key] = mergeMissing(current, value);
  }
  return out;
}

/** Pretty-printed result of "Map all fields" (merge keeps the user's keys and values). */
export function applyWebhookBody(
  existing: string,
  generated: JsonObject,
  mode: 'merge' | 'replace',
): string {
  const parsed = parseBodyTemplate(existing);
  const base = mode === 'merge' && parsed.ok && parsed.value !== null ? mergeMissing(parsed.value, generated) : generated;
  return JSON.stringify(base, null, 2);
}

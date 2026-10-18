import {
  MAX_CUSTOM_TRACKING_FIELDS,
  RESERVED_URL_PARAMS,
  TRACKING_FIELD_SLOTS,
  trafficSourceInputSchema,
  type ConversionConfig,
  type CustomTrackingField,
  type ReservedTrackingField,
  type TrafficSource,
  type TrafficSourceInput,
} from '@amable/api-types';

/**
 * Pure editing logic of a traffic source: the two reserved fields
 * (`campaign`, `external`: URL parameter editable, never removable) and the
 * custom slots `c1`…`c20`. Renames only change `name`: the server keeps the
 * old one in `previous_name`.
 */

export const RESERVED_FIELD_KEYS = ['campaign', 'external'] as const;
export type ReservedFieldKey = (typeof RESERVED_FIELD_KEYS)[number];

/** Fully defaulted editor state (what the schema parses an input into). */
export interface SourceDraft {
  name: string;
  category: string | null;
  template: NonNullable<TrafficSourceInput['template']>;
  cost_type: NonNullable<TrafficSourceInput['cost_type']>;
  default_cost_minor: number | null;
  reserved_fields: Record<ReservedFieldKey, ReservedTrackingField>;
  fields: CustomTrackingField[];
  conversion: ConversionConfig;
  cost_modifier_pct: number | null;
  revenue_modifier_pct: number | null;
  skip_zero_revenue_postbacks: boolean;
  postback_throttle_pct: number | null;
}

export type UrlParamError = 'invalid' | 'reserved' | 'duplicate';

const URL_PARAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function reserved(field: TrafficSourceInput['reserved_fields']['campaign']): ReservedTrackingField {
  return {
    url_param: field.url_param,
    source_token: field.source_token ?? '',
    append: field.append ?? true,
  };
}

/** Editor state of a template input or of a stored source. */
export function toDraft(input: TrafficSourceInput | TrafficSource): SourceDraft {
  return {
    name: input.name,
    category: input.category ?? null,
    template: input.template ?? 'custom',
    cost_type: input.cost_type ?? 'cpc',
    default_cost_minor: input.default_cost_minor ?? null,
    reserved_fields: {
      campaign: reserved(input.reserved_fields.campaign),
      external: reserved(input.reserved_fields.external),
    },
    fields: (input.fields ?? []).map((f) => ({
      slot: f.slot,
      name: f.name,
      ...(f.previous_name ? { previous_name: f.previous_name } : {}),
      url_param: f.url_param,
      source_token: f.source_token ?? '',
      append: f.append ?? true,
    })),
    conversion: {
      postback_url: input.conversion?.postback_url ?? null,
      ad_connection_id: input.conversion?.ad_connection_id ?? null,
      platform: input.conversion?.platform ?? null,
      mapping: [...(input.conversion?.mapping ?? [])],
    },
    cost_modifier_pct: input.cost_modifier_pct ?? null,
    revenue_modifier_pct: input.revenue_modifier_pct ?? null,
    skip_zero_revenue_postbacks: input.skip_zero_revenue_postbacks ?? false,
    postback_throttle_pct: input.postback_throttle_pct ?? null,
  };
}

/** Body of `POST`/`PUT /traffic-sources` (stored fields like `id`/`status` dropped). */
export function toSourceInput(draft: SourceDraft): TrafficSourceInput {
  const category = draft.category?.trim() ?? '';
  const postback = draft.conversion.postback_url?.trim() ?? '';
  return {
    name: draft.name.trim(),
    category: category === '' ? null : category,
    template: draft.template,
    cost_type: draft.cost_type,
    default_cost_minor: draft.default_cost_minor,
    reserved_fields: {
      campaign: { ...draft.reserved_fields.campaign },
      external: { ...draft.reserved_fields.external },
    },
    fields: draft.fields.map((f) => ({ ...f })),
    conversion: {
      postback_url: postback === '' ? null : postback,
      ad_connection_id: draft.conversion.ad_connection_id ?? null,
      platform: draft.conversion.platform ?? null,
      mapping: draft.conversion.mapping.map((m) => ({ ...m })),
    },
    cost_modifier_pct: draft.cost_modifier_pct,
    revenue_modifier_pct: draft.revenue_modifier_pct,
    skip_zero_revenue_postbacks: draft.skip_zero_revenue_postbacks,
    postback_throttle_pct: draft.postback_throttle_pct,
  };
}

/** Lowest free custom slot, or null when all twenty are used. */
export function nextFreeSlot(fields: readonly Pick<CustomTrackingField, 'slot'>[]) {
  const used = new Set(fields.map((f) => f.slot));
  return TRACKING_FIELD_SLOTS.find((slot) => !used.has(slot)) ?? null;
}

function slotNumber(slot: string): number {
  return Number(slot.slice(1));
}

/** Adds a custom field in the next free slot (rows stay ordered by slot); unchanged when full. */
export function addField(fields: readonly CustomTrackingField[]): CustomTrackingField[] {
  const slot = nextFreeSlot(fields);
  if (slot === null || fields.length >= MAX_CUSTOM_TRACKING_FIELDS) return [...fields];
  const taken = new Set(fields.map((f) => f.url_param.toLowerCase()));
  let param: string = slot;
  for (let n = 2; taken.has(param.toLowerCase()); n += 1) param = `${slot}_${String(n)}`;
  const field: CustomTrackingField = {
    slot,
    name: slot,
    url_param: param,
    source_token: '',
    append: true,
  };
  return [...fields, field].sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot));
}

export function removeField(
  fields: readonly CustomTrackingField[],
  slot: string,
): CustomTrackingField[] {
  return fields.filter((f) => f.slot !== slot);
}

export function updateField(
  fields: readonly CustomTrackingField[],
  slot: string,
  patch: Partial<Pick<CustomTrackingField, 'name' | 'url_param' | 'source_token' | 'append'>>,
): CustomTrackingField[] {
  return fields.map((f) => (f.slot === slot ? { ...f, ...patch } : f));
}

/** The reserved fields can never be removed; custom slots always can. */
export function isRemovable(key: string): boolean {
  return !(RESERVED_FIELD_KEYS as readonly string[]).includes(key);
}

/** Updates the URL parameter / token / append flag of a reserved field (never its name). */
export function updateReserved(
  draft: SourceDraft,
  key: ReservedFieldKey,
  patch: Partial<ReservedTrackingField>,
): SourceDraft {
  return {
    ...draft,
    reserved_fields: {
      ...draft.reserved_fields,
      [key]: { ...draft.reserved_fields[key], ...patch },
    },
  };
}

/** Problem of a URL parameter given the parameters of the other fields. */
export function urlParamError(param: string, others: readonly string[]): UrlParamError | null {
  const value = param.trim();
  if (!URL_PARAM_RE.test(value)) return 'invalid';
  if ((RESERVED_URL_PARAMS as readonly string[]).includes(value.toLowerCase())) return 'reserved';
  if (others.some((o) => o.trim().toLowerCase() === value.toLowerCase())) return 'duplicate';
  return null;
}

/** URL parameter errors of every field, keyed like the API paths (`fields.2.url_param`). */
export function urlParamErrors(draft: SourceDraft): Map<string, UrlParamError> {
  const entries: { path: string; param: string }[] = [
    ...RESERVED_FIELD_KEYS.map((key) => ({
      path: `reserved_fields.${key}.url_param`,
      param: draft.reserved_fields[key].url_param,
    })),
    ...draft.fields.map((f, i) => ({ path: `fields.${String(i)}.url_param`, param: f.url_param })),
  ];
  const out = new Map<string, UrlParamError>();
  entries.forEach((entry, i) => {
    const before = entries.slice(0, i).map((e) => e.param);
    const error = urlParamError(entry.param, before);
    if (error) out.set(entry.path, error);
  });
  return out;
}

/** Placeholder of a field in data passing and postbacks. */
export function fieldToken(field: { slot?: string; name?: string } | ReservedFieldKey): string {
  if (typeof field === 'string') return `{${field}}`;
  return `{data-${field.name ?? field.slot ?? ''}}`;
}

/** Client-side check with the API schema: message per dotted path (same keys as server details). */
export function sourceIssues(draft: SourceDraft): Map<string, string> {
  const parsed = trafficSourceInputSchema.safeParse(toSourceInput(draft));
  const out = new Map<string, string>();
  if (parsed.success) return out;
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String).join('.');
    if (!out.has(path)) out.set(path, issue.message);
  }
  return out;
}

/** Conversion delivery: an ad connection (platform API), a postback URL, or nothing. */
export type ConversionMode = 'integration' | 'postback' | 'none';

export function conversionMode(conversion: ConversionConfig): ConversionMode {
  if (conversion.ad_connection_id) return 'integration';
  if (conversion.postback_url !== null && conversion.postback_url !== undefined) return 'postback';
  return conversion.platform || conversion.mapping.length > 0 ? 'integration' : 'none';
}

/** Switching mode clears the other one: a source never reports a conversion twice. */
export function setConversionMode(conversion: ConversionConfig, mode: ConversionMode): ConversionConfig {
  switch (mode) {
    case 'integration':
      return { ...conversion, postback_url: null };
    case 'postback':
      return {
        ...conversion,
        postback_url: conversion.postback_url ?? '',
        ad_connection_id: null,
        platform: null,
        mapping: [],
      };
    case 'none':
      return { postback_url: null, ad_connection_id: null, platform: null, mapping: [] };
  }
}

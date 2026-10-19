import {
  CONDITION_OPERATORS,
  CONDITION_SUGGEST_ATTRS,
  DEVICE_TYPES,
  KNOWN_BROWSER_NAMES,
  KNOWN_OS_NAMES,
  type ConditionOperator,
  type ConditionRule,
  type ConditionSuggestAttr,
  type FunnelNode,
  type TrafficSource,
} from '@amable/api-types';
import { languageName, languageOptions } from '../../../components/locale/languages';
import { flagEmoji, PHONE_COUNTRIES, regionName } from '../../../components/locale/phone-countries';

/**
 * How the condition panel edits a rule: which operators make sense for an
 * attribute and which value editor fits the (attribute, operator) pair, so the
 * user picks the exact values the edge engine compares (`conditionAttributeValues`).
 */

export const FIELD_PREFIX = 'field:';
/** Default `field:` name when no traffic source declares a tracking field (data params match too). */
export const DEFAULT_FIELD_NAME = 'utm_source';

export type StaticOptionSet =
  | 'device'
  | 'os'
  | 'browser'
  | 'country'
  | 'language'
  | 'weekday'
  | 'hour'
  | 'traffic_source';

export type ValueEditor =
  | { readonly kind: 'none' }
  /** Pick from a known list; `custom` also accepts typed values. */
  | { readonly kind: 'options'; readonly set: StaticOptionSet; readonly custom: boolean; readonly single: boolean }
  /** Values seen on the site (backend suggestions) plus typed ones. */
  | { readonly kind: 'suggest'; readonly attr: ConditionSuggestAttr }
  /** Typed values (chips). */
  | { readonly kind: 'free' }
  | { readonly kind: 'number' }
  /** `between`: two bounds, picked from `set` or typed as numbers. */
  | { readonly kind: 'range'; readonly set: 'hour' | 'weekday' | null };

const CATEGORICAL: readonly ConditionOperator[] = ['is', 'is_not', 'exists', 'not_exists'];
const TEXT: readonly ConditionOperator[] = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'starts_with',
  'exists',
  'not_exists',
];
const CLOCK: readonly ConditionOperator[] = ['is', 'is_not', 'gt', 'lt', 'between'];

const STATIC_SETS: Readonly<Record<string, StaticOptionSet>> = {
  device: 'device',
  os: 'os',
  browser: 'browser',
  country: 'country',
  language: 'language',
  weekday: 'weekday',
  hour: 'hour',
  traffic_source: 'traffic_source',
};

export const isFieldAttr = (attr: string) => attr.startsWith(FIELD_PREFIX);

const isSuggestAttr = (attr: string): attr is ConditionSuggestAttr =>
  (CONDITION_SUGGEST_ATTRS as readonly string[]).includes(attr);

function allowedOperators(attr: string): readonly ConditionOperator[] {
  if (isFieldAttr(attr)) return CONDITION_OPERATORS;
  switch (attr) {
    case 'device':
    case 'os':
    case 'browser':
    case 'country':
    case 'language':
    case 'traffic_source':
      return CATEGORICAL;
    case 'tag':
      return ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'exists', 'not_exists'];
    case 'hour':
    case 'weekday':
      return CLOCK;
    default:
      return TEXT;
  }
}

/** Operators offered for `attr` in the canonical order; `current` stays listed so a stored rule is never lost. */
export function operatorsFor(attr: string, current?: ConditionOperator): ConditionOperator[] {
  const allowed = allowedOperators(attr);
  return CONDITION_OPERATORS.filter((op) => allowed.includes(op) || op === current);
}

export function valueEditorFor(attr: string, op: ConditionOperator): ValueEditor {
  if (op === 'exists' || op === 'not_exists') return { kind: 'none' };
  const set = STATIC_SETS[attr];
  const clock = attr === 'hour' || attr === 'weekday' ? attr : null;
  if (op === 'between') return { kind: 'range', set: clock };
  if (op === 'gt' || op === 'lt') {
    return clock ? { kind: 'options', set: clock, custom: false, single: true } : { kind: 'number' };
  }
  if (op === 'contains' || op === 'not_contains' || op === 'starts_with') {
    return isSuggestAttr(attr) ? { kind: 'suggest', attr } : { kind: 'free' };
  }
  if (set !== undefined) {
    // Unknown user agents may report other names: OS and browser accept typed values too.
    return { kind: 'options', set, custom: set === 'os' || set === 'browser', single: false };
  }
  if (isSuggestAttr(attr)) return { kind: 'suggest', attr };
  return { kind: 'free' };
}

const sameEditor = (a: ValueEditor, b: ValueEditor) => JSON.stringify(a) === JSON.stringify(b);

/** New attribute: the operator falls back to the first allowed one, values reset (they meant something else). */
export function changeAttr(rule: ConditionRule, attr: string): ConditionRule {
  if (attr === rule.attr) return rule;
  const ops = operatorsFor(attr);
  const op = ops.includes(rule.op) ? rule.op : (ops[0] ?? 'is');
  return { attr, op, values: [] };
}

/** New operator: values are kept while the editor stays the same, else cleared. */
export function changeOp(rule: ConditionRule, op: ConditionOperator): ConditionRule {
  const keep = sameEditor(valueEditorFor(rule.attr, rule.op), valueEditorFor(rule.attr, op));
  return { ...rule, op, values: keep ? rule.values : [] };
}

/** Tags added or removed by the live tag nodes of a graph. */
export function graphTags(graph: { readonly nodes: readonly FunnelNode[] }): string[] {
  const tags = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== 'tag' || node.deleted_at != null) continue;
    for (const tag of [...node.config.add, ...node.config.remove]) tags.add(tag);
  }
  return [...tags];
}

/** Tracking field names declared by the site's traffic sources (what `field:<name>` matches). */
export function fieldNames(sources: readonly TrafficSource[]): string[] {
  const names = new Set<string>();
  for (const source of sources) for (const field of source.fields) names.add(field.name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ------------------------------------------------------------------ options

export interface ValueOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon?: string;
  /** Extra search terms. */
  readonly keywords?: readonly string[];
}

export interface OptionContext {
  readonly locale: string;
  readonly sources: readonly TrafficSource[];
  /** Label of a device class (`desktop`, `mobile`, `tablet`). */
  readonly deviceLabel: (device: (typeof DEVICE_TYPES)[number]) => string;
  /** Hint of archived traffic sources. */
  readonly archivedLabel: string;
}

/** ISO weekday numbers (Monday = 1 … Sunday = 7), as the engine compares them. */
export function weekdayOptions(locale: string): ValueOption[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  const short = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  // 2024-01-01 is a Monday.
  return short.map((code, i) => ({
    value: String(i + 1),
    label: format.format(new Date(Date.UTC(2024, 0, 1 + i))),
    keywords: [code],
  }));
}

export function hourOptions(): ValueOption[] {
  return Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
    hint: `${String(h).padStart(2, '0')}:59`,
  }));
}

export function countryOptions(locale: string): ValueOption[] {
  return PHONE_COUNTRIES.map(({ code }) => ({
    value: code,
    label: regionName(code, locale),
    hint: code,
    icon: flagEmoji(code),
    keywords: [code, regionName(code, 'en')],
  })).sort((a, b) => a.label.localeCompare(b.label, locale));
}

export function staticOptions(set: StaticOptionSet, ctx: OptionContext): ValueOption[] {
  switch (set) {
    case 'device':
      return DEVICE_TYPES.map((d) => ({ value: d, label: ctx.deviceLabel(d) }));
    case 'os':
      return KNOWN_OS_NAMES.map((name) => ({ value: name, label: name }));
    case 'browser':
      return KNOWN_BROWSER_NAMES.map((name) => ({ value: name, label: name }));
    case 'country':
      return countryOptions(ctx.locale);
    case 'language':
      return languageOptions(ctx.locale).map((l) => ({
        value: l.code,
        label: l.name,
        hint: l.code,
        keywords: [l.code, languageName(l.code, 'en'), ...(l.nativeName ? [l.nativeName] : [])],
      }));
    case 'weekday':
      return weekdayOptions(ctx.locale);
    case 'hour':
      return hourOptions();
    case 'traffic_source':
      return ctx.sources.map((s) => ({
        value: s.id,
        label: s.name,
        ...(s.status === 'archived' ? { hint: ctx.archivedLabel } : {}),
        keywords: [s.id],
      }));
  }
}

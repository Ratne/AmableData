import { isValidFilter, isValidPath, liquidString } from './liquid-syntax';

/**
 * Code generators behind the guided Liquid builders (fallback, date, if/else,
 * has tag, loop, case). Inputs come from forms, so identifiers are validated
 * and literals quoted; bodies are template text written by the author and are
 * emitted as-is. Every generator returns null when its input is unusable.
 */

const NUMBER_RE = /^-?[0-9]+(\.[0-9]+)?$/;
const IDENT_RE = /^[a-z_][a-z0-9_]{0,30}$/;
const ZONE_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;

export type BuilderValueType = 'string' | 'number' | 'boolean';

export type BuilderOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'greater_than'
  | 'less_than'
  | 'greater_or_equal'
  | 'less_or_equal'
  | 'is_empty'
  | 'is_not_empty'
  | 'has_tag';

export const BUILDER_OPERATORS: readonly BuilderOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'is_empty',
  'is_not_empty',
  'has_tag',
];

/** Operators that take no value. */
export function operatorTakesValue(operator: BuilderOperator): boolean {
  return operator !== 'is_empty' && operator !== 'is_not_empty';
}

/** Operators that need no field (they read `contact.tags`). */
export function operatorTakesField(operator: BuilderOperator): boolean {
  return operator !== 'has_tag';
}

const COMPARATORS: Partial<Record<BuilderOperator, string>> = {
  equals: '==',
  not_equals: '!=',
  contains: 'contains',
  greater_than: '>',
  less_than: '<',
  greater_or_equal: '>=',
  less_or_equal: '<=',
};

/** A literal for the right-hand side of a comparison. */
export function liquidLiteral(value: string, type: BuilderValueType = 'string'): string | null {
  const v = value.trim();
  if (type === 'number') return NUMBER_RE.test(v) ? v : null;
  if (type === 'boolean') return v === 'true' || v === 'false' ? v : null;
  return liquidString(value);
}

export interface BuilderCondition {
  readonly field: string;
  readonly operator: BuilderOperator;
  readonly value?: string;
  /** Defaults to number for ordering operators, string otherwise. */
  readonly valueType?: BuilderValueType;
}

export function conditionSource(condition: BuilderCondition): string | null {
  const { operator } = condition;
  if (operator === 'has_tag') {
    const tag = (condition.value ?? '').trim();
    return tag === '' ? null : `contact.tags contains ${liquidString(tag)}`;
  }
  const field = condition.field.trim();
  if (!isValidPath(field)) return null;
  if (operator === 'is_empty') return `${field} == blank`;
  if (operator === 'is_not_empty') return `${field} != blank`;
  const ordering =
    operator === 'greater_than' ||
    operator === 'less_than' ||
    operator === 'greater_or_equal' ||
    operator === 'less_or_equal';
  const type = condition.valueType ?? (ordering ? 'number' : 'string');
  const literal = liquidLiteral(condition.value ?? '', type);
  const comparator = COMPARATORS[operator];
  if (literal === null || comparator === undefined) return null;
  return `${field} ${comparator} ${literal}`;
}

export interface BuilderBranch {
  readonly conditions: readonly BuilderCondition[];
  /** Liquid evaluates and/or right to left without parentheses: one join per branch. */
  readonly join: 'and' | 'or';
  readonly body: string;
}

/** `{% if %}…{% elsif %}…{% else %}…{% endif %}`. */
export function ifElseBlock(input: {
  readonly branches: readonly BuilderBranch[];
  readonly elseBody?: string | null;
}): string | null {
  if (input.branches.length === 0) return null;
  const parts: string[] = [];
  for (const [index, branch] of input.branches.entries()) {
    if (branch.conditions.length === 0) return null;
    const sources = branch.conditions.map(conditionSource);
    if (sources.some((s) => s === null)) return null;
    parts.push(`{% ${index === 0 ? 'if' : 'elsif'} ${sources.join(` ${branch.join} `)} %}`);
    parts.push(branch.body);
  }
  if (input.elseBody !== undefined && input.elseBody !== null && input.elseBody !== '') {
    parts.push('{% else %}', input.elseBody);
  }
  parts.push('{% endif %}');
  return parts.join('');
}

/** `{{ path | filter | default: "fallback" }}`; `now` becomes the `"now"` literal. */
export function fallbackExpression(input: {
  readonly path: string;
  readonly fallback?: string | null;
  readonly filters?: readonly string[];
}): string | null {
  const subject = input.path === 'now' ? '"now"' : input.path;
  if (input.path !== 'now' && !isValidPath(input.path)) return null;
  const parts = [subject];
  for (const filter of input.filters ?? []) {
    if (!isValidFilter(filter)) return null;
    parts.push(filter.trim());
  }
  if (input.fallback !== undefined && input.fallback !== null && input.fallback !== '') {
    parts.push(`default: ${liquidString(input.fallback)}`);
  }
  return `{{ ${parts.join(' | ')} }}`;
}

export interface DateFormatPreset {
  readonly id: string;
  readonly format: string;
}

/** strftime formats offered by the date builder (month and day names are in English). */
export const DATE_FORMAT_PRESETS: readonly DateFormatPreset[] = [
  { id: 'day_month_year', format: '%d/%m/%Y' },
  { id: 'month_day_year', format: '%m/%d/%Y' },
  { id: 'iso', format: '%Y-%m-%d' },
  { id: 'long', format: '%-d %B %Y' },
  { id: 'weekday', format: '%A %-d %B' },
  { id: 'date_time', format: '%d/%m/%Y %H:%M' },
  { id: 'time', format: '%H:%M' },
  { id: 'year', format: '%Y' },
];

export type DateTimezone =
  | { readonly kind: 'default' }
  | { readonly kind: 'contact' }
  | { readonly kind: 'fixed'; readonly zone: string };

/**
 * `{{ path | date: "<format>"[, zone] }}`. The contact option passes
 * `contact.time_zone`; contacts without one fall back to the sending default (the tenant timezone).
 */
export function dateExpression(input: {
  readonly path: string;
  readonly format: string;
  readonly timezone?: DateTimezone;
  readonly fallback?: string | null;
}): string | null {
  const format = input.format.trim();
  if (format === '' || /["{}\r\n]/.test(format)) return null;
  const tz = input.timezone ?? { kind: 'default' };
  let zone = '';
  if (tz.kind === 'contact') zone = ', contact.time_zone';
  if (tz.kind === 'fixed') {
    if (!ZONE_RE.test(tz.zone)) return null;
    zone = `, "${tz.zone}"`;
  }
  const subject = input.path === 'now' ? '"now"' : input.path;
  if (input.path !== 'now' && !isValidPath(input.path)) return null;
  const fallback =
    input.fallback !== undefined && input.fallback !== null && input.fallback !== ''
      ? ` | default: ${liquidString(input.fallback)}`
      : '';
  return `{{ ${subject} | date: "${format}"${zone}${fallback} }}`;
}

/** `{% if contact.tags contains "VIP" %}` (or `unless` when negated). */
export function hasTagBlock(input: {
  readonly tag: string;
  readonly negate?: boolean;
  readonly body: string;
  readonly elseBody?: string | null;
}): string | null {
  const tag = input.tag.trim();
  if (tag === '') return null;
  const keyword = input.negate === true ? 'unless' : 'if';
  const otherwise =
    input.elseBody !== undefined && input.elseBody !== null && input.elseBody !== ''
      ? `{% else %}${input.elseBody}`
      : '';
  return `{% ${keyword} contact.tags contains ${liquidString(tag)} %}${input.body}${otherwise}{% end${keyword} %}`;
}

/** `{% for item in collection limit: n %}…{% else %}…{% endfor %}`. */
export function loopBlock(input: {
  readonly collection: string;
  readonly item: string;
  readonly limit?: number | null;
  readonly offset?: number | null;
  readonly body: string;
  readonly separator?: string | null;
  readonly emptyBody?: string | null;
}): string | null {
  if (!isValidPath(input.collection) || !IDENT_RE.test(input.item)) return null;
  const params: string[] = [];
  for (const [name, value] of [
    ['limit', input.limit],
    ['offset', input.offset],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 0 || value > 1000) return null;
    params.push(`${name}: ${String(value)}`);
  }
  const head = [`${input.item} in ${input.collection}`, ...params].join(' ');
  const separator =
    input.separator !== undefined && input.separator !== null && input.separator !== ''
      ? `{% unless forloop.last %}${input.separator}{% endunless %}`
      : '';
  const empty =
    input.emptyBody !== undefined && input.emptyBody !== null && input.emptyBody !== ''
      ? `{% else %}${input.emptyBody}`
      : '';
  return `{% for ${head} %}${input.body}${separator}${empty}{% endfor %}`;
}

export interface CaseWhen {
  readonly values: readonly string[];
  readonly body: string;
}

/** `{% case field %}{% when "a", "b" %}…{% else %}…{% endcase %}`. */
export function caseBlock(input: {
  readonly field: string;
  readonly whens: readonly CaseWhen[];
  readonly elseBody?: string | null;
  readonly valueType?: BuilderValueType;
}): string | null {
  if (!isValidPath(input.field) || input.whens.length === 0) return null;
  const parts = [`{% case ${input.field} %}`];
  for (const when of input.whens) {
    const values = when.values.map((v) => v.trim()).filter((v) => v !== '');
    if (values.length === 0) return null;
    const literals = values.map((v) => liquidLiteral(v, input.valueType ?? 'string'));
    if (literals.some((l) => l === null)) return null;
    parts.push(`{% when ${literals.join(', ')} %}`, when.body);
  }
  if (input.elseBody !== undefined && input.elseBody !== null && input.elseBody !== '') {
    parts.push('{% else %}', input.elseBody);
  }
  parts.push('{% endcase %}');
  return parts.join('');
}

/** Splits `a | b: "x|y" | c` on pipes outside string literals. */
function splitPipes(source: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of source) {
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === '|') {
      out.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current.trim());
  return out;
}

/**
 * Reads back a simple output tag (`{{ path | filter | default: "x" }}`, at most
 * one filter besides `default`) into variable chip attributes; anything more
 * complex returns null and is inserted as a raw Liquid block instead.
 */
export function parseVariableExpression(
  code: string,
): { path: string; filter: string | null; fallback: string | null } | null {
  const match = /^\{\{-?\s*([\s\S]*?)\s*-?\}\}$/.exec(code.trim());
  if (match === null || match[1] === undefined) return null;
  const [subject = '', ...filters] = splitPipes(match[1]);
  const path = subject === '"now"' || subject === "'now'" ? 'now' : subject;
  if (path !== 'now' && !isValidPath(path)) return null;
  let fallback: string | null = null;
  const last = filters.at(-1);
  const defaultMatch = last === undefined ? null : /^default:\s*("([^"]*)"|'([^']*)')$/.exec(last);
  if (defaultMatch !== null) {
    fallback = defaultMatch[2] ?? defaultMatch[3] ?? '';
    filters.pop();
  }
  if (filters.length > 1) return null;
  const filter = filters[0] ?? null;
  if (filter !== null && !isValidFilter(filter)) return null;
  return { path, filter, fallback };
}

import type { ConditionOperator, LiquidConditionAttrs, LiquidVariableAttrs } from './schema';

/**
 * Builders that turn node attributes into Liquid source. Documents can arrive
 * through the API, so every attribute is treated as untrusted: anything that
 * does not match the expected shape is dropped rather than interpolated.
 * The Liquid sandbox (see `liquid.ts`) remains the real security boundary.
 */

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const FILTER_RE =
  /^[a-z_]+(:\s*("[^"{}]*"|'[^'{}]*'|-?[0-9]+(\.[0-9]+)?)(\s*,\s*("[^"{}]*"|'[^'{}]*'|-?[0-9]+(\.[0-9]+)?))*)?$/;
const NUMBER_RE = /^-?[0-9]+(\.[0-9]+)?$/;

export function isValidPath(path: string): boolean {
  return PATH_RE.test(path);
}

export function isValidFilter(filter: string): boolean {
  return FILTER_RE.test(filter.trim());
}

/**
 * Liquid string literals have no escape sequences, so the quote character is
 * chosen to fit the value and delimiter sequences are removed.
 */
export function liquidString(value: string): string {
  const cleaned = value.replace(/\{\{|\}\}|\{%|%\}/g, '').replace(/[\r\n]+/g, ' ');
  if (!cleaned.includes('"')) return `"${cleaned}"`;
  if (!cleaned.includes("'")) return `'${cleaned}'`;
  return `"${cleaned.replace(/"/g, '')}"`;
}

/** `{{ contact.first_name | default: "there" }}` from a variable chip's attributes. */
export function variableExpression(
  attrs: Pick<LiquidVariableAttrs, 'path' | 'fallback' | 'filter'>,
): string | null {
  if (attrs.path !== 'now' && !isValidPath(attrs.path)) return null;
  const subject = attrs.path === 'now' ? '"now"' : attrs.path;
  const parts = [subject];
  if (attrs.filter && isValidFilter(attrs.filter)) parts.push(attrs.filter.trim());
  if (attrs.fallback !== null && attrs.fallback !== '')
    parts.push(`default: ${liquidString(attrs.fallback)}`);
  return `{{ ${parts.join(' | ')} }}`;
}

function literal(value: string | null): string {
  const v = (value ?? '').trim();
  return NUMBER_RE.test(v) ? v : liquidString(v);
}

const OPERATOR_SOURCE: Record<Exclude<ConditionOperator, 'is_blank' | 'is_present'>, string> = {
  equals: '==',
  not_equals: '!=',
  contains: 'contains',
  greater_than: '>',
  less_than: '<',
};

/** The condition inside `{% if … %}`, or null when the attributes are unusable. */
export function conditionExpression(attrs: LiquidConditionAttrs): string | null {
  switch (attrs.kind) {
    case 'tag': {
      const tag = (attrs.tag ?? '').trim();
      if (tag === '') return null;
      return `contact.tags contains ${liquidString(tag)}`;
    }
    case 'field': {
      const field = (attrs.field ?? '').trim();
      if (!isValidPath(field)) return null;
      if (attrs.operator === 'is_blank') return `${field} == blank`;
      if (attrs.operator === 'is_present') return `${field} != blank`;
      return `${field} ${OPERATOR_SOURCE[attrs.operator]} ${literal(attrs.value)}`;
    }
    case 'expression': {
      const expression = (attrs.expression ?? '').trim();
      if (expression === '' || /%\}|\{%|\{\{|\}\}/.test(expression)) return null;
      return expression;
    }
  }
}

/** Opening tag for a condition block; tag conditions can be negated with `unless`. */
export function conditionOpenTag(attrs: LiquidConditionAttrs): string | null {
  const expression = conditionExpression(attrs);
  if (expression === null) return null;
  return attrs.negate ? `{% unless ${expression} %}` : `{% if ${expression} %}`;
}

export function conditionCloseTag(attrs: LiquidConditionAttrs): string {
  return attrs.negate ? '{% endunless %}' : '{% endif %}';
}

/** True when the text would be parsed as Liquid if emitted verbatim. */
export function containsLiquidDelimiters(text: string): boolean {
  return /\{\{|\{%/.test(text);
}

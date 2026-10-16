/** Maximum number of custom parameters attached to a goal. */
export const MAX_GOAL_PARAMS = 10;
/** Maximum length of a parameter value (after sanitizing). */
export const MAX_VALUE_LENGTH = 255;
/** Maximum length of goal names and parameter keys. */
export const MAX_NAME_LENGTH = 64;

const GOAL_ATTR = 'data-amable-goal';
const GOAL_PARAM_PREFIX = `${GOAL_ATTR}-`;

export type Params = Record<string, string>;

/** Strips control characters and angle brackets, trims, caps at 255 characters. */
export function sanitizeValue(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, MAX_VALUE_LENGTH);
}

/**
 * Normalizes a goal name or parameter key: lowercase, spaces and dashes to `_`,
 * only `[a-z0-9_]`, at most 64 characters. Returns '' when nothing valid is left.
 */
export function sanitizeName(name: unknown): string {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, MAX_NAME_LENGTH);
}

/** Sanitizes a params object: at most 10 non-empty keys, string values. */
export function sanitizeParams(input: unknown): Params | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const out: Params = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_GOAL_PARAMS) break;
    if (rawValue === undefined || rawValue === null || typeof rawValue === 'object') continue;
    const key = sanitizeName(rawKey);
    if (key === '' || key in out) continue;
    out[key] = sanitizeValue(rawValue);
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/** Reads `data-amable-goal-*` attributes of an element as goal params. */
export function goalParamsOf(el: Element): Params | undefined {
  const raw: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith(GOAL_PARAM_PREFIX)) {
      raw[attr.name.slice(GOAL_PARAM_PREFIX.length)] = attr.value;
    }
  }
  return sanitizeParams(raw);
}

export interface GoalSpec {
  name: string;
  params?: Params;
}

/** Goal declared on an element through `data-amable-goal="name"` (+ params). */
export function goalOf(el: Element, attr = GOAL_ATTR): GoalSpec | undefined {
  const name = sanitizeName(el.getAttribute(attr) ?? '');
  if (name === '') return undefined;
  const params = goalParamsOf(el);
  return params === undefined ? { name } : { name, params };
}

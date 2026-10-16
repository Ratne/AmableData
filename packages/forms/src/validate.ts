import { collectsValue, OPTION_KINDS } from './constants';
import type { FormField, SubmissionValue, SubmissionValues, VisibilityRule } from './schema';

/**
 * Validation shared by the widget (inline errors) and the server (source of
 * truth): visibility rules, required fields, formats and option membership.
 * Values of hidden-by-condition fields are dropped, never validated.
 */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Same rule as the CRM contact phone (`+`, digits, spaces, `().-`). */
export const PHONE_RE = /^\+?[0-9 ().-]{3,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type FieldErrorCode =
  | 'required'
  | 'invalid_email'
  | 'invalid_phone'
  | 'invalid_number'
  | 'too_small'
  | 'too_large'
  | 'too_long'
  | 'invalid_date'
  | 'invalid_option'
  | 'invalid_value';

export type FieldErrors = Record<string, FieldErrorCode>;

export type ValidationResult =
  | { ok: true; values: SubmissionValues }
  | { ok: false; errors: FieldErrors };

type RawValues = Readonly<Record<string, unknown>>;

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(String).join(',');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export function isFilled(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function ruleHolds(rule: VisibilityRule, value: unknown): boolean {
  switch (rule.op) {
    case 'filled':
      return isFilled(value);
    case 'empty':
      return !isFilled(value);
    case 'equals':
      return asText(value) === rule.value;
    case 'not_equals':
      return asText(value) !== rule.value;
    case 'contains':
      return Array.isArray(value)
        ? value.map(String).includes(rule.value)
        : asText(value).toLowerCase().includes(rule.value.toLowerCase());
    case 'any_of': {
      const options = rule.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      return Array.isArray(value)
        ? value.map(String).some((v) => options.includes(v))
        : options.includes(asText(value));
    }
  }
}

/**
 * Whether a field is shown. A field depending on a hidden field is hidden too
 * (rules see only the values of visible fields).
 */
export function visibleFieldKeys(fields: readonly FormField[], values: RawValues): Set<string> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const memo = new Map<string, boolean>();
  const visit = (field: FormField, depth: number): boolean => {
    const cached = memo.get(field.key);
    if (cached !== undefined) return cached;
    if (depth > fields.length) return false;
    const visible = field.visible_if.every((rule) => {
      const source = byKey.get(rule.field_key);
      if (source === undefined) return false;
      const sourceValue = visit(source, depth + 1) ? values[rule.field_key] : undefined;
      return ruleHolds(rule, sourceValue);
    });
    memo.set(field.key, visible);
    return visible;
  };
  const out = new Set<string>();
  for (const field of fields) if (visit(field, 0)) out.add(field.key);
  return out;
}

export function isFieldVisible(field: FormField, fields: readonly FormField[], values: RawValues): boolean {
  return visibleFieldKeys(fields, values).has(field.key);
}

function defaultMaxLength(field: FormField): number {
  if (field.max_length !== undefined) return field.max_length;
  return field.kind === 'textarea' ? 5000 : field.kind === 'hidden' ? 1000 : 255;
}

/** Normalizes one value; `null` means "not provided". */
function checkValue(
  field: FormField,
  raw: unknown,
): { value: SubmissionValue | null } | { error: FieldErrorCode } {
  switch (field.kind) {
    case 'checkbox':
    case 'consent': {
      const checked = raw === true || raw === 'true' || raw === 'on' || raw === '1' || raw === 1;
      return { value: checked ? true : null };
    }
    case 'multicheck': {
      const list = Array.isArray(raw) ? raw.map(String) : isFilled(raw) ? asText(raw).split(',') : [];
      const allowed = new Set(field.options.map((o) => o.value));
      const picked = [...new Set(list.map((v) => v.trim()).filter((v) => v !== ''))];
      if (picked.some((v) => !allowed.has(v))) return { error: 'invalid_option' };
      return { value: picked.length === 0 ? null : picked };
    }
    case 'number':
    case 'rating': {
      if (!isFilled(raw)) return { value: null };
      const n = typeof raw === 'number' ? raw : Number(asText(raw).trim().replace(',', '.'));
      if (!Number.isFinite(n)) return { error: 'invalid_number' };
      if (field.kind === 'rating') {
        if (!Number.isInteger(n) || n < 1 || n > field.max_rating) return { error: 'invalid_value' };
        return { value: n };
      }
      if (field.min !== undefined && n < field.min) return { error: 'too_small' };
      if (field.max !== undefined && n > field.max) return { error: 'too_large' };
      return { value: n };
    }
    default:
      break;
  }
  if (typeof raw !== 'string' && typeof raw !== 'number' && raw !== null && raw !== undefined) {
    return { error: 'invalid_value' };
  }
  const text = asText(raw).trim();
  if (text === '') return { value: null };
  if (text.length > defaultMaxLength(field)) return { error: 'too_long' };
  switch (field.kind) {
    case 'email':
      return EMAIL_RE.test(text) && text.length <= 254 ? { value: text } : { error: 'invalid_email' };
    case 'phone':
      return PHONE_RE.test(text) && /\d{3,}/.test(text.replace(/\D/g, ''))
        ? { value: text }
        : { error: 'invalid_phone' };
    case 'date':
      return DATE_RE.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`))
        ? { value: text }
        : { error: 'invalid_date' };
    default:
      if (OPTION_KINDS.has(field.kind) && !field.options.some((o) => o.value === text)) {
        return { error: 'invalid_option' };
      }
      return { value: text };
  }
}

/**
 * Validates submitted values against the form fields. Returns the cleaned
 * values of visible, value-collecting fields only (unknown keys are dropped).
 */
export function validateSubmission(
  form: { readonly fields: readonly FormField[] },
  values: RawValues,
): ValidationResult {
  const visible = visibleFieldKeys(form.fields, values);
  const errors: FieldErrors = {};
  const clean: SubmissionValues = {};
  for (const field of form.fields) {
    if (!collectsValue(field.kind) || !visible.has(field.key)) continue;
    const result = checkValue(field, values[field.key]);
    if ('error' in result) {
      errors[field.key] = result.error;
      continue;
    }
    if (result.value === null) {
      if (field.required && field.kind !== 'hidden') errors[field.key] = 'required';
      continue;
    }
    clean[field.key] = result.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values: clean };
}

/** Human readable value for notifications, sheets and event payloads. */
export function displayValue(field: FormField | undefined, value: SubmissionValue): string {
  if (Array.isArray(value)) {
    return value
      .map((v) => field?.options.find((o) => o.value === v)?.label ?? v)
      .join(', ');
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (field !== undefined && OPTION_KINDS.has(field.kind)) {
    return field.options.find((o) => o.value === value)?.label ?? String(value);
  }
  return String(value);
}

/** Splits fields into steps at every `page_break`. */
export function splitSteps(fields: readonly FormField[]): Array<{ title: string; fields: FormField[] }> {
  const steps: Array<{ title: string; fields: FormField[] }> = [{ title: '', fields: [] }];
  for (const field of fields) {
    if (field.kind === 'page_break') {
      steps.push({ title: field.label, fields: [] });
      continue;
    }
    steps[steps.length - 1]?.fields.push(field);
  }
  const filled = steps.filter((step) => step.fields.length > 0);
  return filled.length > 0 ? filled : [{ title: '', fields: [] }];
}

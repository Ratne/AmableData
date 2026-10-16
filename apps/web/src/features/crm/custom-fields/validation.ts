import type {
  CustomField,
  CustomFieldOption,
  CustomFieldType,
  CustomFieldValueInput,
} from '@amable/api-types/crm';

/**
 * Client-side check of a custom field value before it is sent, mirroring the
 * server normalizer (the server stays authoritative). Inputs are what the
 * field widgets produce: strings from text inputs, string arrays from list
 * pickers, booleans from YES_NO. Empty input clears the value (`null`).
 */

export type FieldDefinition = Pick<CustomField, 'key' | 'type' | 'options' | 'config' | 'required'>;

export type ValidationErrorCode =
  | 'required'
  | 'tooLong'
  | 'email'
  | 'phone'
  | 'url'
  | 'ssnUs'
  | 'ssnGeneric'
  | 'state'
  | 'option'
  | 'number'
  | 'decimals'
  | 'min'
  | 'max'
  | 'percent'
  | 'wholeNumber'
  | 'year'
  | 'dayOfWeek'
  | 'month'
  | 'boolean'
  | 'date'
  | 'dateTime'
  | 'drilldown'
  | 'user';

export type ValidationResult =
  | { readonly ok: true; readonly value: CustomFieldValueInput }
  | {
      readonly ok: false;
      readonly error: ValidationErrorCode;
      readonly vars?: Readonly<Record<string, string | number>>;
    };

export type WidgetValue = string | boolean | readonly string[] | null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const STATE_RE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const US_SSN_RE = /^(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}$/;
const GENERIC_ID_RE = /^[A-Z0-9][A-Z0-9 -]{3,30}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const ok = (value: CustomFieldValueInput): ValidationResult => ({ ok: true, value });
const fail = (
  error: ValidationErrorCode,
  vars?: Readonly<Record<string, string | number>>,
): ValidationResult => (vars === undefined ? { ok: false, error } : { ok: false, error, vars });

export function isValidDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

function parseNumber(text: string): number | null {
  const compact = text.replace(/\s/g, '');
  if (!/^[-+]?(\d+([.,]\d+)?|[.,]\d+)$/.test(compact)) return null;
  return Number(compact.replace(',', '.'));
}

function decimalsOf(text: string): number {
  const part = text.replace(/\s/g, '').split(/[.,]/)[1];
  return part?.length ?? 0;
}

function isEmpty(value: WidgetValue): boolean {
  if (value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'boolean') return false;
  return value.length === 0;
}

function hasOption(options: readonly CustomFieldOption[], value: string): boolean {
  return options.some((option) => option.value === value);
}

function drilldownValid(options: readonly CustomFieldOption[], path: readonly string[]): boolean {
  let level: ReadonlyArray<{ value: string; children?: ReadonlyArray<{ value: string }> }> =
    options;
  for (const step of path) {
    const match = level.find((option) => option.value === step);
    if (match === undefined) return false;
    level = (match.children ?? []) as typeof level;
  }
  return true;
}

function checkRange(n: number, field: FieldDefinition): ValidationResult | null {
  const { min, max } = field.config;
  if (min !== undefined && n < min) return fail('min', { min });
  if (max !== undefined && n > max) return fail('max', { max });
  return null;
}

/** Number types share decimals and range checks. */
function validateDecimal(type: CustomFieldType, text: string, field: FieldDefinition) {
  const n = parseNumber(text);
  if (n === null) return fail('number');
  const maxDecimals = field.config.decimals ?? (type === 'DECIMAL_NUMBER' ? 6 : 2);
  if (decimalsOf(text) > maxDecimals) return fail('decimals', { count: maxDecimals });
  if (type === 'PERCENT' && field.config.min === undefined && field.config.max === undefined) {
    if (n < 0 || n > 100) return fail('percent');
  }
  return checkRange(n, field) ?? ok(n);
}

export function validateCustomFieldValue(
  field: FieldDefinition,
  input: WidgetValue,
): ValidationResult {
  if (isEmpty(input)) return field.required ? fail('required') : ok(null);
  const text = typeof input === 'string' ? input.trim() : '';
  const list = Array.isArray(input) ? (input as readonly string[]) : [];

  switch (field.type) {
    case 'TEXT':
    case 'TEXT_AREA':
    case 'NAME': {
      const max = field.config.max_length ?? (field.type === 'TEXT_AREA' ? 10_000 : 255);
      return text.length > max ? fail('tooLong', { max }) : ok(text);
    }
    case 'EMAIL':
      return text.length <= 254 && EMAIL_RE.test(text) ? ok(text.toLowerCase()) : fail('email');
    case 'PHONE_NUMBER': {
      const digits = text.replace(/\D/g, '').length;
      return /^\+?[0-9 ().-]+$/.test(text) && digits >= 5 && digits <= 20
        ? ok(text)
        : fail('phone');
    }
    case 'WEBSITE': {
      const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
      try {
        const url = new URL(candidate);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.'))
          return candidate.length <= 2048 ? ok(candidate) : fail('tooLong', { max: 2048 });
      } catch {
        // fall through
      }
      return fail('url');
    }
    case 'SOCIAL_SECURITY_NUMBER': {
      const upper = text.toUpperCase();
      if (field.config.format === 'us_ssn') {
        const digits = upper.replace(/\D/g, '');
        const formatted =
          digits.length === 9
            ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
            : upper;
        return US_SSN_RE.test(formatted) ? ok(formatted) : fail('ssnUs');
      }
      return GENERIC_ID_RE.test(upper) ? ok(upper) : fail('ssnGeneric');
    }
    case 'STATE': {
      const upper = text.toUpperCase();
      return STATE_RE.test(upper) ? ok(upper) : fail('state');
    }
    case 'USER':
      return USER_ID_RE.test(text) ? ok(text) : fail('user');
    case 'DROPDOWN':
    case 'RADIO':
      return hasOption(field.options, text) ? ok(text) : fail('option');
    case 'LIST_BOX': {
      const unique = [...new Set(list)];
      return unique.every((value) => hasOption(field.options, value)) ? ok(unique) : fail('option');
    }
    case 'USER_LIST_BOX': {
      const unique = [...new Set(list)];
      return unique.every((value) => USER_ID_RE.test(value)) ? ok(unique) : fail('user');
    }
    case 'DRILLDOWN': {
      const path = list.filter((step) => step !== '');
      if (path.length === 0) return field.required ? fail('required') : ok(null);
      return path.length <= 3 && drilldownValid(field.options, path) ? ok(path) : fail('drilldown');
    }
    case 'CURRENCY':
    case 'DECIMAL_NUMBER':
    case 'PERCENT':
      return validateDecimal(field.type, text, field);
    case 'WHOLE_NUMBER': {
      const n = parseNumber(text);
      if (n === null || !Number.isSafeInteger(n)) return fail('wholeNumber');
      return checkRange(n, field) ?? ok(n);
    }
    case 'YEAR': {
      const n = parseNumber(text);
      return n !== null && Number.isInteger(n) && n >= 1000 && n <= 9999 ? ok(n) : fail('year');
    }
    case 'DAY_OF_WEEK': {
      const n = Number(text);
      return Number.isInteger(n) && n >= 1 && n <= 7 ? ok(n) : fail('dayOfWeek');
    }
    case 'MONTH': {
      const n = Number(text);
      return Number.isInteger(n) && n >= 1 && n <= 12 ? ok(n) : fail('month');
    }
    case 'YES_NO':
      if (typeof input === 'boolean') return ok(input);
      if (text === 'true') return ok(true);
      if (text === 'false') return ok(false);
      return fail('boolean');
    case 'DATE':
      return isValidDate(text) ? ok(text) : fail('date');
    case 'DATE_TIME': {
      if (!DATE_TIME_RE.test(text) || Number.isNaN(Date.parse(text))) return fail('dateTime');
      return ok(new Date(text).toISOString());
    }
  }
}

/** Widget value of a stored API value (the inverse of the normalization above). */
export function toWidgetValue(
  type: CustomFieldType,
  value: CustomFieldValueInput | undefined,
): WidgetValue {
  if (value === undefined || value === null) {
    return type === 'LIST_BOX' || type === 'USER_LIST_BOX' || type === 'DRILLDOWN' ? [] : null;
  }
  if (Array.isArray(value)) return value;
  if (typeof value === 'boolean') return type === 'YES_NO' ? value : String(value);
  return String(value);
}

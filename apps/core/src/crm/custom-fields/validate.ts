import {
  OPTION_FIELD_TYPES,
  type CustomFieldConfig,
  type CustomFieldOption,
  type CustomFieldType,
  type CustomFieldValueInput,
} from '@amable/api-types';

/** What the validator needs to know about a field definition. */
export interface FieldDefinition {
  key: string;
  type: CustomFieldType;
  options: CustomFieldOption[];
  config: CustomFieldConfig;
}

/** Storage columns of crm_custom_field_values plus the API representation. */
export interface StoredValue {
  text: string | null;
  number: number | null;
  json: string | null;
  api: string | number | boolean | string[];
}

export type NormalizeResult =
  { ok: true; value: StoredValue | null } | { ok: false; error: string };

export interface NormalizeOptions {
  /**
   * Values coming from text sources (CSV cells): numbers, booleans and lists
   * arrive as strings and are coerced. Multi values split on `listDelimiter`.
   */
  lenient?: boolean;
  listDelimiter?: string;
}

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const STATE_RE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const US_SSN_RE = /^(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}$/;
const GENERIC_ID_RE = /^[A-Z0-9][A-Z0-9 -]{3,30}$/;

const ok = (value: StoredValue | null): NormalizeResult => ({ ok: true, value });
const fail = (error: string): NormalizeResult => ({ ok: false, error });

function scalarText(v: string): StoredValue {
  return { text: v, number: null, json: null, api: v };
}
function scalarNumber(n: number): StoredValue {
  return { text: null, number: n, json: null, api: n };
}

function decimalsOf(n: number): number {
  if (Number.isInteger(n)) return 0;
  const text = String(n);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return text.split('.')[1]?.length ?? 0;
}

function toNumber(raw: CustomFieldValueInput, lenient: boolean): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && (lenient || raw.trim() !== '')) {
    const text = raw.trim().replace(/\s/g, '');
    if (!/^[-+]?(\d+([.,]\d+)?|[.,]\d+)$/.test(text)) return null;
    return Number(text.replace(',', '.'));
  }
  return null;
}

function toText(raw: CustomFieldValueInput, lenient: boolean): string | null {
  if (typeof raw === 'string') return raw.trim();
  if (lenient && (typeof raw === 'number' || typeof raw === 'boolean')) return String(raw);
  return null;
}

function toList(raw: CustomFieldValueInput, options: NormalizeOptions): string[] | null {
  if (Array.isArray(raw)) return raw.map((v) => v.trim()).filter((v) => v !== '');
  if (typeof raw === 'string' && options.lenient === true) {
    return raw
      .split(options.listDelimiter ?? ';')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  return null;
}

function isValidDate(text: string): boolean {
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

function checkRange(n: number, config: CustomFieldConfig): string | null {
  if (config.min !== undefined && n < config.min) return `must be >= ${config.min}`;
  if (config.max !== undefined && n > config.max) return `must be <= ${config.max}`;
  return null;
}

function optionValues(options: CustomFieldOption[]): Set<string> {
  return new Set(options.map((o) => o.value));
}

/** Resolves a DRILLDOWN path (values or labels, case-insensitive) against the tree. */
function resolveDrilldown(options: CustomFieldOption[], path: string[]): string[] | null {
  let level: Array<{ value: string; label: string; children?: unknown }> = options;
  const resolved: string[] = [];
  for (const step of path) {
    const lower = step.toLowerCase();
    const match = level.find(
      (o) => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower,
    );
    if (match === undefined) return null;
    resolved.push(match.value);
    level = Array.isArray(match.children)
      ? (match.children as Array<{ value: string; label: string; children?: unknown }>)
      : [];
  }
  return resolved;
}

function matchOption(options: CustomFieldOption[], text: string): string | null {
  const exact = options.find((o) => o.value === text);
  if (exact !== undefined) return exact.value;
  const lower = text.toLowerCase();
  const loose = options.find(
    (o) => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower,
  );
  return loose?.value ?? null;
}

/**
 * Validates and normalizes a raw custom field value for storage.
 * `null` (and, in lenient mode, an empty string) clears the value.
 */
export function normalizeCustomFieldValue(
  def: FieldDefinition,
  raw: CustomFieldValueInput,
  options: NormalizeOptions = {},
): NormalizeResult {
  const lenient = options.lenient === true;
  if (raw === null) return ok(null);
  if (typeof raw === 'string' && raw.trim() === '' && (lenient || def.type !== 'TEXT')) {
    return ok(null);
  }
  const config = def.config;

  switch (def.type) {
    case 'TEXT':
    case 'TEXT_AREA':
    case 'NAME': {
      const text = toText(raw, lenient);
      if (text === null) return fail('expected a string');
      const max = config.max_length ?? (def.type === 'TEXT_AREA' ? 10_000 : 255);
      if (text.length > max) return fail(`must be at most ${max} characters`);
      return ok(text === '' ? null : scalarText(text));
    }
    case 'EMAIL': {
      const text = toText(raw, lenient);
      if (text === null || text.length > 254 || !EMAIL_RE.test(text)) {
        return fail('expected a valid email address');
      }
      return ok(scalarText(text.toLowerCase()));
    }
    case 'PHONE_NUMBER': {
      const text = toText(raw, lenient);
      if (text === null || !/^\+?[0-9 ().-]+$/.test(text)) return fail('expected a phone number');
      const digits = text.replace(/\D/g, '').length;
      if (digits < 5 || digits > 20) return fail('phone number must have 5-20 digits');
      return ok(scalarText(text));
    }
    case 'WEBSITE': {
      const text = toText(raw, lenient);
      if (text === null) return fail('expected a URL');
      const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        return fail('expected a valid URL');
      }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname.includes('.')) {
        return fail('expected an http(s) URL');
      }
      if (candidate.length > 2048) return fail('URL too long');
      return ok(scalarText(candidate));
    }
    case 'SOCIAL_SECURITY_NUMBER': {
      const text = toText(raw, lenient);
      if (text === null) return fail('expected a string');
      const upper = text.toUpperCase();
      if (config.format === 'us_ssn') {
        const digits = upper.replace(/\D/g, '');
        const formatted =
          digits.length === 9
            ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
            : upper;
        if (!US_SSN_RE.test(formatted)) return fail('expected NNN-NN-NNNN');
        return ok(scalarText(formatted));
      }
      if (!GENERIC_ID_RE.test(upper))
        return fail('expected 4-31 letters, digits, spaces or dashes');
      return ok(scalarText(upper));
    }
    case 'STATE': {
      const text = toText(raw, lenient);
      if (text === null) return fail('expected an ISO 3166-2 code');
      const upper = text.toUpperCase();
      if (!STATE_RE.test(upper)) return fail('expected an ISO 3166-2 code like IT-MI');
      return ok(scalarText(upper));
    }
    case 'USER': {
      const text = toText(raw, lenient);
      if (text === null || !USER_ID_RE.test(text)) return fail('expected a user id');
      return ok(scalarText(text));
    }
    case 'DROPDOWN':
    case 'RADIO': {
      const text = toText(raw, lenient);
      if (text === null) return fail('expected one of the field options');
      const value = matchOption(def.options, text);
      if (value === null) return fail(`"${text}" is not an option of ${def.key}`);
      return ok(scalarText(value));
    }
    case 'LIST_BOX':
    case 'USER_LIST_BOX': {
      const list = toList(raw, options);
      if (list === null) return fail('expected an array of strings');
      const values: string[] = [];
      for (const item of list) {
        if (def.type === 'LIST_BOX') {
          const value = matchOption(def.options, item);
          if (value === null) return fail(`"${item}" is not an option of ${def.key}`);
          values.push(value);
        } else {
          if (!USER_ID_RE.test(item)) return fail(`"${item}" is not a user id`);
          values.push(item);
        }
      }
      const unique = [...new Set(values)];
      if (unique.length === 0) return ok(null);
      if (unique.length > 200) return fail('at most 200 values');
      return ok({
        text: unique.join(', '),
        number: null,
        json: JSON.stringify(unique),
        api: unique,
      });
    }
    case 'DRILLDOWN': {
      const path =
        Array.isArray(raw) || !lenient
          ? toList(raw, options)
          : toList(raw, { lenient: true, listDelimiter: '>' });
      if (path === null || path.length === 0 || path.length > 3) {
        return fail('expected a path of 1-3 option values');
      }
      const resolved = resolveDrilldown(def.options, path);
      if (resolved === null) return fail(`"${path.join(' > ')}" is not a path of ${def.key}`);
      return ok({
        text: resolved.join(' > '),
        number: null,
        json: JSON.stringify(resolved),
        api: resolved,
      });
    }
    case 'CURRENCY':
    case 'DECIMAL_NUMBER':
    case 'PERCENT': {
      const n = toNumber(raw, lenient);
      if (n === null) return fail('expected a number');
      const maxDecimals = config.decimals ?? (def.type === 'DECIMAL_NUMBER' ? 6 : 2);
      if (decimalsOf(n) > maxDecimals) return fail(`at most ${maxDecimals} decimal places`);
      if (def.type === 'PERCENT' && config.min === undefined && config.max === undefined) {
        if (n < 0 || n > 100) return fail('must be between 0 and 100');
      }
      const range = checkRange(n, config);
      if (range !== null) return fail(range);
      return ok(scalarNumber(n));
    }
    case 'WHOLE_NUMBER': {
      const n = toNumber(raw, lenient);
      if (n === null || !Number.isSafeInteger(n)) return fail('expected a whole number');
      const range = checkRange(n, config);
      if (range !== null) return fail(range);
      return ok(scalarNumber(n));
    }
    case 'YEAR': {
      const n = toNumber(raw, lenient);
      if (n === null || !Number.isInteger(n) || n < 1000 || n > 9999) {
        return fail('expected a 4-digit year');
      }
      return ok(scalarNumber(n));
    }
    case 'DAY_OF_WEEK': {
      if (typeof raw === 'string' && !/^\d+$/.test(raw.trim())) {
        const index = DAY_NAMES.findIndex((d) => d.startsWith(raw.trim().toLowerCase()));
        if (index === -1 || raw.trim().length < 3) return fail('expected a day of the week');
        return ok(scalarNumber(index + 1));
      }
      const n = toNumber(raw, true);
      if (n === null || !Number.isInteger(n) || n < 1 || n > 7) {
        return fail('expected 1 (Monday) - 7 (Sunday)');
      }
      return ok(scalarNumber(n));
    }
    case 'MONTH': {
      if (typeof raw === 'string' && !/^\d+$/.test(raw.trim())) {
        const index = MONTH_NAMES.findIndex((m) => m.startsWith(raw.trim().toLowerCase()));
        if (index === -1 || raw.trim().length < 3) return fail('expected a month');
        return ok(scalarNumber(index + 1));
      }
      const n = toNumber(raw, true);
      if (n === null || !Number.isInteger(n) || n < 1 || n > 12) return fail('expected 1-12');
      return ok(scalarNumber(n));
    }
    case 'YES_NO': {
      if (typeof raw === 'boolean')
        return ok({ text: null, number: raw ? 1 : 0, json: null, api: raw });
      if (lenient || typeof raw === 'string' || typeof raw === 'number') {
        const text = String(raw).trim().toLowerCase();
        if (['true', 'yes', 'y', '1', 'si', 'sì'].includes(text)) {
          return ok({ text: null, number: 1, json: null, api: true });
        }
        if (['false', 'no', 'n', '0'].includes(text)) {
          return ok({ text: null, number: 0, json: null, api: false });
        }
      }
      return fail('expected true or false');
    }
    case 'DATE': {
      const text = toText(raw, lenient);
      if (text === null || !isValidDate(text)) return fail('expected a date YYYY-MM-DD');
      return ok(scalarText(text));
    }
    case 'DATE_TIME': {
      const text = toText(raw, lenient);
      if (
        text === null ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)
      ) {
        return fail('expected an ISO 8601 date-time with timezone');
      }
      const ms = Date.parse(text);
      if (Number.isNaN(ms)) return fail('expected a valid date-time');
      return ok(scalarText(new Date(ms).toISOString()));
    }
  }
}

/** Reads a stored value back into its API representation. */
export function storedToApi(
  type: CustomFieldType,
  row: { value_text: string | null; value_number: number | null; value_json: string | null },
): string | number | boolean | string[] | null {
  switch (type) {
    case 'LIST_BOX':
    case 'USER_LIST_BOX':
    case 'DRILLDOWN':
      return row.value_json === null ? null : (JSON.parse(row.value_json) as string[]);
    case 'YES_NO':
      return row.value_number === null ? null : row.value_number === 1;
    case 'CURRENCY':
    case 'DECIMAL_NUMBER':
    case 'PERCENT':
    case 'WHOLE_NUMBER':
    case 'YEAR':
    case 'DAY_OF_WEEK':
    case 'MONTH':
      return row.value_number;
    default:
      return row.value_text;
  }
}

/** Masks a sensitive value, keeping the last 4 characters. */
export function maskValue(value: string | number | boolean | string[] | null): string | null {
  if (value === null) return null;
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  const tail = text.length > 4 ? text.slice(-4) : '';
  return `${'*'.repeat(Math.max(text.length - tail.length, 4))}${tail}`;
}

/** Definition-level checks (options required for choice types, coherent config). */
export function validateFieldDefinition(input: {
  type: CustomFieldType;
  options?: CustomFieldOption[] | undefined;
  config?: CustomFieldConfig | undefined;
}): string | null {
  const options = input.options ?? [];
  if (OPTION_FIELD_TYPES.includes(input.type)) {
    if (options.length === 0) return `${input.type} fields need at least one option`;
    const values = optionValues(options);
    if (values.size !== options.length) return 'option values must be unique';
    if (input.type !== 'DRILLDOWN' && options.some((o) => (o.children?.length ?? 0) > 0)) {
      return 'only DRILLDOWN options can have children';
    }
  } else if (options.length > 0) {
    return `${input.type} fields do not take options`;
  }
  const config = input.config ?? {};
  if (config.min !== undefined && config.max !== undefined && config.min > config.max) {
    return 'config.min must be <= config.max';
  }
  if (config.currency !== undefined && input.type !== 'CURRENCY') {
    return 'config.currency only applies to CURRENCY fields';
  }
  if (config.format !== undefined && input.type !== 'SOCIAL_SECURITY_NUMBER') {
    return 'config.format only applies to SOCIAL_SECURITY_NUMBER fields';
  }
  return null;
}

/** Query-builder kind of each field type (decides operators and SQL column). */
export type FieldKind = 'text' | 'number' | 'date' | 'datetime_iso' | 'boolean' | 'enum' | 'multi';

export function kindOfType(type: CustomFieldType): FieldKind {
  switch (type) {
    case 'CURRENCY':
    case 'DECIMAL_NUMBER':
    case 'PERCENT':
    case 'WHOLE_NUMBER':
    case 'YEAR':
    case 'DAY_OF_WEEK':
    case 'MONTH':
      return 'number';
    case 'DATE':
      return 'date';
    case 'DATE_TIME':
      return 'datetime_iso';
    case 'YES_NO':
      return 'boolean';
    case 'DROPDOWN':
    case 'RADIO':
    case 'USER':
    case 'STATE':
      return 'enum';
    case 'LIST_BOX':
    case 'USER_LIST_BOX':
      return 'multi';
    default:
      return 'text';
  }
}

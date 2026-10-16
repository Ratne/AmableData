import { CUSTOM_FIELD_TYPES, type CustomFieldType } from '@amable/api-types/crm';
import { describe, expect, it } from 'vitest';
import {
  toWidgetValue,
  validateCustomFieldValue,
  type FieldDefinition,
  type WidgetValue,
} from '../src/features/crm/custom-fields/validation';

function def(type: CustomFieldType, patch: Partial<FieldDefinition> = {}): FieldDefinition {
  return { key: 'f', type, options: [], config: {}, required: false, ...patch };
}

const OPTIONS = [
  { value: 'pro', label: 'Pro' },
  { value: 'team', label: 'Team' },
];
const TREE = [
  {
    value: 'eu',
    label: 'Europe',
    children: [{ value: 'it', label: 'Italy', children: [{ value: 'mi', label: 'Milan' }] }],
  },
];

/** [type, extra definition, accepted input → normalized value, rejected input → error code] */
const CASES: Array<
  [CustomFieldType, Partial<FieldDefinition>, WidgetValue, unknown, WidgetValue, string]
> = [
  ['TEXT', { config: { max_length: 5 } }, ' hello ', 'hello', 'too long', 'tooLong'],
  ['TEXT_AREA', {}, 'line\nline', 'line\nline', 'x'.repeat(10_001), 'tooLong'],
  ['NAME', {}, 'Ada', 'Ada', 'x'.repeat(256), 'tooLong'],
  ['EMAIL', {}, 'Ada@Example.COM', 'ada@example.com', 'not-an-email', 'email'],
  ['PHONE_NUMBER', {}, '+39 02 1234 567', '+39 02 1234 567', '123', 'phone'],
  ['WEBSITE', {}, 'example.com', 'https://example.com', 'ftp://example.com', 'url'],
  [
    'SOCIAL_SECURITY_NUMBER',
    { config: { format: 'us_ssn' } },
    '123456789',
    '123-45-6789',
    '000-12-3456',
    'ssnUs',
  ],
  ['SOCIAL_SECURITY_NUMBER', {}, 'rssmra80a01f205x', 'RSSMRA80A01F205X', 'a!', 'ssnGeneric'],
  ['STATE', {}, 'it-mi', 'IT-MI', 'Milano', 'state'],
  ['USER', {}, 'usr_01H', 'usr_01H', 'not a user!', 'user'],
  ['DROPDOWN', { options: OPTIONS }, 'pro', 'pro', 'gold', 'option'],
  ['RADIO', { options: OPTIONS }, 'team', 'team', 'gold', 'option'],
  [
    'LIST_BOX',
    { options: OPTIONS },
    ['pro', 'team', 'pro'],
    ['pro', 'team'],
    ['pro', 'gold'],
    'option',
  ],
  ['USER_LIST_BOX', {}, ['u1', 'u2'], ['u1', 'u2'], ['u1', 'bad id!'], 'user'],
  [
    'DRILLDOWN',
    { options: TREE },
    ['eu', 'it', 'mi'],
    ['eu', 'it', 'mi'],
    ['eu', 'fr'],
    'drilldown',
  ],
  ['CURRENCY', { config: { currency: 'EUR' } }, '1234,50', 1234.5, '1.234', 'decimals'],
  ['DECIMAL_NUMBER', { config: { min: 0, max: 10 } }, '3.141592', 3.141592, '11', 'max'],
  ['PERCENT', {}, '12.5', 12.5, '120', 'percent'],
  ['WHOLE_NUMBER', { config: { min: 1 } }, '42', 42, '0', 'min'],
  ['YEAR', {}, '1987', 1987, '87', 'year'],
  ['DAY_OF_WEEK', {}, '5', 5, '8', 'dayOfWeek'],
  ['MONTH', {}, '12', 12, '13', 'month'],
  ['YES_NO', {}, true, true, 'maybe', 'boolean'],
  ['DATE', {}, '2024-02-29', '2024-02-29', '2023-02-29', 'date'],
  [
    'DATE_TIME',
    {},
    '2026-10-15T10:30:00+02:00',
    '2026-10-15T08:30:00.000Z',
    '2026-10-15 10:30',
    'dateTime',
  ],
];

describe('custom field input validation', () => {
  it('covers all 24 field types', () => {
    expect(new Set(CASES.map(([type]) => type))).toEqual(new Set(CUSTOM_FIELD_TYPES));
    expect(CUSTOM_FIELD_TYPES).toHaveLength(24);
  });

  it.each(CASES)(
    '%s accepts valid input and rejects invalid input',
    (type, extra, good, normalized, bad, code) => {
      const field = def(type, extra);
      expect(validateCustomFieldValue(field, good)).toEqual({ ok: true, value: normalized });
      const rejected = validateCustomFieldValue(field, bad);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error).toBe(code);
    },
  );

  it('clears empty values, or requires them when the field is required', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      const empty: WidgetValue =
        type === 'LIST_BOX' || type === 'USER_LIST_BOX' || type === 'DRILLDOWN' ? [] : '';
      expect(validateCustomFieldValue(def(type), empty)).toEqual({ ok: true, value: null });
      const required = validateCustomFieldValue(def(type, { required: true }), empty);
      expect(required.ok ? null : required.error).toBe('required');
    }
  });

  it('passes the range in the error so the message can show it', () => {
    expect(validateCustomFieldValue(def('WHOLE_NUMBER', { config: { max: 10 } }), '11')).toEqual({
      ok: false,
      error: 'max',
      vars: { max: 10 },
    });
    expect(validateCustomFieldValue(def('CURRENCY'), '1.234')).toEqual({
      ok: false,
      error: 'decimals',
      vars: { count: 2 },
    });
  });

  it('turns stored API values back into widget values', () => {
    expect(toWidgetValue('WHOLE_NUMBER', 42)).toBe('42');
    expect(toWidgetValue('YES_NO', false)).toBe(false);
    expect(toWidgetValue('LIST_BOX', null)).toEqual([]);
    expect(toWidgetValue('DRILLDOWN', ['eu', 'it'])).toEqual(['eu', 'it']);
    expect(toWidgetValue('TEXT', undefined)).toBeNull();
  });
});

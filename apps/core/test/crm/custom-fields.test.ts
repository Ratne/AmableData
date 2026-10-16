import {
  CUSTOM_FIELD_TYPES,
  type CustomFieldType,
  type CustomFieldValueInput,
} from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import {
  maskValue,
  normalizeCustomFieldValue,
  validateFieldDefinition,
  type FieldDefinition,
} from '../../src/crm/custom-fields/validate';
import { createTestTenant, VIEWER_ACTOR } from './helpers';

const OPTIONS = [
  { value: 'free', label: 'Free' },
  { value: 'pro', label: 'Pro' },
];
const TREE = [
  {
    value: 'it',
    label: 'Italy',
    children: [{ value: 'lom', label: 'Lombardy', children: [{ value: 'mi', label: 'Milan' }] }],
  },
  { value: 'fr', label: 'France' },
];

function def(type: CustomFieldType, extra: Partial<FieldDefinition> = {}): FieldDefinition {
  const options =
    type === 'DRILLDOWN' ? TREE : ['DROPDOWN', 'RADIO', 'LIST_BOX'].includes(type) ? OPTIONS : [];
  return { key: 'f', type, options, config: {}, ...extra };
}

/** [type, accepted input, expected API value] and [type, rejected input]. */
const VALID: Array<[CustomFieldType, CustomFieldValueInput, unknown]> = [
  ['CURRENCY', 12.5, 12.5],
  ['DATE', '2026-02-28', '2026-02-28'],
  ['DATE_TIME', '2026-10-15T14:00:00+02:00', '2026-10-15T12:00:00.000Z'],
  ['DAY_OF_WEEK', 3, 3],
  ['DAY_OF_WEEK', 'friday', 5],
  ['DECIMAL_NUMBER', 3.14159, 3.14159],
  ['DRILLDOWN', ['it', 'lom', 'mi'], ['it', 'lom', 'mi']],
  ['DRILLDOWN', ['Italy', 'Lombardy'], ['it', 'lom']],
  ['DROPDOWN', 'pro', 'pro'],
  ['DROPDOWN', 'Pro', 'pro'],
  ['EMAIL', 'Mario.Rossi@Example.com', 'mario.rossi@example.com'],
  ['LIST_BOX', ['free', 'pro', 'pro'], ['free', 'pro']],
  ['MONTH', 12, 12],
  ['MONTH', 'mar', 3],
  ['NAME', '  Mario  ', 'Mario'],
  ['PERCENT', 99.5, 99.5],
  ['PHONE_NUMBER', '+39 02 1234 5678', '+39 02 1234 5678'],
  ['RADIO', 'free', 'free'],
  ['SOCIAL_SECURITY_NUMBER', 'rssmra80a01f205x', 'RSSMRA80A01F205X'],
  ['STATE', 'it-mi', 'IT-MI'],
  ['TEXT', 'hello', 'hello'],
  ['TEXT_AREA', 'line 1\nline 2', 'line 1\nline 2'],
  ['USER', '01JAUSER00000000000000000', '01JAUSER00000000000000000'],
  ['USER_LIST_BOX', ['u1', 'u2'], ['u1', 'u2']],
  ['WEBSITE', 'example.com/path', 'https://example.com/path'],
  ['WHOLE_NUMBER', 42, 42],
  ['YEAR', 1999, 1999],
  ['YES_NO', true, true],
];

const INVALID: Array<[CustomFieldType, CustomFieldValueInput]> = [
  ['CURRENCY', 1.234],
  ['CURRENCY', 'abc'],
  ['DATE', '2026-02-30'],
  ['DATE', '15/10/2026'],
  ['DATE_TIME', '2026-10-15 14:00'],
  ['DAY_OF_WEEK', 8],
  ['DECIMAL_NUMBER', 'NaN'],
  ['DRILLDOWN', ['it', 'xx']],
  ['DRILLDOWN', 'it'],
  ['DROPDOWN', 'enterprise'],
  ['EMAIL', 'not-an-email'],
  ['LIST_BOX', ['free', 'gold']],
  ['LIST_BOX', 'free'],
  ['MONTH', 13],
  ['NAME', 'x'.repeat(256)],
  ['PERCENT', 101],
  ['PHONE_NUMBER', 'call me'],
  ['PHONE_NUMBER', '123'],
  ['RADIO', 'other'],
  ['SOCIAL_SECURITY_NUMBER', '#!'],
  ['STATE', 'Lombardia'],
  ['TEXT', 42],
  ['TEXT_AREA', 'x'.repeat(10_001)],
  ['USER', 'not a user id!'],
  ['USER_LIST_BOX', ['ok', 'bad id']],
  ['WEBSITE', 'ftp://example.com'],
  ['WHOLE_NUMBER', 1.5],
  ['YEAR', 99],
  ['YES_NO', 'maybe'],
];

describe('custom field validation per type', () => {
  it('covers all 24 types', () => {
    const covered = new Set([...VALID.map(([t]) => t), ...INVALID.map(([t]) => t)]);
    expect([...covered].sort()).toEqual([...CUSTOM_FIELD_TYPES].sort());
    expect(CUSTOM_FIELD_TYPES).toHaveLength(24);
  });

  it.each(VALID)('%s accepts %j', (type, input, expected) => {
    const result = normalizeCustomFieldValue(def(type), input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.api).toEqual(expected);
  });

  it.each(INVALID)('%s rejects %j', (type, input) => {
    expect(normalizeCustomFieldValue(def(type), input).ok).toBe(false);
  });

  it('null clears every type', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      expect(normalizeCustomFieldValue(def(type), null)).toEqual({ ok: true, value: null });
    }
  });

  it('applies config: decimals, min/max, max_length, us_ssn format', () => {
    expect(normalizeCustomFieldValue(def('CURRENCY', { config: { decimals: 0 } }), 10.5).ok).toBe(
      false,
    );
    expect(
      normalizeCustomFieldValue(def('WHOLE_NUMBER', { config: { min: 0, max: 10 } }), 11).ok,
    ).toBe(false);
    expect(normalizeCustomFieldValue(def('TEXT', { config: { max_length: 3 } }), 'abcd').ok).toBe(
      false,
    );
    const ssn = def('SOCIAL_SECURITY_NUMBER', { config: { format: 'us_ssn' } });
    expect(normalizeCustomFieldValue(ssn, '123456789')).toMatchObject({
      ok: true,
      value: { api: '123-45-6789' },
    });
    expect(normalizeCustomFieldValue(ssn, '000-12-3456').ok).toBe(false);
  });

  it('lenient mode coerces CSV text', () => {
    const lenient = { lenient: true, listDelimiter: ';' };
    expect(normalizeCustomFieldValue(def('WHOLE_NUMBER'), '42', lenient)).toMatchObject({
      ok: true,
      value: { api: 42 },
    });
    expect(normalizeCustomFieldValue(def('CURRENCY'), '12,50', lenient)).toMatchObject({
      ok: true,
      value: { api: 12.5 },
    });
    expect(normalizeCustomFieldValue(def('YES_NO'), 'sì', lenient)).toMatchObject({
      ok: true,
      value: { api: true },
    });
    expect(normalizeCustomFieldValue(def('LIST_BOX'), 'Free; pro', lenient)).toMatchObject({
      ok: true,
      value: { api: ['free', 'pro'] },
    });
    expect(normalizeCustomFieldValue(def('DRILLDOWN'), 'Italy > Lombardy', lenient)).toMatchObject({
      ok: true,
      value: { api: ['it', 'lom'] },
    });
    expect(normalizeCustomFieldValue(def('TEXT'), '', lenient)).toEqual({ ok: true, value: null });
  });

  it('stores values in the right column', () => {
    const number = normalizeCustomFieldValue(def('WHOLE_NUMBER'), 7);
    const list = normalizeCustomFieldValue(def('LIST_BOX'), ['pro']);
    const flag = normalizeCustomFieldValue(def('YES_NO'), false);
    expect(number).toMatchObject({ ok: true, value: { number: 7, text: null } });
    expect(list).toMatchObject({ ok: true, value: { json: '["pro"]', text: 'pro' } });
    expect(flag).toMatchObject({ ok: true, value: { number: 0 } });
  });

  it('validates definitions', () => {
    expect(validateFieldDefinition({ type: 'DROPDOWN' })).toMatch(/at least one option/);
    expect(validateFieldDefinition({ type: 'TEXT', options: OPTIONS })).toMatch(
      /do not take options/,
    );
    expect(
      validateFieldDefinition({ type: 'DROPDOWN', options: [...OPTIONS, OPTIONS[0]!] }),
    ).toMatch(/unique/);
    expect(validateFieldDefinition({ type: 'RADIO', options: TREE })).toMatch(/only DRILLDOWN/);
    expect(validateFieldDefinition({ type: 'TEXT', config: { currency: 'EUR' } })).toMatch(
      /CURRENCY/,
    );
    expect(validateFieldDefinition({ type: 'DRILLDOWN', options: TREE })).toBeNull();
  });

  it('masks sensitive values', () => {
    expect(maskValue('RSSMRA80A01F205X')).toBe('************205X');
    expect(maskValue('ab')).toBe('****');
  });
});

describe('custom fields on records', () => {
  it('validates values on contacts, rejects unknown keys and masks sensitive fields for viewers', () => {
    const t = createTestTenant();
    t.op('customFields.create', {
      entity: 'contact',
      data: { key: 'plan', label: 'Plan', type: 'DROPDOWN', options: OPTIONS },
    });
    t.op('customFields.create', {
      entity: 'contact',
      data: { key: 'tax', label: 'Tax', type: 'SOCIAL_SECURITY_NUMBER' },
    });
    const contact = t.op('contacts.create', {
      given_name: 'Ada',
      custom_fields: { plan: 'Pro', tax: 'RSSMRA80A01F205X' },
    });
    expect(contact.custom_fields).toEqual({ plan: 'pro', tax: 'RSSMRA80A01F205X' });

    expect(() =>
      t.op('contacts.create', { given_name: 'Bob', custom_fields: { plan: 'gold' } }),
    ).toThrow(/validation_failed/);
    expect(() =>
      t.op('contacts.create', { given_name: 'Bob', custom_fields: { nope: 1 } }),
    ).toThrow(/unknown custom field/);

    const asViewer = t.op('contacts.get', { id: contact.id }, VIEWER_ACTOR);
    expect(asViewer.custom_fields['tax']).toBe('************205X');
    expect(asViewer.custom_fields['plan']).toBe('pro');
  });

  it('enforces required fields on create and supports groups/tabs layout', () => {
    const t = createTestTenant();
    const tab = t.op('customFields.createTab', { entity: 'company', data: { name: 'Details' } });
    const group = t.op('customFields.createGroup', {
      entity: 'company',
      data: { tab_id: tab.id, name: 'Size' },
    });
    t.op('customFields.create', {
      entity: 'company',
      data: {
        key: 'employees',
        label: 'Employees',
        type: 'WHOLE_NUMBER',
        group_id: group.id,
        required: true,
      },
    });
    expect(() => t.op('companies.create', { name: 'Acme' })).toThrow(/employees is required/);
    const company = t.op('companies.create', { name: 'Acme', custom_fields: { employees: 12 } });
    expect(company.custom_fields).toEqual({ employees: 12 });
    const layout = t.op('customFields.layout', { entity: 'company' });
    expect(layout.tabs[0]?.groups[0]?.fields.map((f) => f.key)).toEqual(['employees']);
    expect(() =>
      t.op('customFields.create', {
        entity: 'company',
        data: { key: 'employees', label: 'Dup', type: 'TEXT' },
      }),
    ).toThrow(/conflict/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptLanguageTags,
  defaultFormDefinition,
  displayValue,
  formDefinitionSchema,
  resolveWidgetLocale,
  splitSteps,
  submitPayloadSchema,
  validateSubmission,
  visibleFieldKeys,
  type FormDefinitionInput,
} from '../src/index';
import { buildBundle, renderModule } from '../scripts/build.mjs';

const definition = (input: FormDefinitionInput) => formDefinitionSchema.parse(input);

const sample = definition({
  fields: [
    { id: 'a', kind: 'text', key: 'name', label: 'Name', required: true, map_to: 'given_name' },
    { id: 'b', kind: 'email', key: 'email', required: true, map_to: 'email' },
    { id: 'c', kind: 'phone', key: 'phone', map_to: 'phone' },
    {
      id: 'd',
      kind: 'select',
      key: 'budget',
      required: true,
      options: [
        { label: 'Small', value: 'small' },
        { label: 'Large', value: 'large' },
      ],
    },
    {
      id: 'e',
      kind: 'textarea',
      key: 'details',
      required: true,
      visible_if: [{ field_key: 'budget', op: 'equals', value: 'large' }],
    },
    { id: 'f', kind: 'page_break', key: 'step_2', label: 'More' },
    { id: 'g', kind: 'number', key: 'seats', min: 1, max: 10 },
    {
      id: 'h',
      kind: 'multicheck',
      key: 'topics',
      options: [
        { label: 'Sales', value: 'sales' },
        { label: 'Support', value: 'support' },
      ],
    },
    { id: 'i', kind: 'consent', key: 'marketing', label: 'Send me news', marketing: true },
    { id: 'j', kind: 'hidden', key: 'campaign', prefill_param: 'c', default_value: 'none' },
  ],
});

describe('form definition schema', () => {
  it('fills defaults and builds a valid starter form', () => {
    const starter = defaultFormDefinition('it');
    expect(starter.fields.map((f) => f.map_to)).toEqual(['given_name', 'family_name', 'email', null]);
    expect(starter.settings.success_mode).toBe('message');
    expect(starter.crm.update_policy).toBe('fill_empty');
    expect(starter.style.primary_color).toMatch(/^#/);
  });

  it('rejects duplicate keys, double mappings, unknown conditions and empty option lists', () => {
    const result = formDefinitionSchema.safeParse({
      fields: [
        { id: 'a', kind: 'text', key: 'x', map_to: 'email' },
        { id: 'b', kind: 'email', key: 'x', map_to: 'email' },
        { id: 'c', kind: 'select', key: 'y', visible_if: [{ field_key: 'nope', op: 'filled' }] },
      ],
    });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];
    expect(messages).toEqual(
      expect.arrayContaining([
        'fields.1.key: duplicate field key',
        'fields.1.map_to: another field already maps to this attribute',
        'fields.2.options: add at least one option',
        'fields.2.visible_if.0.field_key: unknown field',
      ]),
    );
  });

  it('accepts custom field mappings and refuses CSS that could escape the stylesheet', () => {
    expect(
      formDefinitionSchema.safeParse({ fields: [{ id: 'a', kind: 'text', key: 'k', map_to: 'custom.budget_eur' }] })
        .success,
    ).toBe(true);
    expect(
      formDefinitionSchema.safeParse({ fields: [{ id: 'a', kind: 'text', key: 'k', map_to: 'custom.Bad-Key' }] })
        .success,
    ).toBe(false);
    expect(formDefinitionSchema.safeParse({ style: { primary_color: 'red} body{display:none' } }).success).toBe(false);
    expect(formDefinitionSchema.safeParse({ style: { custom_css: '</style><script>' } }).success).toBe(false);
  });

  it('parses submit payloads with defaults', () => {
    const payload = submitPayloadSchema.parse({ values: { email: 'a@b.co' } });
    expect(payload.meta.page_url).toBe('');
    expect(payload.hp).toBe('');
  });
});

describe('validateSubmission', () => {
  it('requires visible required fields and checks formats', () => {
    const result = validateSubmission(sample, { email: 'nope', phone: 'abc', budget: 'huge', seats: 50 });
    expect(result).toEqual({
      ok: false,
      errors: {
        name: 'required',
        email: 'invalid_email',
        phone: 'invalid_phone',
        budget: 'invalid_option',
        seats: 'too_large',
      },
    });
  });

  it('ignores conditionally hidden fields and drops unknown keys', () => {
    const result = validateSubmission(sample, {
      name: ' Ada ',
      email: 'ada@example.com',
      budget: 'small',
      details: 'should be dropped',
      topics: ['sales'],
      marketing: true,
      seats: '3',
      intruder: 'x',
    });
    expect(result).toEqual({
      ok: true,
      values: { name: 'Ada', email: 'ada@example.com', budget: 'small', seats: 3, topics: ['sales'], marketing: true },
    });
  });

  it('enforces fields revealed by a condition', () => {
    const result = validateSubmission(sample, { name: 'Ada', email: 'ada@example.com', budget: 'large' });
    expect(result).toEqual({ ok: false, errors: { details: 'required' } });
  });

  it('hides fields that depend on a hidden field', () => {
    const chained = definition({
      fields: [
        { id: 'a', kind: 'checkbox', key: 'a' },
        { id: 'b', kind: 'text', key: 'b', visible_if: [{ field_key: 'a', op: 'filled' }] },
        { id: 'c', kind: 'text', key: 'c', visible_if: [{ field_key: 'b', op: 'equals', value: 'x' }] },
      ],
    });
    expect([...visibleFieldKeys(chained.fields, { b: 'x' })]).toEqual(['a']);
    expect([...visibleFieldKeys(chained.fields, { a: true, b: 'x' })]).toEqual(['a', 'b', 'c']);
  });

  it('rejects options outside the list for multi choice fields', () => {
    const result = validateSubmission(sample, { name: 'A', email: 'a@b.co', budget: 'small', topics: ['other'] });
    expect(result).toEqual({ ok: false, errors: { topics: 'invalid_option' } });
  });
});

describe('helpers', () => {
  it('splits steps at page breaks and renders display values', () => {
    const steps = splitSteps(sample.fields);
    expect(steps.map((s) => [s.title, s.fields.length])).toEqual([
      ['', 5],
      ['More', 4],
    ]);
    const topics = sample.fields.find((f) => f.key === 'topics');
    expect(displayValue(topics, ['sales', 'support'])).toBe('Sales, Support');
    expect(displayValue(undefined, true)).toBe('yes');
  });

  it('picks the widget locale from the setting or the browser', () => {
    expect(resolveWidgetLocale('auto', acceptLanguageTags('de-DE,it;q=0.8,en;q=0.5'))).toBe('it');
    expect(resolveWidgetLocale('en', ['it'])).toBe('en');
    expect(resolveWidgetLocale('auto', [])).toBe('en');
  });
});

describe('widget bundle', () => {
  it('is committed up to date, small and free of zod', async () => {
    const bundle = await buildBundle();
    const generated = readFileSync(join(import.meta.dirname, '../generated/bundle.ts'), 'utf8');
    expect(generated).toBe(renderModule(bundle));
    expect(bundle.length).toBeLessThan(60_000);
    expect(bundle).not.toContain('ZodError');
    expect(bundle).toContain('data-amable-form');
  });
});

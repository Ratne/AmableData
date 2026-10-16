import { formFieldSchema, type FormField } from '@amable/forms';
import { describe, expect, it } from 'vitest';
import {
  applyWebhookBody,
  buildWebhookBody,
  mapsContact,
  mergeMissing,
  parseBodyTemplate,
} from '../src/features/forms/lib/webhook-body';

const field = (input: Partial<FormField> & Pick<FormField, 'kind' | 'key'>): FormField =>
  formFieldSchema.parse({ id: `f_${input.key}`, label: input.key, ...input });

const fields: FormField[] = [
  field({ kind: 'text', key: 'first_name', map_to: 'given_name' }),
  field({ kind: 'email', key: 'email', map_to: 'email' }),
  field({ kind: 'heading', key: 'intro' }),
  field({ kind: 'multicheck', key: 'interests', options: [{ label: 'A', value: 'a' }] }),
  field({ kind: 'hidden', key: 'campaign' }),
  field({ kind: 'page_break', key: 'step2' }),
];

describe('webhook body builder', () => {
  it('maps every value field to its merge tag plus submission meta', () => {
    const body = buildWebhookBody(fields);
    expect(Object.keys(body)).toEqual(['first_name', 'email', 'interests', 'campaign', 'meta']);
    expect(body['email']).toBe('{{email}}');
    expect(body['meta']).toEqual({
      event: 'form.submitted',
      form: { id: '{{form_id}}', name: '{{form_name}}' },
      submission_id: '{{submission_id}}',
      submitted_at: '{{submitted_at}}',
      page_url: '{{page_url}}',
      referrer: '{{referrer}}',
      visitor_id: '{{visitor_id}}',
      utm: {
        utm_source: '{{utm_source}}',
        utm_medium: '{{utm_medium}}',
        utm_campaign: '{{utm_campaign}}',
        utm_term: '{{utm_term}}',
        utm_content: '{{utm_content}}',
      },
      contact_id: '{{contact_id}}',
    });
  });

  it('adds contact_id only when the form maps a contact, and avoids a field named meta', () => {
    const plain = [field({ kind: 'text', key: 'meta' }), field({ kind: 'textarea', key: 'note' })];
    expect(mapsContact(plain)).toBe(false);
    const body = buildWebhookBody(plain);
    expect(body['meta']).toBe('{{meta}}');
    expect(body['_meta']).not.toHaveProperty('contact_id');
  });

  it('merges into an existing template keeping the user values, or replaces it', () => {
    const existing = JSON.stringify({ email: 'custom {{email}}', source: 'site', meta: { event: 'lead' } });
    const merged = JSON.parse(applyWebhookBody(existing, buildWebhookBody(fields), 'merge')) as Record<string, unknown>;
    expect(merged['email']).toBe('custom {{email}}');
    expect(merged['source']).toBe('site');
    expect(merged['first_name']).toBe('{{first_name}}');
    expect((merged['meta'] as Record<string, unknown>)['event']).toBe('lead');
    expect((merged['meta'] as Record<string, unknown>)['submitted_at']).toBe('{{submitted_at}}');
    const replaced = applyWebhookBody(existing, buildWebhookBody(fields), 'replace');
    expect(JSON.parse(replaced)).toEqual(buildWebhookBody(fields));
    expect(replaced).toContain('\n  "first_name": "{{first_name}}"');
    expect(JSON.parse(applyWebhookBody('not json', { a: '1' }, 'merge'))).toEqual({ a: '1' });
  });

  it('parses templates and merges nested objects only', () => {
    expect(parseBodyTemplate('')).toEqual({ ok: true, value: null });
    expect(parseBodyTemplate('[1]')).toEqual({ ok: false });
    expect(parseBodyTemplate('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(mergeMissing({ a: { b: 1 }, c: [1] }, { a: { d: 2 }, c: [2], e: null })).toEqual({
      a: { b: 1, d: 2 },
      c: [1],
      e: null,
    });
  });
});

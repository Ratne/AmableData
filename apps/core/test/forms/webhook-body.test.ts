import { webhookConfigSchema } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { renderBodyTemplate } from '../../src/forms/connectors/webhook';

describe('webhook body template', () => {
  it('replaces merge tags inside string values, keeping the JSON structure', () => {
    const template = JSON.stringify({
      email: '{{email}}',
      greeting: 'Hi {{ first_name }}!',
      meta: { form: { id: '{{form_id}}' }, utm: ['{{utm_source}}'], unknown: '{{nope}}' },
      fixed: 3,
      flag: true,
    });
    const out = JSON.parse(
      renderBodyTemplate(template, {
        email: 'ada@example.com',
        first_name: 'Ada "the" \\ Countess',
        form_id: 'frm_1',
        utm_source: '',
      }),
    ) as Record<string, unknown>;
    expect(out).toEqual({
      email: 'ada@example.com',
      greeting: 'Hi Ada "the" \\ Countess!',
      meta: { form: { id: 'frm_1' }, utm: [''], unknown: '{{nope}}' },
      fixed: 3,
      flag: true,
    });
  });

  it('cannot be broken out of by submitted values', () => {
    const out = renderBodyTemplate('{"note":"{{note}}"}', { note: '", "admin": true, "x": "' });
    expect(JSON.parse(out)).toEqual({ note: '", "admin": true, "x": "' });
  });

  it('accepts only JSON objects (or nothing) in the config', () => {
    const base = { url: 'https://hooks.example.com/x' };
    expect(webhookConfigSchema.safeParse({ ...base, body_template: '{"a":"{{email}}"}' }).success).toBe(true);
    expect(webhookConfigSchema.safeParse({ ...base, body_template: '' }).success).toBe(true);
    expect(webhookConfigSchema.safeParse({ ...base, body_template: null }).success).toBe(true);
    expect(webhookConfigSchema.safeParse({ ...base, body_template: '[1,2]' }).success).toBe(false);
    expect(webhookConfigSchema.safeParse({ ...base, body_template: '{"a":' }).success).toBe(false);
  });
});

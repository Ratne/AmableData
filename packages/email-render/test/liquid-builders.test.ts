import { renderSandboxed } from '@amable/auth/security';
import { describe, expect, it } from 'vitest';
import {
  caseBlock,
  conditionSource,
  dateExpression,
  fallbackExpression,
  hasTagBlock,
  ifElseBlock,
  liquidFilterNames,
  liquidVariablePaths,
  loopBlock,
  parseVariableExpression,
  validateLiquid,
} from '../src';

const ctx = {
  contact: {
    first_name: 'Ada',
    tags: ['VIP', 'Newsletter', 'Beta', 'Events'],
    score: 72,
    lifecycle: 'customer',
    time_zone: 'Asia/Tokyo',
    custom: { renewal: '2026-12-01T00:00:00Z', plan: 'pro', vip_discount: 15 },
  },
};

const render = (source: string | null, data: Record<string, unknown> = ctx) => {
  if (source === null) throw new Error('builder returned null');
  return renderSandboxed(source, data, { escapeHtml: false });
};

describe('fallback builder', () => {
  it('generates a default filter and renders the fallback when empty', async () => {
    const code = fallbackExpression({ path: 'contact.first_name', fallback: 'there' });
    expect(code).toBe('{{ contact.first_name | default: "there" }}');
    expect(await render(code)).toBe('Ada');
    expect(await render(code, { contact: { first_name: '' } })).toBe('there');
  });

  it('chains filters, quotes awkward fallbacks and rejects bad input', () => {
    expect(fallbackExpression({ path: 'contact.city', filters: ['upcase'], fallback: 'n/d' })).toBe(
      '{{ contact.city | upcase | default: "n/d" }}',
    );
    expect(fallbackExpression({ path: 'contact.x', fallback: 'say "hi"' })).toBe(
      `{{ contact.x | default: 'say "hi"' }}`,
    );
    expect(fallbackExpression({ path: 'contact.x', fallback: '{{ evil }}' })).toBe(
      '{{ contact.x | default: " evil " }}',
    );
    expect(fallbackExpression({ path: 'contact..x' })).toBeNull();
    expect(fallbackExpression({ path: 'contact.x', filters: ['upcase }}{{ y'] })).toBeNull();
  });
});

describe('date builder', () => {
  it('formats with no zone, the contact zone or a fixed zone', async () => {
    const path = 'contact.custom.renewal';
    expect(dateExpression({ path, format: '%d/%m/%Y' })).toBe(
      '{{ contact.custom.renewal | date: "%d/%m/%Y" }}',
    );
    const contactZone = dateExpression({
      path,
      format: '%d/%m/%Y %H:%M',
      timezone: { kind: 'contact' },
    });
    expect(contactZone).toBe('{{ contact.custom.renewal | date: "%d/%m/%Y %H:%M", contact.time_zone }}');
    expect(await render(contactZone)).toBe('01/12/2026 09:00');
    const fixed = dateExpression({ path, format: '%H:%M', timezone: { kind: 'fixed', zone: 'Europe/Rome' } });
    expect(await render(fixed)).toBe('01:00');
    expect(dateExpression({ path: 'now', format: '%Y' })).toBe('{{ "now" | date: "%Y" }}');
  });

  it('rejects unsafe formats and zones', () => {
    expect(dateExpression({ path: 'contact.x', format: '%Y" }}{{ x' })).toBeNull();
    expect(
      dateExpression({ path: 'contact.x', format: '%Y', timezone: { kind: 'fixed', zone: 'x"; y' } }),
    ).toBeNull();
  });
});

describe('if / else builder', () => {
  it('builds if/elsif/else with and/or joins', async () => {
    const code = ifElseBlock({
      branches: [
        {
          join: 'and',
          conditions: [
            { field: 'contact.score', operator: 'greater_than', value: '80' },
            { field: '', operator: 'has_tag', value: 'VIP' },
          ],
          body: 'Top',
        },
        { join: 'or', conditions: [{ field: 'contact.lifecycle', operator: 'equals', value: 'customer' }], body: 'Customer' },
      ],
      elseBody: 'Hello',
    });
    expect(code).toBe(
      '{% if contact.score > 80 and contact.tags contains "VIP" %}Top{% elsif contact.lifecycle == "customer" %}Customer{% else %}Hello{% endif %}',
    );
    expect(await render(code)).toBe('Customer');
    expect(validateLiquid(code ?? '').ok).toBe(true);
  });

  it('covers every operator', () => {
    const f = 'contact.custom.plan';
    expect(conditionSource({ field: f, operator: 'not_equals', value: 'free' })).toBe(`${f} != "free"`);
    expect(conditionSource({ field: f, operator: 'contains', value: 'pro' })).toBe(`${f} contains "pro"`);
    expect(conditionSource({ field: f, operator: 'less_or_equal', value: '3' })).toBe(`${f} <= 3`);
    expect(conditionSource({ field: f, operator: 'greater_or_equal', value: '3' })).toBe(`${f} >= 3`);
    expect(conditionSource({ field: f, operator: 'less_than', value: 'abc' })).toBeNull();
    expect(conditionSource({ field: f, operator: 'is_empty' })).toBe(`${f} == blank`);
    expect(conditionSource({ field: f, operator: 'is_not_empty' })).toBe(`${f} != blank`);
    expect(conditionSource({ field: f, operator: 'equals', value: '42', valueType: 'number' })).toBe(`${f} == 42`);
    expect(conditionSource({ field: f, operator: 'equals', value: 'true', valueType: 'boolean' })).toBe(`${f} == true`);
    expect(conditionSource({ field: 'bad field', operator: 'equals', value: 'x' })).toBeNull();
    expect(ifElseBlock({ branches: [] })).toBeNull();
  });
});

describe('has tag, loop and case builders', () => {
  it('has tag (and negated with unless)', async () => {
    expect(await render(hasTagBlock({ tag: 'VIP', body: 'yes', elseBody: 'no' }))).toBe('yes');
    const negated = hasTagBlock({ tag: 'VIP', negate: true, body: 'join us' });
    expect(negated).toBe('{% unless contact.tags contains "VIP" %}join us{% endunless %}');
    expect(await render(negated)).toBe('');
  });

  it('loop with limit, separator and empty branch', async () => {
    const code = loopBlock({ collection: 'contact.tags', item: 'tag', limit: 3, body: '{{ tag }}', separator: ', ', emptyBody: 'none' });
    expect(code).toBe('{% for tag in contact.tags limit: 3 %}{{ tag }}{% unless forloop.last %}, {% endunless %}{% else %}none{% endfor %}');
    expect(await render(code)).toBe('VIP, Newsletter, Beta');
    expect(await render(code, { contact: { tags: [] } })).toBe('none');
    expect(loopBlock({ collection: 'contact.tags', item: 'Bad-Name', body: '' })).toBeNull();
    expect(loopBlock({ collection: 'contact.tags', item: 'tag', limit: -1, body: '' })).toBeNull();
  });

  it('case / when with several values per branch', async () => {
    const code = caseBlock({
      field: 'contact.lifecycle',
      whens: [
        { values: ['lead', 'subscriber'], body: 'Start a trial' },
        { values: ['customer'], body: 'Upgrade' },
      ],
      elseBody: 'Talk to us',
    });
    expect(code).toBe(
      '{% case contact.lifecycle %}{% when "lead", "subscriber" %}Start a trial{% when "customer" %}Upgrade{% else %}Talk to us{% endcase %}',
    );
    expect(await render(code)).toBe('Upgrade');
    expect(caseBlock({ field: 'contact.lifecycle', whens: [{ values: [' '], body: 'x' }] })).toBeNull();
  });
});

describe('analysis', () => {
  it('reports syntax errors with line and column', () => {
    const result = validateLiquid('Hello\n{% if contact.vip %}\nVIP');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ line: 2, column: 1 });
    expect(result.errors[0]?.message).toContain('not closed');
    expect(result.errors[0]?.message).not.toContain('line:');
    expect(validateLiquid('{{ contact.first_name | nope }}').errors[0]).toMatchObject({ line: 1, column: 1 });
  });

  it('lists global variables, without loop variables or assigns', () => {
    expect(
      liquidVariablePaths(
        '{% assign n = contact.first_name %}{% for t in contact.tags limit: 2 %}{{ t }}{% endfor %}{{ n }}{{ snippets.footer }}{{ contact.custom.plan | default: "x" }}',
      ).sort(),
    ).toEqual(['contact.custom.plan', 'contact.first_name', 'contact.tags', 'snippets.footer']);
  });

  it('reads simple output tags back into chip attributes', () => {
    expect(parseVariableExpression('{{ contact.first_name | default: "there" }}')).toEqual({
      path: 'contact.first_name',
      filter: null,
      fallback: 'there',
    });
    expect(parseVariableExpression('{{ "now" | date: "%d/%m/%Y" }}')).toEqual({
      path: 'now',
      filter: 'date: "%d/%m/%Y"',
      fallback: null,
    });
    expect(parseVariableExpression('{{ a | upcase | downcase }}')).toBeNull();
    expect(parseVariableExpression('{% if a %}x{% endif %}')).toBeNull();
  });

  it('exposes the filter list of the sandbox', () => {
    const names = liquidFilterNames();
    for (const name of ['default', 'upcase', 'downcase', 'capitalize', 'date', 'truncate']) {
      expect(names).toContain(name);
    }
  });
});

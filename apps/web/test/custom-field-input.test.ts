import { CUSTOM_FIELD_TYPES, type CustomFieldType } from '@amable/api-types/crm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { formatCustomValue } from '../src/features/crm/custom-fields/display';
import {
  CustomFieldInput,
  type FieldInputDefinition,
} from '../src/features/crm/custom-fields/field-input';
import type { WidgetValue } from '../src/features/crm/custom-fields/validation';
import { I18nProvider } from '../src/i18n';

vi.mock('../src/features/crm/api/hooks', () => ({
  useDirectory: () => ({
    members: [
      { id: 'u1', name: 'Ada Lovelace' },
      { id: 'u2', name: 'Alan Turing' },
    ],
    nameOf: (id: string) => ({ u1: 'Ada Lovelace', u2: 'Alan Turing' })[id] ?? id,
    isPending: false,
  }),
  useTags: () => ({ tags: [], byId: new Map() }),
}));

const OPTIONS = [
  { value: 'pro', label: 'Pro plan' },
  { value: 'team', label: 'Team plan' },
];

function field(
  type: CustomFieldType,
  patch: Partial<FieldInputDefinition> = {},
): FieldInputDefinition {
  return {
    key: 'f',
    label: `Field ${type}`,
    type,
    options: ['DROPDOWN', 'RADIO', 'LIST_BOX', 'DRILLDOWN'].includes(type) ? OPTIONS : [],
    config: type === 'CURRENCY' ? { currency: 'EUR' } : {},
    sensitive: type === 'SOCIAL_SECURITY_NUMBER',
    ...patch,
  };
}

function render(definition: FieldInputDefinition, value: WidgetValue): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(CustomFieldInput, { field: definition, value, onChange: () => undefined }),
    ),
  );
}

describe('custom field inputs', () => {
  it.each([...CUSTOM_FIELD_TYPES])('%s renders an accessible control', (type) => {
    const html = render(field(type), null);
    expect(html).toContain(`Field ${type}`);
  });

  it('uses the native input type that matches the field', () => {
    expect(render(field('EMAIL'), 'a@b.co')).toContain('type="email"');
    expect(render(field('PHONE_NUMBER'), '+39')).toContain('type="tel"');
    expect(render(field('WEBSITE'), 'https://x.io')).toContain('type="url"');
    expect(render(field('TEXT_AREA'), 'hi')).toContain('<textarea');
  });

  it('masks sensitive identifiers until revealed', () => {
    const html = render(field('SOCIAL_SECURITY_NUMBER'), 'RSSMRA80A01F205X');
    expect(html).toContain('type="password"');
    expect(html.toLowerCase()).toContain('autocomplete="off"');
  });

  it('shows the currency symbol and percent sign next to numbers', () => {
    expect(render(field('CURRENCY'), '10')).toContain('€');
    expect(render(field('PERCENT'), '10')).toContain('%');
  });

  it('renders one radio per option', () => {
    const html = render(field('RADIO'), 'pro');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toContain('Team plan');
  });

  it('formats stored values for display in the UI language', () => {
    const context = {
      locale: 'en',
      nameOf: (id: string) => (id === 'u1' ? 'Ada' : id),
      yes: 'Yes',
      no: 'No',
    };
    expect(formatCustomValue(field('CURRENCY'), 1234.5, context)).toBe('€1,234.50');
    expect(formatCustomValue(field('DROPDOWN'), 'team', context)).toBe('Team plan');
    expect(formatCustomValue(field('LIST_BOX'), ['pro', 'team'], context)).toBe(
      'Pro plan, Team plan',
    );
    expect(formatCustomValue(field('YES_NO'), false, context)).toBe('No');
    expect(formatCustomValue(field('DAY_OF_WEEK'), 1, context)).toBe('Monday');
    expect(formatCustomValue(field('MONTH'), 3, context)).toBe('March');
    expect(formatCustomValue(field('USER_LIST_BOX'), ['u1', 'u9'], context)).toBe('Ada, u9');
    expect(formatCustomValue(field('DATE'), '2026-10-15', context)).toBe('Oct 15, 2026');
  });
});

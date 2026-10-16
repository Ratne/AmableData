import type { LiquidSchema, LiquidSchemaField, LiquidSchemaGroup } from '@amable/api-types';
import { fallbackExpression } from '@amable/email-render';
import type { MessageKey } from '@amable/i18n';
import { useQuery } from '@tanstack/react-query';
import type { useI18n } from '../../../i18n';
import { emailKeys, useEmailApi } from '../api';

type Translate = ReturnType<typeof useI18n>['t'];

/** Labels of the built-in context paths (custom fields and snippets carry their own). */
const BUILTIN_LABELS: Readonly<Record<string, MessageKey>> = {
  'contact.id': 'email.liquid.f.contact.id',
  'contact.first_name': 'email.liquid.f.contact.first_name',
  'contact.last_name': 'email.liquid.f.contact.last_name',
  'contact.full_name': 'email.liquid.f.contact.full_name',
  'contact.email': 'email.liquid.f.contact.email',
  'contact.phone': 'email.liquid.f.contact.phone',
  'contact.city': 'email.liquid.f.contact.city',
  'contact.region': 'email.liquid.f.contact.region',
  'contact.country': 'email.liquid.f.contact.country',
  'contact.job_title': 'email.liquid.f.contact.job_title',
  'contact.website': 'email.liquid.f.contact.website',
  'contact.time_zone': 'email.liquid.f.contact.time_zone',
  'contact.score': 'email.liquid.f.contact.score',
  'contact.tags': 'email.liquid.f.contact.tags',
  'company.name': 'email.liquid.f.company.name',
  'company.website': 'email.liquid.f.company.website',
  'owner.name': 'email.liquid.f.owner.name',
  'owner.email': 'email.liquid.f.owner.email',
  'owner.signature': 'email.liquid.f.owner.signature',
  unsubscribe_url: 'email.liquid.f.unsubscribe_url',
  now: 'email.liquid.f.now',
};

export const GROUP_LABELS: Readonly<Record<LiquidSchemaGroup, MessageKey>> = {
  contact: 'email.liquid.group.contact',
  custom: 'email.liquid.group.custom',
  company: 'email.liquid.group.company',
  owner: 'email.liquid.group.owner',
  snippets: 'email.liquid.group.snippets',
  system: 'email.liquid.group.system',
};

export function fieldLabel(t: Translate, field: LiquidSchemaField): string {
  if (field.label !== null) return field.label;
  const key = BUILTIN_LABELS[field.path];
  return key === undefined ? field.path : t(key);
}

/** What clicking a field inserts: a fallback for text, a date format for dates, a join for lists. */
export function codeForField(field: LiquidSchemaField, fallback: string): string {
  const filters: string[] = [];
  if (field.kind === 'date') filters.push('date: "%d/%m/%Y"');
  if (field.kind === 'list') filters.push('join: ", "');
  if (field.path === 'now' || field.group === 'snippets' || field.path === 'unsubscribe_url') {
    return fallbackExpression({ path: field.path, filters }) ?? '';
  }
  return fallbackExpression({ path: field.path, filters, fallback }) ?? '';
}

export function useLiquidSchema(): { schema: LiquidSchema | undefined; loading: boolean } {
  const { slug, api } = useEmailApi();
  const query = useQuery({ queryKey: emailKeys.liquidSchema(slug), queryFn: api.liquid.schema, staleTime: 60_000 });
  return { schema: query.data, loading: query.isPending };
}

/** Fields usable as an if / case subject (not snippets nor `now`). */
export function conditionFields(schema: LiquidSchema | undefined): LiquidSchemaField[] {
  return (schema?.fields ?? []).filter((f) => f.group !== 'snippets' && f.path !== 'now' && f.path !== 'unsubscribe_url');
}

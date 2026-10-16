import {
  MARKETABLE_STATUSES,
  SOURCE_TYPES,
  type CustomField,
  type SearchEntity,
} from '@amable/api-types/crm';
import type { MessageKey } from '@amable/i18n';
import { useMemo } from 'react';
import { useI18n } from '../../i18n';
import type { FieldKind } from '../search/query-model';
import { useCustomFields, useDirectory, useLeadSources, useSearchFields } from './api/hooks';
import type { Choice } from './components/inputs';

/** Labels of the built-in query-builder fields (`GET /search/fields`). */
export const STANDARD_FIELD_LABELS: Readonly<Record<string, MessageKey>> = {
  given_name: 'crm.field.given_name',
  middle_name: 'crm.field.middle_name',
  family_name: 'crm.field.family_name',
  preferred_name: 'crm.field.preferred_name',
  prefix: 'crm.field.prefix',
  suffix: 'crm.field.suffix',
  name: 'crm.field.name',
  job_title: 'crm.field.job_title',
  website: 'crm.field.website',
  spouse_name: 'crm.field.spouse_name',
  time_zone: 'crm.field.time_zone',
  preferred_locale: 'crm.field.preferred_locale',
  email: 'crm.field.email',
  phone: 'crm.field.phone',
  any_email: 'crm.field.any_email',
  any_phone: 'crm.field.any_phone',
  company_id: 'crm.field.company_id',
  company_name: 'crm.field.company_name',
  owner_id: 'crm.field.owner_id',
  lead_source_id: 'crm.field.lead_source_id',
  source_type: 'crm.field.source_type',
  marketable_status: 'crm.field.marketable_status',
  utm_source: 'crm.field.utm_source',
  utm_medium: 'crm.field.utm_medium',
  utm_campaign: 'crm.field.utm_campaign',
  utm_term: 'crm.field.utm_term',
  utm_content: 'crm.field.utm_content',
  score_value: 'crm.field.score_value',
  birthday: 'crm.field.birthday',
  anniversary: 'crm.field.anniversary',
  locality: 'crm.field.locality',
  region: 'crm.field.region',
  postal_code: 'crm.field.postal_code',
  country_code: 'crm.field.country_code',
  created_at: 'crm.field.created_at',
  updated_at: 'crm.field.updated_at',
  tags: 'crm.field.tags',
  emails: 'crm.field.emails',
  description: 'crm.field.description',
  contact_count: 'crm.field.contact_count',
};

export interface FieldMeta {
  readonly field: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly operators: readonly string[];
  readonly sortable: boolean;
  readonly selectable: boolean;
  readonly custom: CustomField | null;
  /** Value choices for enum / multi / id fields that have a known domain. */
  readonly choices: readonly Choice[] | null;
}

const HIDDEN_FIELDS = new Set(['id']);

/** Fields of an entity with labels, kinds, operators and value choices. */
export function useFieldCatalog(entity: SearchEntity) {
  const { t } = useI18n();
  const searchFields = useSearchFields(entity);
  const custom = useCustomFields(entity === 'company' ? 'companies' : 'contacts');
  const { members } = useDirectory();
  const leadSources = useLeadSources();

  const fields = useMemo<FieldMeta[]>(() => {
    const users = members.map((m) => ({ value: m.id, label: m.name }));
    const builtInChoices = (field: string): Choice[] | null => {
      switch (field) {
        case 'owner_id':
          return users;
        case 'lead_source_id':
          return (leadSources.data ?? []).map((s) => ({ value: s.id, label: s.name }));
        case 'source_type':
          return SOURCE_TYPES.map((value) => ({ value, label: t(`crm.sourceType.${value}`) }));
        case 'marketable_status':
          return MARKETABLE_STATUSES.map((value) => ({
            value,
            label: t(`crm.marketable.${value}`),
          }));
        default:
          return null;
      }
    };
    return (searchFields.data ?? [])
      .filter((description) => !HIDDEN_FIELDS.has(description.field))
      .map((description) => {
        const key = description.field.startsWith('custom.') ? description.field.slice(7) : null;
        const def = key === null ? null : (custom.byKey.get(key) ?? null);
        const labelKey = STANDARD_FIELD_LABELS[description.field];
        const label = def?.label ?? (labelKey ? t(labelKey) : description.field);
        let choices: Choice[] | null = builtInChoices(description.field);
        if (def !== null) {
          if (def.type === 'USER' || def.type === 'USER_LIST_BOX') choices = users;
          else if (def.options.length > 0 && def.type !== 'DRILLDOWN')
            choices = def.options.map((o) => ({ value: o.value, label: o.label }));
        }
        return {
          field: description.field,
          label,
          kind: description.kind,
          operators: description.operators,
          sortable: description.sortable,
          selectable: description.selectable,
          custom: def,
          choices,
        };
      });
  }, [searchFields.data, custom.byKey, members, leadSources.data, t]);

  const byField = useMemo(() => new Map(fields.map((f) => [f.field, f])), [fields]);
  const kinds = useMemo(
    () => new Map(fields.map((f) => [f.field, f.kind] as const)) as ReadonlyMap<string, FieldKind>,
    [fields],
  );
  return { fields, byField, kinds, isPending: searchFields.isPending };
}

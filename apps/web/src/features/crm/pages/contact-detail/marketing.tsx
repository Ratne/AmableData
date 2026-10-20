import {
  MARKETABLE_STATUSES,
  SOURCE_TYPES,
  type Contact,
  type UpdateContactInput,
} from '@amable/api-types/crm';
import { languageName, nativeLanguageName } from '../../../../components/locale/languages';
import { useI18n } from '../../../../i18n';
import { useDirectory, useLeadSources } from '../../api/hooks';
import { InlineChoice, InlineText, InlineUser } from '../../components/inline-field';

export function LanguageDisplay({ code, uiLocale }: { code: string; uiLocale: string }) {
  const name = languageName(code, uiLocale);
  const native = nativeLanguageName(code);
  return (
    <>
      {name}
      {native && native !== name ? (
        <span className="ml-1.5 text-xs text-muted-foreground">{native}</span>
      ) : null}
    </>
  );
}

export type SaveContact = (input: UpdateContactInput) => Promise<unknown>;

export function MarketingFields({
  contact,
  canEdit,
  save,
}: {
  contact: Contact;
  canEdit: boolean;
  save: SaveContact;
}) {
  const { t } = useI18n();
  const { nameOf } = useDirectory();
  const leadSources = useLeadSources();
  return (
    <div className="divide-y">
      <InlineUser
        label={t('crm.field.owner_id')}
        value={contact.owner_id}
        display={nameOf(contact.owner_id)}
        canEdit={canEdit}
        onSave={(owner_id) => save({ owner_id })}
      />
      <InlineChoice
        label={t('crm.field.marketable_status')}
        value={contact.marketable_status}
        allowEmpty={false}
        canEdit={canEdit}
        choices={MARKETABLE_STATUSES.map((value) => ({
          value,
          label: t(`crm.marketable.${value}`),
        }))}
        onSave={(value) =>
          save({ marketable_status: (value ?? 'unknown') as Contact['marketable_status'] })
        }
      />
      <InlineChoice
        label={t('crm.field.lead_source_id')}
        value={contact.lead_source_id}
        canEdit={canEdit}
        choices={(leadSources.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
        onSave={(lead_source_id) => save({ lead_source_id })}
      />
      <InlineChoice
        label={t('crm.field.source_type')}
        value={contact.source_type}
        allowEmpty={false}
        canEdit={canEdit}
        choices={SOURCE_TYPES.map((value) => ({
          value,
          label: t(`crm.sourceType.${value}`),
        }))}
        onSave={(value) => save({ source_type: (value ?? 'manual') as Contact['source_type'] })}
      />
      <InlineText
        label={t('crm.field.score_value')}
        value={String(contact.score_value)}
        canEdit={canEdit}
        validate={(value) =>
          /^-?\d+$/.test(value.trim()) ? null : t('crm.validation.wholeNumber')
        }
        onSave={(value) => save({ score_value: Number(value ?? 0) })}
      />
      {(['source', 'medium', 'campaign', 'term', 'content'] as const).map((key) => (
        <InlineText
          key={key}
          label={t(`crm.field.utm_${key}`)}
          value={contact.utm[key]}
          canEdit={canEdit}
          onSave={(value) => {
            const utm: NonNullable<UpdateContactInput['utm']> = {};
            utm[key] = value;
            return save({ utm });
          }}
        />
      ))}
    </div>
  );
}

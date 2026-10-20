import type { Contact, ContactEmailInput, ContactPhoneInput } from '@amable/api-types/crm';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Plus, X } from 'lucide-react';
import {
  flagEmoji,
  isE164,
  normalizePhone,
  phoneDisplay,
} from '../../../../components/locale/phone-countries';
import { PhoneInput } from '../../../../components/locale/phone-input';
import { useWorkspaceCountry } from '../../../workspace/api';
import { useI18n } from '../../../../i18n';
import { InlineEdit } from '../../components/inline-field';
import { ChoiceSelect } from '../../components/inputs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EditableList<T> = {
  readonly label: string;
  readonly items: readonly T[];
  readonly max: number;
  readonly canEdit: boolean;
  readonly onSave: (items: T[]) => Promise<unknown>;
  readonly className?: string;
};

export function EmailsEditor({
  label,
  items,
  max,
  canEdit,
  onSave,
  className,
}: EditableList<ContactEmailInput>) {
  const { t } = useI18n();
  return (
    <InlineEdit<ContactEmailInput[]>
      label={label}
      value={[...items]}
      canEdit={canEdit}
      className={className}
      onSave={onSave}
      validate={(list) =>
        list.every((item) => EMAIL_RE.test(item.email.trim())) ? null : t('crm.validation.email')
      }
      display={
        items.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="flex flex-col">
            {items.map((item, index) => (
              <a key={item.email} href={`mailto:${item.email}`} className="hover:underline">
                {item.email}
                {index === 0 ? (
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    {t('crm.contact.primary')}
                  </Badge>
                ) : null}
                {item.label ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {t(`crm.emailLabel.${item.label}`)}
                  </span>
                ) : null}
              </a>
            ))}
          </span>
        )
      }
      editor={(draft, setDraft) => (
        <div className="grid gap-1.5">
          {draft.map((item, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                type="email"
                value={item.email}
                aria-label={`${label} ${String(index + 1)}`}
                className="h-8"
                onChange={(e) =>
                  setDraft(draft.map((d, i) => (i === index ? { ...d, email: e.target.value } : d)))
                }
              />
              <ChoiceSelect
                value={item.label ?? ''}
                ariaLabel={t('crm.contact.label')}
                className="w-28 min-w-0"
                choices={(['work', 'personal', 'other'] as const).map((value) => ({
                  value,
                  label: t(`crm.emailLabel.${value}`),
                }))}
                onChange={(value) =>
                  setDraft(
                    draft.map((d, i) =>
                      i === index
                        ? value === ''
                          ? { email: d.email }
                          : { ...d, label: value as 'work' | 'personal' | 'other' }
                        : d,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t('crm.common.remove')}
                onClick={() => setDraft(draft.filter((_, i) => i !== index))}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          {draft.length < max ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => setDraft([...draft, { email: '' }])}
            >
              <Plus className="size-3.5" aria-hidden /> {t('crm.contact.addEmail')}
            </Button>
          ) : null}
        </div>
      )}
    />
  );
}

export function PhonesEditor({
  label,
  items,
  max,
  canEdit,
  onSave,
  className,
}: EditableList<ContactPhoneInput>) {
  const { t } = useI18n();
  const defaultCountry = useWorkspaceCountry();
  const types = ['mobile', 'work', 'home', 'fax', 'other'] as const;
  const normalized = (list: readonly ContactPhoneInput[]) =>
    list.map((item) => ({ ...item, number: normalizePhone(item.number, defaultCountry) }));
  return (
    <InlineEdit<ContactPhoneInput[]>
      label={label}
      value={[...items]}
      canEdit={canEdit}
      className={className}
      onSave={(list) => onSave(normalized(list))}
      validate={(list) =>
        normalized(list).every((item) => isE164(item.number)) ? null : t('locale.phone.invalid')
      }
      display={
        items.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="flex flex-col">
            {items.map((item) => {
              const shown = phoneDisplay(item.number);
              return (
                <a key={item.number} href={`tel:${item.number}`} className="hover:underline">
                  {shown.country ? (
                    <span aria-hidden className="mr-1.5">
                      {flagEmoji(shown.country)}
                    </span>
                  ) : null}
                  {shown.text}
                  {item.extension ? ` ext. ${item.extension}` : ''}
                  {item.type ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {t(`crm.phoneType.${item.type}`)}
                    </span>
                  ) : null}
                </a>
              );
            })}
          </span>
        )
      }
      editor={(draft, setDraft) => (
        <div className="grid gap-1.5">
          {draft.map((item, index) => (
            <div key={index} className="flex flex-wrap items-center gap-1.5">
              <PhoneInput
                value={item.number}
                defaultCountry={defaultCountry}
                ariaLabel={`${label} ${String(index + 1)}`}
                autoFocus={index === draft.length - 1 && item.number === ''}
                className="w-full max-w-72"
                onChange={(number) =>
                  setDraft(draft.map((d, i) => (i === index ? { ...d, number } : d)))
                }
              />
              <Input
                value={item.extension ?? ''}
                placeholder="ext."
                aria-label={t('crm.contact.extension')}
                className="h-8 w-16"
                onChange={(e) =>
                  setDraft(
                    draft.map((d, i) =>
                      i === index
                        ? e.target.value
                          ? { ...d, extension: e.target.value }
                          : { number: d.number, ...(d.type ? { type: d.type } : {}) }
                        : d,
                    ),
                  )
                }
              />
              <ChoiceSelect
                value={item.type ?? ''}
                ariaLabel={t('crm.contact.phoneType')}
                className="w-28 min-w-0"
                choices={types.map((value) => ({ value, label: t(`crm.phoneType.${value}`) }))}
                onChange={(value) =>
                  setDraft(
                    draft.map((d, i) =>
                      i === index
                        ? value === ''
                          ? { number: d.number, ...(d.extension ? { extension: d.extension } : {}) }
                          : { ...d, type: value as (typeof types)[number] }
                        : d,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t('crm.common.remove')}
                onClick={() => setDraft(draft.filter((_, i) => i !== index))}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          {draft.length < max ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => setDraft([...draft, { number: '' }])}
            >
              <Plus className="size-3.5" aria-hidden /> {t('crm.contact.addPhone')}
            </Button>
          ) : null}
        </div>
      )}
    />
  );
}

export function toEmailInputs(contact: Contact): ContactEmailInput[] {
  return contact.emails.map((e) =>
    e.label === 'work' || e.label === 'personal' || e.label === 'other'
      ? { email: e.email, label: e.label }
      : { email: e.email },
  );
}

export function toPhoneInputs(contact: Contact): ContactPhoneInput[] {
  const types = ['mobile', 'work', 'home', 'fax', 'other'];
  return contact.phones.map((p) => ({
    number: p.number,
    ...(p.extension ? { extension: p.extension } : {}),
    ...(p.type && types.includes(p.type) ? { type: p.type as ContactPhoneInput['type'] } : {}),
  }));
}

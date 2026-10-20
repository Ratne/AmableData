import type { AddressInput, Contact } from '@amable/api-types/crm';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Plus, X } from 'lucide-react';
import { CountrySelect } from '../../../../components/locale/country-select';
import { useWorkspaceCountry } from '../../../workspace/api';
import { useI18n } from '../../../../i18n';
import { AddressSearch } from '../../components/address-search';
import { InlineEdit } from '../../components/inline-field';
import { ChoiceSelect } from '../../components/inputs';
import type { EditableList } from './emails-phones';

type AddressTextKey = 'line1' | 'street_number' | 'line2' | 'postal_code' | 'locality' | 'region';

/** Text fields of the address editor and their width on its 6-column grid. */
const ADDRESS_FIELDS: readonly { key: AddressTextKey; span: string; maxLength?: number }[] = [
  { key: 'line1', span: 'col-span-4' },
  { key: 'street_number', span: 'col-span-2', maxLength: 20 },
  { key: 'line2', span: 'col-span-6' },
  { key: 'postal_code', span: 'col-span-2', maxLength: 20 },
  { key: 'locality', span: 'col-span-4' },
  { key: 'region', span: 'col-span-6' },
];

/** Countries that write the house number before the street name. */
const NUMBER_FIRST = new Set([
  'US',
  'CA',
  'GB',
  'IE',
  'AU',
  'NZ',
  'FR',
  'LU',
  'IL',
  'PH',
  'SG',
  'MY',
  'TH',
]);

function streetText(address: AddressInput): string | null {
  const { line1, street_number: number } = address;
  if (!number) return line1 ?? null;
  if (!line1) return number;
  return address.country_code && NUMBER_FIRST.has(address.country_code.toUpperCase())
    ? `${number} ${line1}`
    : `${line1} ${number}`;
}

function addressText(address: AddressInput): string {
  return [
    streetText(address),
    address.line2,
    [address.postal_code, address.locality].filter(Boolean).join(' '),
    address.region,
    address.country_code,
  ]
    .filter(Boolean)
    .join(', ');
}

export function AddressesEditor({
  label,
  items,
  max,
  canEdit,
  onSave,
  className,
}: EditableList<AddressInput>) {
  const { t } = useI18n();
  const defaultCountry = useWorkspaceCountry();
  return (
    <InlineEdit<AddressInput[]>
      label={label}
      value={[...items]}
      canEdit={canEdit}
      className={className}
      stackWhileEditing
      onSave={(list) =>
        onSave(
          list.map((address) => ({
            ...address,
            country_code: address.country_code ? address.country_code.toUpperCase() : null,
          })),
        )
      }
      validate={(list) =>
        list.every((a) => !a.country_code || /^[A-Za-z]{2}$/.test(a.country_code))
          ? null
          : t('crm.validation.country')
      }
      display={
        items.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="flex flex-col">
            {items.map((address, index) => (
              <span key={index}>
                {addressText(address)}
                {address.type ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {t(`crm.addressType.${address.type}`)}
                  </span>
                ) : null}
              </span>
            ))}
          </span>
        )
      }
      editor={(draft, setDraft) => (
        <div className="grid gap-3">
          {draft.map((address, index) => (
            <fieldset key={index} className="grid grid-cols-6 gap-1.5 rounded-md border p-2">
              <CountrySelect
                value={address.country_code ?? ''}
                ariaLabel={t('crm.address.country_code')}
                className="col-span-6 h-8 w-full"
                onChange={(code) =>
                  setDraft(
                    draft.map((d, i) => (i === index ? { ...d, country_code: code || null } : d)),
                  )
                }
              />
              <AddressSearch
                country={address.country_code ?? defaultCountry}
                onPick={(found) =>
                  setDraft(
                    draft.map((d, i) =>
                      i === index
                        ? {
                            ...d,
                            line1: found.line1,
                            street_number: found.street_number,
                            locality: found.locality,
                            region: found.region,
                            postal_code: found.postal_code,
                            country_code: found.country_code,
                          }
                        : d,
                    ),
                  )
                }
              />
              {ADDRESS_FIELDS.map(({ key, span, maxLength }) => (
                <Input
                  key={key}
                  value={address[key] ?? ''}
                  placeholder={t(`crm.address.${key}`)}
                  aria-label={t(`crm.address.${key}`)}
                  className={cn('h-8', span)}
                  maxLength={maxLength}
                  onChange={(e) =>
                    setDraft(
                      draft.map((d, i) =>
                        i === index ? { ...d, [key]: e.target.value || null } : d,
                      ),
                    )
                  }
                />
              ))}
              <div className="col-span-6 flex items-center gap-1.5">
                <ChoiceSelect
                  value={address.type ?? ''}
                  ariaLabel={t('crm.contact.addressType')}
                  choices={(['billing', 'shipping', 'other'] as const).map((value) => ({
                    value,
                    label: t(`crm.addressType.${value}`),
                  }))}
                  onChange={(value) =>
                    setDraft(
                      draft.map((d, i) =>
                        i === index
                          ? { ...d, type: (value || 'other') as 'billing' | 'shipping' | 'other' }
                          : d,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setDraft(draft.filter((_, i) => i !== index))}
                >
                  <X className="size-3.5" aria-hidden /> {t('crm.common.remove')}
                </Button>
              </div>
            </fieldset>
          ))}
          {draft.length < max ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => setDraft([...draft, { type: 'other', country_code: defaultCountry }])}
            >
              <Plus className="size-3.5" aria-hidden /> {t('crm.contact.addAddress')}
            </Button>
          ) : null}
        </div>
      )}
    />
  );
}

export function toAddressInputs(contact: Contact): AddressInput[] {
  return contact.addresses.map((a) => ({
    type: (['billing', 'shipping', 'other'].includes(a.type)
      ? a.type
      : 'other') as AddressInput['type'],
    line1: a.line1,
    street_number: a.street_number,
    line2: a.line2,
    locality: a.locality,
    region: a.region,
    postal_code: a.postal_code,
    country_code: a.country_code,
  }));
}

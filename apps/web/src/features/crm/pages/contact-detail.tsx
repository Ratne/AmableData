import {
  MARKETABLE_STATUSES,
  SOURCE_TYPES,
  type AddressInput,
  type Contact,
  type ContactEmailInput,
  type ContactPhoneInput,
  type CustomFieldValueInput,
  type UpdateContactInput,
} from '@amable/api-types/crm';
import {
  cn,
  DashboardButton,
  DashboardConfirmDialog,
  PageBody,
  toast,
  usePageChrome,
} from '@amable/ui';
import { Avatar, AvatarFallback } from '@amable/ui/ui/avatar';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { Permission } from '@amable/core';
import { GitMerge, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ContactOrdersPanel } from '../../commerce';
import { ContactSignaturesPanel } from '../../esign';
import { CountrySelect } from '../../../components/locale/country-select';
import { LanguageSelect } from '../../../components/locale/language-select';
import { languageName, nativeLanguageName } from '../../../components/locale/languages';
import {
  flagEmoji,
  isE164,
  normalizePhone,
  phoneDisplay,
} from '../../../components/locale/phone-countries';
import { PhoneInput } from '../../../components/locale/phone-input';
import { useWorkspaceCountry } from '../../workspace/api';
import { TimeZoneSelect } from '../../../components/locale/timezone-select';
import { timeZoneLabel } from '../../../components/locale/timezones';
import { useI18n } from '../../../i18n';
import {
  crmKeys,
  useCrm,
  useCrmMutation,
  useCustomFieldLayout,
  useDirectory,
  useLeadSources,
  usePermissions,
} from '../api/hooks';
import { useContactCounts } from '../api/contact-tabs';
import { AddressSearch } from '../components/address-search';
import { formatDate } from '../components/cells';
import { CompanyPicker } from '../components/company-picker';
import { contactName, MergeDialog } from '../components/contact-dialogs';
import {
  InlineChoice,
  InlineDate,
  InlineEdit,
  InlineText,
  InlineUser,
} from '../components/inline-field';
import {
  ContactAutomationsPanel,
  ContactEmailsPanel,
  ContactSubmissionsPanel,
  ContactTagsPanel,
} from '../components/contact-tabs';
import { ChoiceSelect } from '../components/inputs';
import {
  AppointmentsPanel,
  DealsPanel,
  NotesPanel,
  TasksPanel,
  TimelinePanel,
} from '../components/record-panels';
import { ContactJourneySlot } from '../components/journey-slot';
import { ErrorNotice, PageState, SectionCard } from '../components/states';
import { ContactAppActions, ContactAppCards } from '../../apps/slots';
import { ContactConversations } from '../../conversations/contact-panel';
import { customFieldTabsOf, CustomFieldsSection } from '../custom-fields/custom-fields-panel';
import {
  CONTACT_TABS,
  isCustomFieldTab,
  type ContactDetailSearch,
  type ContactTab,
  type CustomFieldContactTab,
  type FixedContactTab,
} from '../routes';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Narrower label column for the three-column personal data grid. */
const FIELD = 'sm:grid-cols-[7rem_1fr]';

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

type EditableList<T> = {
  readonly label: string;
  readonly items: readonly T[];
  readonly max: number;
  readonly canEdit: boolean;
  readonly onSave: (items: T[]) => Promise<unknown>;
  readonly className?: string;
};

function EmailsEditor({
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

function PhonesEditor({
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
const NUMBER_FIRST = new Set(['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'FR', 'LU', 'IL', 'PH', 'SG', 'MY', 'TH']);

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

function AddressesEditor({
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
                  setDraft(draft.map((d, i) => (i === index ? { ...d, country_code: code || null } : d)))
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

function toEmailInputs(contact: Contact): ContactEmailInput[] {
  return contact.emails.map((e) =>
    e.label === 'work' || e.label === 'personal' || e.label === 'other'
      ? { email: e.email, label: e.label }
      : { email: e.email },
  );
}

function toPhoneInputs(contact: Contact): ContactPhoneInput[] {
  const types = ['mobile', 'work', 'home', 'fax', 'other'];
  return contact.phones.map((p) => ({
    number: p.number,
    ...(p.extension ? { extension: p.extension } : {}),
    ...(p.type && types.includes(p.type) ? { type: p.type as ContactPhoneInput['type'] } : {}),
  }));
}

function toAddressInputs(contact: Contact): AddressInput[] {
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

function LanguageDisplay({ code, uiLocale }: { code: string; uiLocale: string }) {
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

type SaveContact = (input: UpdateContactInput) => Promise<unknown>;

function MarketingFields({
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

const UNGROUPED_TAB: CustomFieldContactTab = 'cf:other';

/** One custom field layout tab (`cf:<id>`) or the ungrouped fields (`cf:other`). */
function CustomFieldsTab({
  tab,
  contact,
  canEdit,
  save,
}: {
  tab: CustomFieldContactTab;
  contact: Contact;
  canEdit: boolean;
  save: SaveContact;
}) {
  const { can } = usePermissions();
  const layout = useCustomFieldLayout('contacts');
  if (layout.error) return <ErrorNotice error={layout.error} />;
  if (!layout.data) return <Skeleton className="h-24 w-full" />;
  return (
    <CustomFieldsSection
      layout={layout.data}
      tabId={tab === UNGROUPED_TAB ? null : tab.slice(3)}
      values={contact.custom_fields}
      canEdit={canEdit}
      canReadSensitive={can('contacts:read_sensitive')}
      onSave={(key: string, value: CustomFieldValueInput) =>
        save({ custom_fields: { [key]: value } })
      }
    />
  );
}

/** Custom field layout tabs shown next to the fixed ones (layout is reference data, cached). */
function useCustomFieldTabs(): { readonly id: CustomFieldContactTab; readonly label: string }[] {
  const { t } = useI18n();
  const layout = useCustomFieldLayout('contacts').data;
  if (!layout) return [];
  const tabs = customFieldTabsOf(layout).map((tab) => ({
    id: `cf:${tab.id}` as const,
    label: tab.name,
  }));
  return layout.ungrouped.length > 0
    ? [...tabs, { id: UNGROUPED_TAB, label: t('crm.customFields.other') }]
    : tabs;
}

/** Permission needed to see a tab (none: every reader of the contact). */
const TAB_PERMISSION: Partial<Record<FixedContactTab, Permission>> = {
  tasks: 'tasks:read',
  appointments: 'tasks:read',
  deals: 'opportunities:read',
  orders: 'orders:read',
  signatures: 'esign:read',
  submissions: 'forms:read',
  automations: 'automations:read',
  journey: 'analytics:journey_read',
};

/**
 * Tab strip of the contact page: only the open tab is mounted, so each panel
 * fetches its data when first opened; `?tab=` keeps the choice in the URL.
 */
function ContactTabs({
  contactId,
  children,
  customField,
}: {
  contactId: string;
  children: Readonly<Record<FixedContactTab, ReactNode>>;
  customField: (tab: CustomFieldContactTab) => ReactNode;
}) {
  const { t } = useI18n();
  const { can, ready } = usePermissions();
  const { slug } = useCrm();
  const navigate = useNavigate();
  const search: ContactDetailSearch = useSearch({ strict: false });
  const counts = useContactCounts(contactId).data;
  const customTabs = useCustomFieldTabs();
  const fixed = CONTACT_TABS.filter((tab) => {
    const permission = TAB_PERMISSION[tab];
    return permission === undefined || can(permission);
  });
  const visible: { readonly id: ContactTab; readonly label: string }[] = [
    ...fixed.map((id) => ({ id, label: t(`crm.contact.tab.${id}`) })),
    ...customTabs,
  ];
  const requested = search.tab;
  const active: ContactTab =
    requested !== undefined &&
    (visible.some((tab) => tab.id === requested) ||
      (requested.startsWith('cf:') && customTabs.length === 0))
      ? requested
      : 'activity';
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = strip.current;
    const trigger = scroller?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!scroller || !trigger) return;
    const left =
      trigger.getBoundingClientRect().left -
      scroller.getBoundingClientRect().left +
      scroller.scrollLeft;
    if (
      left < scroller.scrollLeft ||
      left + trigger.offsetWidth > scroller.scrollLeft + scroller.clientWidth
    ) {
      scroller.scrollLeft = left - 16;
    }
  }, [active, ready]);
  const countOf: Partial<Record<FixedContactTab, number | undefined>> = {
    tags: counts?.tags,
    notes: counts?.notes,
    tasks: counts?.tasks_open,
    appointments: counts?.appointments,
    deals: counts?.opportunities,
    orders: counts?.orders,
    submissions: counts?.submissions,
    emails: counts?.emails,
    signatures: counts?.signatures,
  };
  /** Text and tooltip of the badge next to a tab label (none when there is nothing to count). */
  const badgeOf = (tab: FixedContactTab): { text: string; title?: string } | null => {
    if (tab === 'automations') {
      const active = counts?.automations_active;
      const total = counts?.automations_total;
      if (active === undefined || total === undefined || total === 0) return null;
      return {
        text: active === total ? String(active) : `${String(active)}/${String(total)}`,
        title: t('crm.contactAutomations.countTitle', { active, total }),
      };
    }
    const count = countOf[tab];
    return count === undefined || count === 0 ? null : { text: String(count) };
  };
  return (
    <div className="min-w-0 rounded-xl border bg-card p-4">
      <Tabs
        value={active}
        onValueChange={(value) =>
          void navigate({
            to: '/t/$tenant/contacts/$contactId',
            params: { tenant: slug, contactId },
            search: value === 'activity' ? {} : { tab: value as ContactTab },
            replace: true,
            resetScroll: false,
          })
        }
      >
        <div ref={strip} className="-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:thin]">
          <TabsList className="w-max" aria-label={t('crm.contact.tabsLabel')}>
            {visible.map(({ id, label }) => {
              const badge = id.startsWith('cf:') ? null : badgeOf(id as FixedContactTab);
              return (
                <TabsTrigger key={id} value={id} className="flex-none">
                  {label}
                  {badge !== null ? (
                    <span
                      className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums"
                      title={badge.title}
                    >
                      {badge.text}
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
        <TabsContent value={active} className="pt-3">
          {!ready ? (
            <Skeleton className="h-24 w-full" />
          ) : isCustomFieldTab(active) ? (
            customField(active)
          ) : (
            children[active]
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ContactView({ contact }: { contact: Contact }) {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const company = useQuery({
    queryKey: crmKeys.company(slug, contact.company_id ?? ''),
    queryFn: () => api.companies.get(contact.company_id ?? ''),
    enabled: contact.company_id !== null,
  });
  const [merging, setMerging] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canEdit = can('contacts:write');
  const name = contactName(contact, t('crm.contacts.unnamed'));

  const setContact = (next: Contact) =>
    queryClient.setQueryData(crmKeys.contact(slug, contact.id), next);
  const update = useCrmMutation({
    mutationFn: (input: UpdateContactInput) => api.contacts.update(contact.id, input),
    success: t('crm.common.saved'),
    onSuccess: setContact,
  });
  const save = (input: UpdateContactInput) => update.mutateAsync(input);
  const remove = useCrmMutation({
    mutationFn: () => api.contacts.remove(contact.id),
    onSuccess: () => {
      toast.success(t('list.deletedOne', { name }), {
        action: {
          label: t('list.undo'),
          onClick: () => {
            void api.contacts.restore(contact.id).then(() =>
              navigate({
                to: '/t/$tenant/contacts/$contactId',
                params: { tenant: slug, contactId: contact.id },
              }),
            );
          },
        },
      });
      void navigate({ to: '/t/$tenant/contacts', params: { tenant: slug } });
    },
  });

  const text = (
    field: keyof UpdateContactInput,
    label: string,
    value: string | null,
    type?: 'email' | 'url' | 'tel',
  ) => (
    <InlineText
      label={label}
      value={value}
      canEdit={canEdit}
      type={type}
      className={FIELD}
      onSave={(next) => save({ [field]: next } as UpdateContactInput)}
    />
  );

  return (
    <PageBody className="grid gap-4 pt-4">
      <header className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4">
        <Avatar className="size-14 text-lg">
          <AvatarFallback>{initials(name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{name}</h2>
          <p className="text-sm text-muted-foreground">
            {[contact.job_title, company.data?.name].filter(Boolean).join(' · ') ||
              contact.emails[0]?.email}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ContactAppActions contactId={contact.id} />
          {can('contacts:merge') ? (
            <DashboardButton variant="ghost" onClick={() => setMerging(true)}>
              <GitMerge aria-hidden /> {t('crm.merge.title')}
            </DashboardButton>
          ) : null}
          {canEdit ? (
            <DashboardButton variant="ghost" onClick={() => setDeleting(true)}>
              <Trash2 aria-hidden /> {t('list.delete')}
            </DashboardButton>
          ) : null}
        </div>
      </header>

      <SectionCard title={t('crm.contact.details')} className="@container">
        <div className="grid gap-x-8 @xl:grid-cols-2 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="divide-y">
            {text('prefix', t('crm.field.prefix'), contact.prefix)}
            {text('given_name', t('crm.field.given_name'), contact.given_name)}
            {text('middle_name', t('crm.field.middle_name'), contact.middle_name)}
            {text('family_name', t('crm.field.family_name'), contact.family_name)}
            {text('suffix', t('crm.field.suffix'), contact.suffix)}
            {text('preferred_name', t('crm.field.preferred_name'), contact.preferred_name)}
            {text('job_title', t('crm.field.job_title'), contact.job_title)}
            <InlineEdit<{ id: string; name: string } | null>
              label={t('crm.field.company_id')}
              className={FIELD}
              value={
                contact.company_id && company.data
                  ? { id: contact.company_id, name: company.data.name }
                  : null
              }
              canEdit={canEdit}
              display={
                contact.company_id && company.data ? (
                  <Link
                    to="/t/$tenant/companies/$companyId"
                    params={{ tenant: slug, companyId: contact.company_id }}
                    className="hover:underline"
                  >
                    {company.data.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              }
              onSave={(next) => save({ company_id: next?.id ?? null })}
              editor={(draft, setDraft) => (
                <CompanyPicker
                  value={draft}
                  onChange={setDraft}
                  ariaLabel={t('crm.field.company_id')}
                />
              )}
            />
          </div>
          <div className="divide-y border-t @xl:border-t-0">
            <EmailsEditor
              label={t('crm.field.emails')}
              items={toEmailInputs(contact)}
              max={5}
              canEdit={canEdit}
              className={FIELD}
              onSave={(emails) =>
                save({ emails: emails.map((e) => ({ ...e, email: e.email.trim() })) })
              }
            />
            <PhonesEditor
              label={t('crm.contact.phones')}
              items={toPhoneInputs(contact)}
              max={5}
              canEdit={canEdit}
              className={FIELD}
              onSave={(phones) => save({ phones })}
            />
            <AddressesEditor
              label={t('crm.contact.addresses')}
              items={toAddressInputs(contact)}
              max={3}
              canEdit={canEdit}
              className={FIELD}
              onSave={(addresses) => save({ addresses })}
            />
            {text('website', t('crm.field.website'), contact.website, 'url')}
          </div>
          <div className="divide-y border-t @4xl:border-t-0">
            <InlineDate
              label={t('crm.field.birthday')}
              value={contact.birthday}
              display={contact.birthday ? formatDate(locale, `${contact.birthday}T12:00:00Z`) : ''}
              canEdit={canEdit}
              className={FIELD}
              onSave={(birthday) => save({ birthday })}
            />
            <InlineDate
              label={t('crm.field.anniversary')}
              value={contact.anniversary}
              display={
                contact.anniversary ? formatDate(locale, `${contact.anniversary}T12:00:00Z`) : ''
              }
              canEdit={canEdit}
              className={FIELD}
              onSave={(anniversary) => save({ anniversary })}
            />
            {text('spouse_name', t('crm.field.spouse_name'), contact.spouse_name)}
            <InlineEdit<string>
              label={t('crm.field.time_zone')}
              className={FIELD}
              value={contact.time_zone ?? ''}
              canEdit={canEdit}
              display={
                contact.time_zone ? (
                  timeZoneLabel(contact.time_zone)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              }
              onSave={(next) => save({ time_zone: next || null })}
              editor={(draft, setDraft, invalid) => (
                <TimeZoneSelect
                  value={draft}
                  onChange={setDraft}
                  invalid={invalid}
                  autoFocus
                  ariaLabel={t('crm.field.time_zone')}
                />
              )}
            />
            <InlineEdit<string>
              label={t('crm.field.preferred_locale')}
              className={FIELD}
              value={contact.preferred_locale ?? ''}
              canEdit={canEdit}
              display={
                contact.preferred_locale ? (
                  <LanguageDisplay code={contact.preferred_locale} uiLocale={locale} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              }
              onSave={(next) => save({ preferred_locale: next || null })}
              editor={(draft, setDraft, invalid) => (
                <LanguageSelect
                  value={draft}
                  onChange={setDraft}
                  invalid={invalid}
                  autoFocus
                  ariaLabel={t('crm.field.preferred_locale')}
                />
              )}
            />
          </div>
        </div>
      </SectionCard>

      <ContactAppCards contactId={contact.id} />

      <ContactConversations contactId={contact.id} />

      <p className="-mt-2 px-1 text-xs text-muted-foreground">
        {t('crm.contact.createdAt', { date: formatDate(locale, contact.created_at, true) })} ·{' '}
        {t('crm.contact.updatedAt', { date: formatDate(locale, contact.updated_at, true) })}
      </p>

      <ContactTabs
        contactId={contact.id}
        customField={(tab) => (
          <CustomFieldsTab tab={tab} contact={contact} canEdit={canEdit} save={save} />
        )}
      >
        {{
          activity: (
            <TimelinePanel subject={{ kind: 'contact', id: contact.id }} tagName={(id) => id} />
          ),
          tags: <ContactTagsPanel contactId={contact.id} />,
          notes: <NotesPanel subject={{ kind: 'contact', id: contact.id }} />,
          tasks: <TasksPanel subject={{ kind: 'contact', id: contact.id }} />,
          appointments: <AppointmentsPanel contactId={contact.id} />,
          deals: <DealsPanel contactId={contact.id} />,
          orders: <ContactOrdersPanel contactId={contact.id} limit={20} />,
          signatures: (
            <ContactSignaturesPanel
              contact={{
                id: contact.id,
                name,
                email: contact.emails.find((e) => e.is_primary)?.email ?? contact.emails[0]?.email ?? '',
              }}
            />
          ),
          submissions: <ContactSubmissionsPanel contactId={contact.id} />,
          emails: <ContactEmailsPanel contactId={contact.id} />,
          automations: <ContactAutomationsPanel contactId={contact.id} />,
          journey: <ContactJourneySlot contactId={contact.id} />,
          marketing: <MarketingFields contact={contact} canEdit={canEdit} save={save} />,
        }}
      </ContactTabs>

      {merging ? (
        <MergeDialog
          open
          initial={[{ id: contact.id, label: name }]}
          onOpenChange={setMerging}
          onMerged={(survivor) => {
            setMerging(false);
            if (survivor.id !== contact.id)
              void navigate({
                to: '/t/$tenant/contacts/$contactId',
                params: { tenant: slug, contactId: survivor.id },
              });
          }}
        />
      ) : null}
      <DashboardConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('list.confirmDeleteOne', { name })}
        description={t('list.confirmDeleteBody')}
        confirmLabel={t('list.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => remove.mutate(undefined)}
      />
    </PageBody>
  );
}

export function ContactDetailPage() {
  const { contactId } = useParams({ strict: false }) as { contactId: string };
  const { slug, api } = useCrm();
  const { t } = useI18n();
  const contact = useQuery({
    queryKey: crmKeys.contact(slug, contactId),
    queryFn: () => api.contacts.get(contactId),
    retry: false,
  });
  usePageChrome({ title: contact.data ? contactName(contact.data, '') : t('nav.contacts') });
  return (
    <PageState isPending={contact.isPending} error={contact.error}>
      {() => (contact.data ? <ContactView contact={contact.data} /> : null)}
    </PageState>
  );
}

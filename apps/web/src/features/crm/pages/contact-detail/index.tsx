import type { Contact, UpdateContactInput } from '@amable/api-types/crm';
import {
  DashboardButton,
  DashboardConfirmDialog,
  PageBody,
  toast,
  usePageChrome,
} from '@amable/ui';
import { Avatar, AvatarFallback } from '@amable/ui/ui/avatar';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { GitMerge, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ContactOrdersPanel } from '../../../commerce';
import { ContactSignaturesPanel } from '../../../esign';
import { LanguageSelect } from '../../../../components/locale/language-select';
import { TimeZoneSelect } from '../../../../components/locale/timezone-select';
import { timeZoneLabel } from '../../../../components/locale/timezones';
import { useI18n } from '../../../../i18n';
import { crmKeys, useCrm, useCrmMutation, usePermissions } from '../../api/hooks';
import { formatDate } from '../../components/cells';
import { CompanyPicker } from '../../components/company-picker';
import { contactName, MergeDialog } from '../../components/contact-dialogs';
import { InlineDate, InlineEdit, InlineText } from '../../components/inline-field';
import {
  ContactAutomationsPanel,
  ContactEmailsPanel,
  ContactSubmissionsPanel,
  ContactTagsPanel,
} from '../../components/contact-tabs';
import {
  AppointmentsPanel,
  DealsPanel,
  NotesPanel,
  TasksPanel,
  TimelinePanel,
} from '../../components/record-panels';
import { ContactJourneySlot } from '../../components/journey-slot';
import { PageState, SectionCard } from '../../components/states';
import { ContactAppActions, ContactAppCards } from '../../../apps/slots';
import { ContactConversations } from '../../../conversations/contact-panel';
import { AddressesEditor, toAddressInputs } from './addresses';
import {
  emailVerificationState,
  EmailsEditor,
  PhonesEditor,
  toEmailInputs,
  toPhoneInputs,
} from './emails-phones';
import { LanguageDisplay, MarketingFields } from './marketing';
import { CustomFieldsTab, ContactTabs } from './tabs';

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
              verification={emailVerificationState(contact)}
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
                email:
                  contact.emails.find((e) => e.is_primary)?.email ?? contact.emails[0]?.email ?? '',
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

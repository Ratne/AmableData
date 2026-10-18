import type { Company, CustomFieldValueInput, CustomFieldValues, UpdateCompanyInput } from '@amable/api-types/crm';
import { DashboardButton, DashboardConfirmDialog, PageBody, toast, usePageChrome } from '@amable/ui';
import { Avatar, AvatarFallback } from '@amable/ui/ui/avatar';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Building2, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import {
  crmKeys,
  useCrm,
  useCrmMutation,
  useCustomFieldLayout,
  useDirectory,
  usePermissions,
} from '../api/hooks';
import { formatDate } from '../components/cells';
import { contactName, CreateContactDialog } from '../components/contact-dialogs';
import { InlineEdit, InlineText, InlineUser } from '../components/inline-field';
import { NotesPanel, TimelinePanel } from '../components/record-panels';
import { PageState, SectionCard } from '../components/states';
import { CustomFieldsPanel } from '../custom-fields/custom-fields-panel';
import { RequiredCustomFields, useRequiredCustomFields } from '../custom-fields/required-fields';
import { RecordSearchView, type SearchRow } from './record-search-view';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function CreateCompanyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (company: Company) => void;
}) {
  const { t } = useI18n();
  const { api } = useCrm();
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const required = useRequiredCustomFields('companies');
  const create = useCrmMutation({
    mutationFn: (customFields: CustomFieldValues) =>
      api.companies.create({
        name: name.trim(),
        ...(website.trim() ? { website: website.trim() } : {}),
        ...(Object.keys(customFields).length > 0 ? { custom_fields: customFields } : {}),
      }),
    success: t('crm.companies.created'),
    onSuccess: (company) => {
      setName('');
      setWebsite('');
      required.reset();
      onCreated(company);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const customFields = required.collect();
    if (customFields !== null) create.mutate(customFields);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('crm.companies.new')}</DialogTitle>
            <DialogDescription>{t('crm.companies.newBody')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="company-name">{t('crm.common.name')}</Label>
            <Input
              id="company-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="company-website">{t('crm.field.website')}</Label>
            <Input
              id="company-website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>
          <RequiredCustomFields state={required} disabled={create.isPending} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {t('crm.common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CompaniesListPage() {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const search: { saved?: unknown } = useSearch({ strict: false });
  usePageChrome({ title: t('nav.companies') });
  const refresh = () => queryClient.invalidateQueries({ queryKey: crmKeys.root(slug) });
  const open = (id: string) =>
    void navigate({
      to: '/t/$tenant/companies/$companyId',
      params: { tenant: slug, companyId: id },
    });

  return (
    <>
      <RecordSearchView
        entity="company"
        initialSavedId={typeof search.saved === 'string' ? search.saved : undefined}
        requiredColumns={['name']}
        defaultColumns={['website', 'email', 'phone', 'owner_id', 'contact_count', 'created_at']}
        nameColumn={{
          header: t('crm.common.name'),
          sortField: 'name',
          render: (row: SearchRow) => (
            <span className="flex items-center gap-2 font-medium">
              <Building2 className="size-4 text-muted-foreground" aria-hidden />
              {text(row['name'])}
            </span>
          ),
        }}
        rowLabel={(row) => text(row['name'])}
        onOpen={(row) => open(row.id)}
        deletion={
          can('contacts:write')
            ? {
                onDelete: async (rows) => {
                  await Promise.all(rows.map((row) => api.companies.remove(row.id)));
                  await refresh();
                },
                onUndo: async (rows) => {
                  await Promise.all(rows.map((row) => api.companies.restore(row.id)));
                  await refresh();
                },
              }
            : undefined
        }
        toolbarActions={
          can('contacts:write') ? (
            <DashboardButton variant="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden /> {t('crm.companies.new')}
            </DashboardButton>
          ) : null
        }
      />
      <CreateCompanyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(company) => {
          setCreating(false);
          open(company.id);
        }}
      />
    </>
  );
}

function CompanyContacts({ companyId }: { companyId: string }) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const contacts = useQuery({
    queryKey: [...crmKeys.contacts(slug), 'company', companyId],
    queryFn: () => api.contacts.list({ company_id: companyId, limit: 100 }),
  });
  return (
    <div className="grid gap-2">
      {can('contacts:write') ? (
        <div>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden /> {t('crm.contacts.new')}
          </Button>
        </div>
      ) : null}
      <ul className="divide-y">
        {(contacts.data?.data ?? []).map((contact) => (
          <li key={contact.id} className="py-1.5 text-sm">
            <Link
              to="/t/$tenant/contacts/$contactId"
              params={{ tenant: slug, contactId: contact.id }}
              className="hover:underline"
            >
              {contactName(contact, t('crm.contacts.unnamed'))}
            </Link>
            {contact.job_title ? (
              <span className="ml-2 text-xs text-muted-foreground">{contact.job_title}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {!contacts.isPending && (contacts.data?.data.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">{t('crm.companies.noContacts')}</p>
      ) : null}
      <CreateContactDialog
        open={creating}
        onOpenChange={setCreating}
        companyId={companyId}
        onCreated={(contact) => {
          setCreating(false);
          void navigate({
            to: '/t/$tenant/contacts/$contactId',
            params: { tenant: slug, contactId: contact.id },
          });
        }}
      />
    </div>
  );
}

function CompanyView({ company }: { company: Company }) {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { nameOf } = useDirectory();
  const layout = useCustomFieldLayout('companies');
  const [deleting, setDeleting] = useState(false);
  const canEdit = can('contacts:write');
  const update = useCrmMutation({
    mutationFn: (input: UpdateCompanyInput) => api.companies.update(company.id, input),
    success: t('crm.common.saved'),
    onSuccess: (next) => queryClient.setQueryData(crmKeys.company(slug, company.id), next),
  });
  const save = (input: UpdateCompanyInput) => update.mutateAsync(input);
  const remove = useCrmMutation({
    mutationFn: () => api.companies.remove(company.id),
    onSuccess: () => {
      toast.success(t('list.deletedOne', { name: company.name }), {
        action: {
          label: t('list.undo'),
          onClick: () => {
            void api.companies.restore(company.id).then(() =>
              navigate({
                to: '/t/$tenant/companies/$companyId',
                params: { tenant: slug, companyId: company.id },
              }),
            );
          },
        },
      });
      void navigate({ to: '/t/$tenant/companies', params: { tenant: slug } });
    },
  });
  const address = company.address;
  const field = (key: 'website' | 'email' | 'phone' | 'phone_extension' | 'fax', label: string) => (
    <InlineText
      label={label}
      value={company[key]}
      canEdit={canEdit}
      type={
        key === 'email'
          ? 'email'
          : key === 'website'
            ? 'url'
            : key === 'phone' || key === 'fax'
              ? 'tel'
              : 'text'
      }
      onSave={(value) => save({ [key]: value })}
    />
  );

  return (
    <PageBody className="grid gap-4 pt-4">
      <header className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4">
        <Avatar className="size-14">
          <AvatarFallback>
            <Building2 className="size-6" aria-hidden />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{company.name}</h2>
          <p className="text-sm text-muted-foreground">
            {t('crm.companies.contactCount', { count: company.contact_count })}
          </p>
        </div>
        {canEdit ? (
          <DashboardButton variant="ghost" onClick={() => setDeleting(true)}>
            <Trash2 aria-hidden /> {t('list.delete')}
          </DashboardButton>
        ) : null}
      </header>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_1fr]">
        <div className="grid content-start gap-4">
          <SectionCard title={t('crm.contact.details')}>
            <div className="divide-y">
              <InlineText
                label={t('crm.common.name')}
                value={company.name}
                canEdit={canEdit}
                validate={(value) => (value.trim() ? null : t('crm.validation.required'))}
                onSave={(name) => save({ name: name ?? company.name })}
              />
              {field('website', t('crm.field.website'))}
              {field('email', t('crm.field.email'))}
              {field('phone', t('crm.field.phone'))}
              {field('phone_extension', t('crm.contact.extension'))}
              {field('fax', t('crm.companies.fax'))}
              <InlineEdit<string>
                label={t('crm.contact.addresses')}
                value={JSON.stringify(address ?? {})}
                canEdit={canEdit}
                display={
                  address
                    ? [
                        address.line1,
                        address.line2,
                        [address.postal_code, address.locality].filter(Boolean).join(' '),
                        address.region,
                        address.country_code,
                      ]
                        .filter(Boolean)
                        .join(', ') || '—'
                    : '—'
                }
                onSave={(json) =>
                  save({ address: JSON.parse(json) as UpdateCompanyInput['address'] })
                }
                editor={(draft, setDraft) => {
                  const current = JSON.parse(draft) as Record<string, string | null>;
                  return (
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {(
                        [
                          'line1',
                          'line2',
                          'locality',
                          'region',
                          'postal_code',
                          'country_code',
                        ] as const
                      ).map((key) => (
                        <Input
                          key={key}
                          value={current[key] ?? ''}
                          placeholder={t(`crm.address.${key}`)}
                          aria-label={t(`crm.address.${key}`)}
                          maxLength={key === 'country_code' ? 2 : undefined}
                          className="h-8"
                          onChange={(e) =>
                            setDraft(
                              JSON.stringify({
                                ...current,
                                [key]:
                                  key === 'country_code'
                                    ? e.target.value.toUpperCase() || null
                                    : e.target.value || null,
                              }),
                            )
                          }
                        />
                      ))}
                    </div>
                  );
                }}
              />
              <InlineEdit<string>
                label={t('crm.field.description')}
                value={company.description ?? ''}
                canEdit={canEdit}
                display={
                  company.description ? (
                    <span className="whitespace-pre-wrap">{company.description}</span>
                  ) : (
                    '—'
                  )
                }
                onSave={(description) => save({ description: description.trim() || null })}
                editor={(draft, setDraft) => (
                  <Textarea
                    value={draft}
                    rows={4}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                  />
                )}
              />
              <InlineUser
                label={t('crm.field.owner_id')}
                value={company.owner_id}
                display={nameOf(company.owner_id)}
                canEdit={canEdit}
                onSave={(owner_id) => save({ owner_id })}
              />
            </div>
          </SectionCard>
          <SectionCard title={t('crm.customFields.title')}>
            {layout.data ? (
              <CustomFieldsPanel
                layout={layout.data}
                values={company.custom_fields}
                canEdit={canEdit}
                canReadSensitive={can('contacts:read_sensitive')}
                onSave={(key: string, value: CustomFieldValueInput) =>
                  save({ custom_fields: { [key]: value } })
                }
              />
            ) : null}
          </SectionCard>
          <p className="px-1 text-xs text-muted-foreground">
            {t('crm.contact.createdAt', { date: formatDate(locale, company.created_at, true) })}
          </p>
        </div>
        <div className="min-w-0 rounded-xl border bg-card p-4">
          <Tabs defaultValue="contacts">
            <TabsList>
              <TabsTrigger value="contacts">{t('nav.contacts')}</TabsTrigger>
              <TabsTrigger value="notes">{t('crm.contact.tab.notes')}</TabsTrigger>
              <TabsTrigger value="activity">{t('crm.contact.tab.activity')}</TabsTrigger>
            </TabsList>
            <TabsContent value="contacts" className="pt-3">
              <CompanyContacts companyId={company.id} />
            </TabsContent>
            <TabsContent value="notes" className="pt-3">
              <NotesPanel subject={{ kind: 'company', id: company.id }} />
            </TabsContent>
            <TabsContent value="activity" className="pt-3">
              <TimelinePanel
                subject={{ kind: 'company', id: company.id }}
                tagName={(id) => id}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
      <DashboardConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('list.confirmDeleteOne', { name: company.name })}
        description={t('list.confirmDeleteBody')}
        confirmLabel={t('list.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => remove.mutate(undefined)}
      />
    </PageBody>
  );
}

export function CompanyDetailPage() {
  const { companyId } = useParams({ strict: false }) as { companyId: string };
  const { slug, api } = useCrm();
  const { t } = useI18n();
  const company = useQuery({
    queryKey: crmKeys.company(slug, companyId),
    queryFn: () => api.companies.get(companyId),
    retry: false,
  });
  usePageChrome({ title: company.data?.name ?? t('nav.companies') });
  return (
    <PageState isPending={company.isPending} error={company.error}>
      {() => (company.data ? <CompanyView company={company.data} /> : null)}
    </PageState>
  );
}

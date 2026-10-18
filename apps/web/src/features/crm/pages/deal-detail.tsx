import { isCurrencyCode } from '@amable/api-types';
import type {
  CustomFieldValueInput,
  Opportunity,
  Pipeline,
  UpdateOpportunityInput,
} from '@amable/api-types/crm';
import { DashboardButton, DashboardConfirmDialog, PageBody, toast, usePageChrome } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Input } from '@amable/ui/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowRight, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { CurrencySelect } from '../../commerce/components/currency-select';
import {
  crmKeys,
  useCrm,
  useCrmMutation,
  useCustomFieldLayout,
  useDirectory,
  usePermissions,
  usePipelines,
} from '../api/hooks';
import { formatDate, formatMoney } from '../components/cells';
import { CompanyPicker } from '../components/company-picker';
import { contactName } from '../components/contact-dialogs';
import {
  InlineChoice,
  InlineDate,
  InlineEdit,
  InlineText,
  InlineUser,
} from '../components/inline-field';
import { DateTimePicker } from '../components/inputs';
import { NotesPanel, TasksPanel, TimelinePanel } from '../components/record-panels';
import { PageState, SectionCard } from '../components/states';
import { CustomFieldsPanel } from '../custom-fields/custom-fields-panel';

/** Type-ahead over `GET /contacts?q=`; emits the chosen contact (or null to clear). */
function ContactPicker({
  value,
  onChange,
  ariaLabel,
}: {
  value: { id: string; name: string } | null;
  onChange: (contact: { id: string; name: string } | null) => void;
  ariaLabel: string;
}) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const [q, setQ] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const results = useQuery({
    queryKey: [...crmKeys.contacts(slug), 'picker', q],
    queryFn: () => api.contacts.list({ q, limit: 8 }),
    enabled: open && q.trim().length >= 2,
  });
  return (
    <div className="relative">
      <Input
        value={q}
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        autoFocus
        placeholder={t('crm.merge.searchPlaceholder')}
        className="h-8"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQ(event.target.value);
          setOpen(true);
          if (event.target.value === '') onChange(null);
        }}
      />
      {open && (results.data?.data.length ?? 0) > 0 ? (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {(results.data?.data ?? []).map((contact) => {
            const name = contactName(contact, contact.id);
            return (
              <li key={contact.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={contact.id === value?.id}
                  className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    onChange({ id: contact.id, name });
                    setQ(name);
                    setOpen(false);
                  }}
                >
                  {name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {contact.emails[0]?.email ?? ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Stage moves read from the opportunity timeline (`opportunity.stage_changed`). */
function StageHistory({ deal, pipeline }: { deal: Opportunity; pipeline: Pipeline | undefined }) {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { nameOf } = useDirectory();
  const timeline = useQuery({
    queryKey: [...crmKeys.timeline(slug, 'opportunity', deal.id), 'stages'],
    queryFn: () => api.opportunities.timeline(deal.id, { limit: 200 }),
  });
  const stageName = (id: unknown) =>
    typeof id === 'string' ? (pipeline?.stages.find((s) => s.id === id)?.name ?? '—') : '—';
  const moves = (timeline.data?.data ?? []).filter((a) => a.type === 'opportunity.stage_changed');
  return (
    <ol className="grid gap-2">
      {moves.map((move) => (
        <li key={move.id} className="flex flex-wrap items-center gap-1.5 text-sm">
          <Badge variant="outline">{stageName(move.data['fromStageId'])}</Badge>
          <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
          <Badge variant="secondary">{stageName(move.data['toStageId'])}</Badge>
          <span className="text-xs text-muted-foreground">
            {formatDate(locale, move.occurred_at, true)}
            {move.actor.type === 'user' && move.actor.id ? ` · ${nameOf(move.actor.id)}` : ''}
          </span>
        </li>
      ))}
      <li className="text-xs text-muted-foreground">
        {t('crm.deals.createdIn', {
          stage:
            moves.length > 0
              ? stageName(moves[moves.length - 1]?.data['fromStageId'])
              : stageName(deal.stage_id),
          date: formatDate(locale, deal.created_at, true),
        })}
      </li>
    </ol>
  );
}

function DealView({ deal }: { deal: Opportunity }) {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { nameOf } = useDirectory();
  const pipelines = usePipelines();
  const layout = useCustomFieldLayout('opportunities');
  const [deleting, setDeleting] = useState(false);
  const canEdit = can('opportunities:write');
  const pipeline = pipelines.data?.find((p) => p.id === deal.pipeline_id);
  const stage = pipeline?.stages.find((s) => s.id === deal.stage_id);
  const contact = useQuery({
    queryKey: crmKeys.contact(slug, deal.contact_id ?? ''),
    queryFn: () => api.contacts.get(deal.contact_id ?? ''),
    enabled: deal.contact_id !== null,
  });
  const company = useQuery({
    queryKey: crmKeys.company(slug, deal.company_id ?? ''),
    queryFn: () => api.companies.get(deal.company_id ?? ''),
    enabled: deal.company_id !== null,
  });
  const update = useCrmMutation({
    mutationFn: (input: UpdateOpportunityInput) => api.opportunities.update(deal.id, input),
    success: t('crm.common.saved'),
    onSuccess: (next) =>
      queryClient.setQueryData([...crmKeys.opportunities(slug), 'detail', deal.id], next),
  });
  const save = (input: UpdateOpportunityInput) => update.mutateAsync(input);
  const remove = useCrmMutation({
    mutationFn: () => api.opportunities.remove(deal.id),
    onSuccess: () => {
      toast.success(t('list.deletedOne', { name: deal.title }), {
        action: {
          label: t('list.undo'),
          onClick: () => {
            void api.opportunities.restore(deal.id).then(() =>
              navigate({
                to: '/t/$tenant/deals/$dealId',
                params: { tenant: slug, dealId: deal.id },
              }),
            );
          },
        },
      });
      void navigate({ to: '/t/$tenant/deals', params: { tenant: slug } });
    },
  });
  const dash = <span className="text-muted-foreground">—</span>;
  const contactLabel = contact.data ? contactName(contact.data, t('crm.contacts.unnamed')) : null;

  return (
    <PageBody className="grid gap-4 pt-4">
      <header className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{deal.title}</h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="tabular-nums text-foreground">
              {formatMoney(locale, deal.value_minor, deal.currency)}
            </span>
            {pipeline ? <span>{pipeline.name}</span> : null}
            {stage ? (
              <Badge
                variant={
                  deal.status === 'won'
                    ? 'default'
                    : deal.status === 'lost'
                      ? 'outline'
                      : 'secondary'
                }
              >
                {stage.name} · {stage.probability}%
              </Badge>
            ) : null}
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
                label={t('crm.deals.title')}
                value={deal.title}
                canEdit={canEdit}
                validate={(value) => (value.trim() ? null : t('crm.validation.required'))}
                onSave={(title) => save({ title: title ?? deal.title })}
              />
              <InlineText
                label={t('crm.deals.value')}
                value={(deal.value_minor / 100).toFixed(2)}
                canEdit={canEdit}
                validate={(value) =>
                  /^\d+([.,]\d{1,2})?$/.test(value.trim()) ? null : t('crm.validation.number')
                }
                onSave={(value) =>
                  save({ value_minor: Math.round(Number((value ?? '0').replace(',', '.')) * 100) })
                }
              />
              <InlineEdit<string>
                label={t('crm.customFields.currency')}
                value={deal.currency}
                display={deal.currency}
                canEdit={canEdit}
                validate={(value) => (isCurrencyCode(value) ? null : t('crm.validation.currency'))}
                onSave={(value) => save({ currency: value })}
                editor={(draft, setDraft, invalid) => (
                  <CurrencySelect
                    value={draft}
                    onChange={setDraft}
                    invalid={invalid}
                    ariaLabel={t('crm.customFields.currency')}
                  />
                )}
              />
              <InlineChoice
                label={t('crm.deals.stage')}
                value={deal.stage_id}
                allowEmpty={false}
                canEdit={canEdit}
                choices={[...(pipeline?.stages ?? [])]
                  .sort((a, b) => a.position - b.position)
                  .map((s) => ({ value: s.id, label: s.name }))}
                onSave={(stageId) => (stageId ? save({ stage_id: stageId }) : Promise.resolve())}
              />
              <InlineUser
                label={t('crm.field.owner_id')}
                value={deal.owner_id}
                display={nameOf(deal.owner_id)}
                canEdit={canEdit}
                onSave={(owner_id) => save({ owner_id })}
              />
              <InlineEdit<{ id: string; name: string } | null>
                label={t('crm.deals.contact')}
                value={
                  deal.contact_id && contactLabel
                    ? { id: deal.contact_id, name: contactLabel }
                    : null
                }
                canEdit={canEdit}
                display={
                  deal.contact_id && contactLabel ? (
                    <Link
                      to="/t/$tenant/contacts/$contactId"
                      params={{ tenant: slug, contactId: deal.contact_id }}
                      className="hover:underline"
                    >
                      {contactLabel}
                    </Link>
                  ) : (
                    dash
                  )
                }
                onSave={(next) => save({ contact_id: next?.id ?? null })}
                editor={(draft, setDraft) => (
                  <ContactPicker
                    value={draft}
                    onChange={setDraft}
                    ariaLabel={t('crm.deals.contact')}
                  />
                )}
              />
              <InlineEdit<{ id: string; name: string } | null>
                label={t('crm.field.company_id')}
                value={
                  deal.company_id && company.data
                    ? { id: deal.company_id, name: company.data.name }
                    : null
                }
                canEdit={canEdit}
                display={
                  deal.company_id && company.data ? (
                    <Link
                      to="/t/$tenant/companies/$companyId"
                      params={{ tenant: slug, companyId: deal.company_id }}
                      className="hover:underline"
                    >
                      {company.data.name}
                    </Link>
                  ) : (
                    dash
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
              <InlineDate
                label={t('crm.deals.expectedClose')}
                value={deal.expected_close_date}
                display={
                  deal.expected_close_date
                    ? formatDate(locale, `${deal.expected_close_date}T12:00:00Z`)
                    : ''
                }
                canEdit={canEdit}
                onSave={(expected_close_date) => save({ expected_close_date })}
              />
              <InlineText
                label={t('crm.deals.nextAction')}
                value={deal.next_action}
                canEdit={canEdit}
                maxLength={500}
                onSave={(next_action) => save({ next_action })}
              />
              <InlineEdit<string>
                label={t('crm.deals.nextActionAt')}
                value={deal.next_action_at ?? ''}
                canEdit={canEdit}
                display={deal.next_action_at ? formatDate(locale, deal.next_action_at, true) : dash}
                onSave={(value) => save({ next_action_at: value === '' ? null : value })}
                editor={(draft, setDraft) => (
                  <DateTimePicker
                    value={draft}
                    onChange={setDraft}
                    ariaLabel={t('crm.deals.nextActionAt')}
                  />
                )}
              />
              {deal.status === 'lost' ? (
                <InlineText
                  label={t('crm.deals.lostReason')}
                  value={deal.lost_reason}
                  canEdit={canEdit}
                  maxLength={500}
                  onSave={(lost_reason) => save({ lost_reason })}
                />
              ) : null}
            </div>
          </SectionCard>
          <SectionCard title={t('crm.customFields.title')}>
            {layout.data ? (
              <CustomFieldsPanel
                layout={layout.data}
                values={deal.custom_fields}
                canEdit={canEdit}
                canReadSensitive={can('contacts:read_sensitive')}
                onSave={(key: string, value: CustomFieldValueInput) =>
                  save({ custom_fields: { [key]: value } })
                }
              />
            ) : null}
          </SectionCard>
          <SectionCard title={t('crm.deals.stageHistory')}>
            <StageHistory deal={deal} pipeline={pipeline} />
          </SectionCard>
        </div>
        <div className="min-w-0 rounded-xl border bg-card p-4">
          <Tabs defaultValue="notes">
            <TabsList>
              <TabsTrigger value="notes">{t('crm.contact.tab.notes')}</TabsTrigger>
              <TabsTrigger value="tasks">{t('crm.contact.tab.tasks')}</TabsTrigger>
              <TabsTrigger value="activity">{t('crm.contact.tab.activity')}</TabsTrigger>
            </TabsList>
            <TabsContent value="notes" className="pt-3">
              <NotesPanel subject={{ kind: 'opportunity', id: deal.id }} />
            </TabsContent>
            <TabsContent value="tasks" className="pt-3">
              {can('tasks:read') ? (
                <TasksPanel subject={{ kind: 'opportunity', id: deal.id }} />
              ) : null}
            </TabsContent>
            <TabsContent value="activity" className="pt-3">
              <TimelinePanel
                subject={{ kind: 'opportunity', id: deal.id }}
                tagName={(id) => id}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
      <DashboardConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('list.confirmDeleteOne', { name: deal.title })}
        description={t('crm.deals.confirmDeleteBody')}
        confirmLabel={t('list.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => remove.mutate(undefined)}
      />
    </PageBody>
  );
}

export function DealDetailPage() {
  const { dealId } = useParams({ strict: false }) as { dealId: string };
  const { slug, api } = useCrm();
  const { t } = useI18n();
  const deal = useQuery({
    queryKey: [...crmKeys.opportunities(slug), 'detail', dealId],
    queryFn: () => api.opportunities.get(dealId),
    retry: false,
  });
  usePageChrome({ title: deal.data?.title ?? t('nav.deals') });
  return (
    <PageState isPending={deal.isPending} error={deal.error}>
      {() => (deal.data ? <DealView deal={deal.data} /> : null)}
    </PageState>
  );
}

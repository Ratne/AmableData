import type { CustomFieldValues, Opportunity, Pipeline, Stage } from '@amable/api-types/crm';
import {
  cn,
  DashboardButton,
  ListTable,
  PageBody,
  PageToolbar,
  toast,
  usePageChrome,
  type ListTableColumn,
} from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { CurrencySelect } from '../../commerce/components/currency-select';
import { listTableLabels } from '../../../lib/labels';
import { fetchAllPages } from '../api/client';
import {
  crmKeys,
  errorMessage,
  useCrm,
  useCrmMutation,
  useDirectory,
  usePermissions,
  usePipelines,
} from '../api/hooks';
import { formatDate, formatMoney, formatTotals } from '../components/cells';
import { ChoiceSelect, DatePicker, UserSelect } from '../components/inputs';
import { PageState } from '../components/states';
import { RequiredCustomFields, useRequiredCustomFields } from '../custom-fields/required-fields';

const DRAG_TYPE = 'application/x-amable-deal';

/** Moves a deal to another stage in a cached board list (optimistic update). */
export function moveDeal(
  deals: readonly Opportunity[],
  dealId: string,
  stage: Pick<Stage, 'id' | 'kind'>,
): Opportunity[] {
  return deals.map((deal) =>
    deal.id === dealId ? { ...deal, stage_id: stage.id, status: stage.kind } : deal,
  );
}

function DealCard({
  deal,
  draggable,
  contactName,
}: {
  deal: Opportunity;
  draggable: boolean;
  contactName: string | null;
}) {
  const { locale } = useI18n();
  const { nameOf } = useDirectory();
  const { slug } = useCrm();
  return (
    <article
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, deal.id);
        event.dataTransfer.setData('text/plain', deal.title);
        event.dataTransfer.effectAllowed = 'move';
      }}
      data-testid="deal-card"
      aria-roledescription="draggable"
      className={cn(
        'rounded-lg border bg-background p-2.5 text-sm shadow-xs',
        draggable && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <Link
        to="/t/$tenant/deals/$dealId"
        params={{ tenant: slug, dealId: deal.id }}
        className="font-medium hover:underline"
        draggable={false}
      >
        {deal.title}
      </Link>
      <p className="mt-0.5 tabular-nums">{formatMoney(locale, deal.value_minor, deal.currency)}</p>
      <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        {deal.contact_id && contactName ? (
          <Link
            to="/t/$tenant/contacts/$contactId"
            params={{ tenant: slug, contactId: deal.contact_id }}
            className="hover:underline"
            draggable={false}
          >
            {contactName}
          </Link>
        ) : null}
        {deal.owner_id ? <span>{nameOf(deal.owner_id)}</span> : null}
        {deal.expected_close_date ? (
          <span>{formatDate(locale, `${deal.expected_close_date}T12:00:00Z`)}</span>
        ) : null}
      </div>
    </article>
  );
}

function Board({
  pipeline,
  deals,
  contactNames,
  onMove,
  canWrite,
}: {
  pipeline: Pipeline;
  deals: readonly Opportunity[];
  contactNames: ReadonlyMap<string, string>;
  onMove: (dealId: string, stage: Stage) => void;
  canWrite: boolean;
}) {
  const { t, locale } = useI18n();
  const [over, setOver] = useState<string | null>(null);
  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);
  return (
    <div
      className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4"
      role="list"
      aria-label={t('crm.deals.board')}
    >
      {stages.map((stage) => {
        const items = deals.filter((deal) => deal.stage_id === stage.id);
        const onDrop = (event: DragEvent) => {
          event.preventDefault();
          setOver(null);
          const id = event.dataTransfer.getData(DRAG_TYPE);
          if (id && deals.find((deal) => deal.id === id)?.stage_id !== stage.id) onMove(id, stage);
        };
        return (
          <section
            key={stage.id}
            role="listitem"
            aria-label={stage.name}
            data-testid={`stage-${stage.id}`}
            onDragOver={(event) => {
              if (!canWrite || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setOver(stage.id);
            }}
            onDragLeave={() => setOver((current) => (current === stage.id ? null : current))}
            onDrop={onDrop}
            className={cn(
              'flex w-72 shrink-0 flex-col rounded-xl border bg-muted/40 transition-colors',
              over === stage.id && 'border-primary bg-primary/5',
            )}
          >
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <h3 className="flex-1 truncate text-sm font-medium">{stage.name}</h3>
              {stage.kind !== 'open' ? (
                <Badge variant={stage.kind === 'won' ? 'default' : 'outline'}>
                  {t(`crm.pipelines.kind.${stage.kind}`)}
                </Badge>
              ) : null}
              <Badge variant="secondary">{items.length}</Badge>
            </header>
            <p className="px-3 pt-1.5 text-xs text-muted-foreground tabular-nums">
              {formatTotals(locale, items, 'EUR')} · {stage.probability}%
            </p>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
              {items.map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  draggable={canWrite}
                  contactName={deal.contact_id ? (contactNames.get(deal.contact_id) ?? null) : null}
                />
              ))}
              {items.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {t('crm.deals.dropHere')}
                </p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function NewDealDialog({
  open,
  onOpenChange,
  pipeline,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipeline: Pipeline;
}) {
  const { t } = useI18n();
  const { api } = useCrm();
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [stageId, setStageId] = useState(pipeline.stages[0]?.id ?? '');
  const [owner, setOwner] = useState('');
  const [close, setClose] = useState('');
  const amount = value.trim() === '' ? 0 : Number(value.replace(',', '.'));
  const required = useRequiredCustomFields('opportunities');
  const create = useCrmMutation({
    mutationFn: (customFields: CustomFieldValues) =>
      api.opportunities.create({
        title: title.trim(),
        pipeline_id: pipeline.id,
        ...(stageId ? { stage_id: stageId } : {}),
        value_minor: Math.round(amount * 100),
        currency,
        ...(owner ? { owner_id: owner } : {}),
        ...(close ? { expected_close_date: close } : {}),
        ...(Object.keys(customFields).length > 0 ? { custom_fields: customFields } : {}),
      }),
    success: t('crm.deals.created'),
    onSuccess: () => {
      setTitle('');
      setValue('');
      required.reset();
      onOpenChange(false);
    },
  });
  const valid =
    title.trim() !== '' && Number.isFinite(amount) && amount >= 0 && /^[A-Z]{3}$/.test(currency);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const customFields = required.collect();
    if (customFields !== null) create.mutate(customFields);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('crm.deals.new')}</DialogTitle>
            <DialogDescription>{pipeline.name}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="deal-title">{t('crm.deals.title')}</Label>
            <Input
              id="deal-title"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="deal-value">{t('crm.deals.value')}</Label>
              <Input
                id="deal-value"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="deal-currency">{t('crm.customFields.currency')}</Label>
              <CurrencySelect id="deal-currency" value={currency} onChange={setCurrency} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>{t('crm.deals.stage')}</Label>
              <ChoiceSelect
                value={stageId}
                allowEmpty={false}
                ariaLabel={t('crm.deals.stage')}
                choices={pipeline.stages.map((s) => ({ value: s.id, label: s.name }))}
                onChange={setStageId}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('crm.field.owner_id')}</Label>
              <UserSelect value={owner} onChange={setOwner} ariaLabel={t('crm.field.owner_id')} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('crm.deals.expectedClose')}</Label>
              <DatePicker
                value={close}
                onChange={setClose}
                ariaLabel={t('crm.deals.expectedClose')}
              />
            </div>
          </div>
          <RequiredCustomFields state={required} disabled={create.isPending} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {t('crm.common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DealsPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const { nameOf } = useDirectory();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pipelines = usePipelines();
  const [view, setView] = useState<'board' | 'list'>('board');
  const [pipelineId, setPipelineId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  usePageChrome({
    title: t('nav.deals'),
    tabs: [
      { value: 'board', label: t('crm.deals.board') },
      { value: 'list', label: t('crm.deals.list') },
    ],
    tab: view,
    onTabChange: (value) => setView(value === 'list' ? 'list' : 'board'),
  });

  useEffect(() => {
    if (pipelineId === '' && pipelines.data && pipelines.data.length > 0) {
      setPipelineId((pipelines.data.find((p) => p.is_default) ?? pipelines.data[0])?.id ?? '');
    }
  }, [pipelines.data, pipelineId]);
  const pipeline = pipelines.data?.find((p) => p.id === pipelineId) ?? null;
  const boardKey = [...crmKeys.opportunities(slug), 'board', pipelineId] as const;
  const deals = useQuery({
    queryKey: boardKey,
    queryFn: () =>
      fetchAllPages(
        (cursor) => api.opportunities.list({ pipeline_id: pipelineId, limit: 200, cursor }),
        10,
      ),
    enabled: pipelineId !== '',
  });
  const contactIds = useMemo(
    () => [
      ...new Set(
        (deals.data ?? []).map((d) => d.contact_id).filter((id): id is string => id !== null),
      ),
    ],
    [deals.data],
  );
  const contacts = useQuery({
    queryKey: [...crmKeys.search(slug), 'dealContacts', contactIds.join(',')],
    queryFn: () =>
      api.search.query({
        entity: 'contact',
        filter: {
          type: 'group',
          op: 'and',
          conditions: [
            { type: 'field', field: 'id', operator: 'in', value: contactIds.slice(0, 500) },
          ],
        },
        columns: ['given_name', 'family_name', 'email'],
        limit: 500,
      }),
    enabled: contactIds.length > 0,
  });
  const contactNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of contacts.data?.data ?? []) {
      const name = [row['given_name'], row['family_name']]
        .filter((v) => typeof v === 'string' && v)
        .join(' ');
      map.set(String(row['id']), name || String(row['email'] ?? ''));
    }
    return map;
  }, [contacts.data]);

  const move = async (dealId: string, stage: Stage) => {
    const previous = queryClient.getQueryData<Opportunity[]>(boardKey);
    queryClient.setQueryData<Opportunity[]>(boardKey, (current) =>
      moveDeal(current ?? [], dealId, stage),
    );
    try {
      const updated = await api.opportunities.update(dealId, { stage_id: stage.id });
      queryClient.setQueryData<Opportunity[]>(boardKey, (current) =>
        (current ?? []).map((deal) => (deal.id === updated.id ? updated : deal)),
      );
      toast.success(t('crm.deals.moved', { stage: stage.name }));
      void queryClient.invalidateQueries({
        queryKey: crmKeys.timeline(slug, 'contact', updated.contact_id ?? ''),
      });
    } catch (error) {
      queryClient.setQueryData(boardKey, previous);
      toast.error(errorMessage(t, error));
    }
  };

  const remove = useCrmMutation({
    mutationFn: (rows: Opportunity[]) =>
      Promise.all(rows.map((row) => api.opportunities.remove(row.id))),
  });
  const restore = useCrmMutation({
    mutationFn: (rows: Opportunity[]) =>
      Promise.all(rows.map((row) => api.opportunities.restore(row.id))),
  });
  const stageOf = (id: string) => pipeline?.stages.find((s) => s.id === id);
  const columns: ListTableColumn<Opportunity>[] = [
    {
      id: 'title',
      header: t('crm.deals.title'),
      cell: (d) => <span className="font-medium">{d.title}</span>,
      sortable: true,
      sortValue: (d) => d.title,
    },
    {
      id: 'stage',
      header: t('crm.deals.stage'),
      cell: (d) => stageOf(d.stage_id)?.name ?? '',
      sortable: true,
      sortValue: (d) => stageOf(d.stage_id)?.position ?? 0,
    },
    {
      id: 'value',
      header: t('crm.deals.value'),
      cell: (d) => formatMoney(locale, d.value_minor, d.currency),
      sortable: true,
      sortValue: (d) => d.value_minor,
      firstDirection: 'desc',
      align: 'right',
    },
    {
      id: 'contact',
      header: t('nav.contacts'),
      cell: (d) => (d.contact_id ? (contactNames.get(d.contact_id) ?? '') : ''),
      hideBelow: 'md',
    },
    {
      id: 'owner',
      header: t('crm.field.owner_id'),
      cell: (d) => nameOf(d.owner_id),
      hideBelow: 'lg',
    },
    {
      id: 'close',
      header: t('crm.deals.expectedClose'),
      cell: (d) =>
        d.expected_close_date ? formatDate(locale, `${d.expected_close_date}T12:00:00Z`) : '',
      sortable: true,
      sortValue: (d) => d.expected_close_date,
      hideBelow: 'lg',
    },
  ];

  return (
    <PageState isPending={pipelines.isPending} error={pipelines.error ?? deals.error}>
      {() => (
        <div className="flex min-h-0 flex-1 flex-col">
          <PageToolbar
            filters={
              <ChoiceSelect
                value={pipelineId}
                allowEmpty={false}
                ariaLabel={t('crm.deals.pipeline')}
                choices={(pipelines.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
                onChange={setPipelineId}
              />
            }
            actions={
              can('opportunities:write') && pipeline ? (
                <DashboardButton variant="primary" onClick={() => setCreating(true)}>
                  <Plus aria-hidden /> {t('crm.deals.new')}
                </DashboardButton>
              ) : null
            }
          />
          {pipeline === null ? (
            <PageBody>
              <p className="text-sm text-muted-foreground">{t('crm.pipelines.empty')}</p>
              {can('settings:manage') ? (
                <Button
                  variant="link"
                  className="px-0"
                  onClick={() =>
                    void navigate({ to: '/t/$tenant/settings/pipelines', params: { tenant: slug } })
                  }
                >
                  {t('nav.pipelines')}
                </Button>
              ) : null}
            </PageBody>
          ) : view === 'board' ? (
            <Board
              pipeline={pipeline}
              deals={deals.data ?? []}
              contactNames={contactNames}
              canWrite={can('opportunities:write')}
              onMove={(id, stage) => void move(id, stage)}
            />
          ) : (
            <ListTable<Opportunity>
              rows={deals.data ?? []}
              getRowId={(d) => d.id}
              getRowLabel={(d) => d.title}
              columns={columns}
              labels={listTableLabels(t)}
              loading={deals.isPending}
              defaultSort={{ columnId: 'value', direction: 'desc' }}
              selectable={can('opportunities:write')}
              onRowOpen={(d) =>
                void navigate({
                  to: '/t/$tenant/deals/$dealId',
                  params: { tenant: slug, dealId: d.id },
                })
              }
              deletion={
                can('opportunities:write')
                  ? {
                      onDelete: (rows) => remove.mutateAsync(rows).then(() => undefined),
                      onUndo: (rows) => restore.mutateAsync(rows).then(() => undefined),
                    }
                  : undefined
              }
            />
          )}
          {pipeline && creating ? (
            <NewDealDialog open={creating} onOpenChange={setCreating} pipeline={pipeline} />
          ) : null}
        </div>
      )}
    </PageState>
  );
}

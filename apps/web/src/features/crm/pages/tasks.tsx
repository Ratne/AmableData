import { TASK_PRIORITIES, type Appointment, type Task } from '@amable/api-types/crm';
import {
  cn,
  DashboardButton,
  ListTable,
  PageBody,
  PageToolbar,
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
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { fetchAllPages } from '../../../lib/api';
import { crmKeys, useCrm, useCrmMutation, useDirectory, usePermissions } from '../api/hooks';
import {
  bucketByDay,
  dayKey,
  shiftAnchor,
  startOfDay,
  visibleRange,
  type CalendarView,
} from '../calendar-utils';
import { formatDate } from '../components/cells';
import { ChoiceSelect, DateTimePicker, UserSelect } from '../components/inputs';
import { ErrorNotice } from '../components/states';

function NewEntryDialog({
  kind,
  onClose,
  defaultStart,
}: {
  kind: 'task' | 'appointment';
  onClose: () => void;
  defaultStart?: string;
}) {
  const { t } = useI18n();
  const { api } = useCrm();
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(defaultStart ?? '');
  const [minutes, setMinutes] = useState('30');
  const [priority, setPriority] = useState<(typeof TASK_PRIORITIES)[number]>('normal');
  const [assignee, setAssignee] = useState('');
  const create = useCrmMutation({
    mutationFn: async (): Promise<unknown> => {
      if (kind === 'task') {
        return api.tasks.create({
          title: title.trim(),
          priority,
          ...(when ? { due_at: when } : {}),
          ...(assignee ? { assigned_to: assignee } : {}),
        });
      }
      const start = Date.parse(when);
      return api.appointments.create({
        title: title.trim(),
        start_at: new Date(start).toISOString(),
        end_at: new Date(start + Math.max(5, Number(minutes) || 30) * 60_000).toISOString(),
        ...(assignee ? { owner_id: assignee } : {}),
      });
    },
    success: kind === 'task' ? t('crm.tasks.created') : t('crm.appointments.created'),
    onSuccess: onClose,
  });
  const valid = title.trim() !== '' && (kind === 'task' || when !== '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) create.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {kind === 'task' ? t('crm.tasks.new') : t('crm.appointments.new')}
            </DialogTitle>
            <DialogDescription className="sr-only">{kind}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="entry-title">{t('crm.tasks.title')}</Label>
            <Input
              id="entry-title"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{kind === 'task' ? t('crm.tasks.due') : t('crm.appointments.start')}</Label>
            <DateTimePicker value={when} onChange={setWhen} ariaLabel={t('crm.tasks.due')} />
          </div>
          {kind === 'appointment' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="entry-minutes">{t('crm.appointments.duration')}</Label>
              <Input
                id="entry-minutes"
                type="number"
                min={5}
                step={5}
                value={minutes}
                className="w-24"
                onChange={(e) => setMinutes(e.target.value)}
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label>{t('crm.tasks.priorityLabel')}</Label>
              <ChoiceSelect
                value={priority}
                allowEmpty={false}
                ariaLabel={t('crm.tasks.priorityLabel')}
                choices={TASK_PRIORITIES.map((p) => ({
                  value: p,
                  label: t(`crm.tasks.priority.${p}`),
                }))}
                onChange={(value) => setPriority(value as (typeof TASK_PRIORITIES)[number])}
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label>{kind === 'task' ? t('crm.tasks.assignee') : t('crm.field.owner_id')}</Label>
            <UserSelect
              value={assignee}
              onChange={setAssignee}
              ariaLabel={t('crm.tasks.assignee')}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
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

function TaskList() {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const { nameOf } = useDirectory();
  const [status, setStatus] = useState<'open' | 'completed'>('open');
  const tasks = useQuery({
    queryKey: [...crmKeys.tasks(slug), 'list', status],
    queryFn: () => fetchAllPages((cursor) => api.tasks.list({ status, limit: 200, cursor }), 5),
  });
  const run = useCrmMutation({ mutationFn: (job: () => Promise<unknown>) => job() });
  const canWrite = can('tasks:write');
  const columns: ListTableColumn<Task>[] = [
    {
      id: 'title',
      header: t('crm.tasks.title'),
      cell: (task) => (
        <span
          className={cn(
            'font-medium',
            task.status === 'completed' && 'text-muted-foreground line-through',
          )}
        >
          {task.title}
        </span>
      ),
      sortable: true,
      sortValue: (task) => task.title,
    },
    {
      id: 'due',
      header: t('crm.tasks.due'),
      cell: (task) => {
        const overdue =
          task.status === 'open' && task.due_at !== null && Date.parse(task.due_at) < Date.now();
        return (
          <span className={cn(overdue && 'text-destructive')}>
            {formatDate(locale, task.due_at, true)}
          </span>
        );
      },
      sortable: true,
      sortValue: (task) => task.due_at,
    },
    {
      id: 'priority',
      header: t('crm.tasks.priorityLabel'),
      cell: (task) => (
        <Badge variant={task.priority === 'high' ? 'default' : 'secondary'}>
          {t(`crm.tasks.priority.${task.priority}`)}
        </Badge>
      ),
      sortable: true,
      sortValue: (task) => TASK_PRIORITIES.indexOf(task.priority),
      firstDirection: 'desc',
      hideBelow: 'md',
    },
    {
      id: 'assignee',
      header: t('crm.tasks.assignee'),
      cell: (task) => nameOf(task.assigned_to),
      hideBelow: 'lg',
    },
    {
      id: 'contact',
      header: t('nav.contacts'),
      cell: (task) =>
        task.contact_id ? (
          <Link
            to="/t/$tenant/contacts/$contactId"
            params={{ tenant: slug, contactId: task.contact_id }}
            className="text-primary hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {t('crm.tasks.openContact')}
          </Link>
        ) : null,
      hideBelow: 'lg',
    },
  ];
  return (
    <>
      <PageToolbar
        filters={
          <ChoiceSelect
            value={status}
            allowEmpty={false}
            ariaLabel={t('crm.tasks.status')}
            choices={[
              { value: 'open', label: t('crm.tasks.statusOpen') },
              { value: 'completed', label: t('crm.tasks.statusCompleted') },
            ]}
            onChange={(value) => setStatus(value === 'completed' ? 'completed' : 'open')}
          />
        }
      />
      {tasks.error ? (
        <div className="px-4">
          <ErrorNotice error={tasks.error} />
        </div>
      ) : null}
      <ListTable<Task>
        rows={tasks.data ?? []}
        getRowId={(task) => task.id}
        getRowLabel={(task) => task.title}
        columns={columns}
        labels={listTableLabels(t)}
        loading={tasks.isPending}
        defaultSort={{ columnId: 'due', direction: 'asc' }}
        selectable={canWrite}
        bulkActions={
          canWrite
            ? [
                status === 'open'
                  ? {
                      id: 'complete',
                      label: t('crm.tasks.complete'),
                      icon: Check,
                      onSelect: (rows) =>
                        run.mutate(() =>
                          Promise.all(rows.map((row) => api.tasks.complete(row.id))),
                        ),
                    }
                  : {
                      id: 'reopen',
                      label: t('crm.tasks.reopen'),
                      icon: RotateCcw,
                      onSelect: (rows) =>
                        run.mutate(() => Promise.all(rows.map((row) => api.tasks.reopen(row.id)))),
                    },
              ]
            : undefined
        }
        deletion={
          canWrite
            ? {
                onDelete: (rows) =>
                  run
                    .mutateAsync(() => Promise.all(rows.map((row) => api.tasks.remove(row.id))))
                    .then(() => undefined),
                onUndo: (rows) =>
                  run
                    .mutateAsync(() => Promise.all(rows.map((row) => api.tasks.restore(row.id))))
                    .then(() => undefined),
              }
            : undefined
        }
      />
    </>
  );
}

type Entry =
  | { kind: 'appointment'; item: Appointment; start: number; end: number }
  | { kind: 'task'; item: Task; start: number; end: number };

function CalendarBoard({ onCreate }: { onCreate: (start: string) => void }) {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const [view, setView] = useState<CalendarView>('month');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [owner, setOwner] = useState('');
  const range = useMemo(() => visibleRange(anchor, view), [anchor, view]);
  const calendar = useQuery({
    queryKey: [...crmKeys.calendar(slug), range.from.toISOString(), range.to.toISOString(), owner],
    queryFn: () =>
      api.calendar(range.from.toISOString(), range.to.toISOString(), owner || undefined),
  });
  const entries = useMemo<Entry[]>(() => {
    const appointments = (calendar.data?.appointments ?? []).map((item) => ({
      kind: 'appointment' as const,
      item,
      start: Date.parse(item.start_at),
      end: Date.parse(item.end_at),
    }));
    const tasks = (calendar.data?.tasks ?? [])
      .filter((task) => task.due_at !== null)
      .map((item) => ({
        kind: 'task' as const,
        item,
        start: Date.parse(item.due_at ?? ''),
        end: Date.parse(item.due_at ?? '') + 1,
      }));
    return [...appointments, ...tasks].sort((a, b) => a.start - b.start);
  }, [calendar.data]);
  const buckets = useMemo(
    () => bucketByDay(entries, range, (e) => ({ start: e.start, end: e.end })),
    [entries, range],
  );
  const today = dayKey(new Date());
  const title = new Intl.DateTimeFormat(
    locale,
    view === 'month' ? { month: 'long', year: 'numeric' } : { dateStyle: 'medium' },
  ).format(view === 'month' ? anchor : range.from);
  const weekdays = range.days
    .slice(0, 7)
    .map((d) => new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d));
  const time = (ms: number) => new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(ms);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageToolbar
        filters={
          <>
            <DashboardButton
              variant="ghost"
              aria-label={t('crm.calendar.previous')}
              onClick={() => setAnchor((a) => shiftAnchor(a, view, -1))}
            >
              <ChevronLeft aria-hidden />
            </DashboardButton>
            <DashboardButton variant="ghost" onClick={() => setAnchor(startOfDay(new Date()))}>
              {t('crm.calendar.today')}
            </DashboardButton>
            <DashboardButton
              variant="ghost"
              aria-label={t('crm.calendar.next')}
              onClick={() => setAnchor((a) => shiftAnchor(a, view, 1))}
            >
              <ChevronRight aria-hidden />
            </DashboardButton>
            <h3 className="px-2 text-sm font-medium capitalize" aria-live="polite">
              {title}
            </h3>
          </>
        }
        actions={
          <>
            <UserSelect
              value={owner}
              onChange={setOwner}
              ariaLabel={t('crm.calendar.owner')}
              emptyLabel={t('crm.calendar.allOwners')}
            />
            <ChoiceSelect
              value={view}
              allowEmpty={false}
              ariaLabel={t('crm.calendar.view')}
              choices={[
                { value: 'month', label: t('crm.calendar.month') },
                { value: 'week', label: t('crm.calendar.week') },
              ]}
              onChange={(value) => setView(value === 'week' ? 'week' : 'month')}
            />
          </>
        }
      />
      {calendar.error ? (
        <div className="px-4">
          <ErrorNotice error={calendar.error} />
        </div>
      ) : null}
      <PageBody className="flex min-h-0 flex-1 flex-col">
        <div className="grid grid-cols-7 border-b text-xs text-muted-foreground">
          {weekdays.map((day) => (
            <div key={day} className="px-2 py-1 capitalize">
              {day}
            </div>
          ))}
        </div>
        <div
          className={cn(
            'grid flex-1 grid-cols-7 border-l',
            view === 'month' ? 'auto-rows-[minmax(6.5rem,1fr)]' : 'auto-rows-[minmax(24rem,1fr)]',
          )}
          role="grid"
          aria-label={title}
        >
          {range.days.map((day) => {
            const key = dayKey(day);
            const items = buckets.get(key) ?? [];
            const outside = view === 'month' && day.getMonth() !== anchor.getMonth();
            const limit = view === 'month' ? 3 : 50;
            return (
              <div
                key={key}
                role="gridcell"
                aria-label={new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(day)}
                className={cn(
                  'group flex min-w-0 flex-col gap-1 border-r border-b p-1',
                  outside && 'bg-muted/30 text-muted-foreground',
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      'grid size-6 place-items-center rounded-full text-xs',
                      key === today && 'bg-primary font-semibold text-primary-foreground',
                    )}
                  >
                    {day.getDate()}
                  </span>
                  <button
                    type="button"
                    className="rounded p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-muted"
                    aria-label={t('crm.appointments.new')}
                    onClick={() => {
                      const start = new Date(day);
                      start.setHours(9, 0, 0, 0);
                      onCreate(start.toISOString());
                    }}
                  >
                    <Plus className="size-3" aria-hidden />
                  </button>
                </div>
                {items.slice(0, limit).map((entry) => {
                  const contactId = entry.item.contact_id;
                  const label = (
                    <>
                      {entry.kind === 'task' ? (
                        <ListChecks className="size-3 shrink-0" aria-hidden />
                      ) : (
                        <CalendarClock className="size-3 shrink-0" aria-hidden />
                      )}
                      {entry.kind === 'appointment' && entry.item.all_day ? null : (
                        <span className="tabular-nums">{time(entry.start)}</span>
                      )}
                      <span
                        className={cn(
                          'truncate',
                          entry.kind === 'task' &&
                            entry.item.status === 'completed' &&
                            'line-through',
                        )}
                      >
                        {entry.item.title}
                      </span>
                    </>
                  );
                  const className = cn(
                    'flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px]',
                    entry.kind === 'task'
                      ? 'bg-amber-500/15 text-amber-900 dark:text-amber-200'
                      : 'bg-primary/15 text-foreground',
                  );
                  return contactId ? (
                    <Link
                      key={`${entry.kind}:${entry.item.id}`}
                      to="/t/$tenant/contacts/$contactId"
                      params={{ tenant: slug, contactId }}
                      className={cn(className, 'hover:underline')}
                    >
                      {label}
                    </Link>
                  ) : (
                    <div key={`${entry.kind}:${entry.item.id}`} className={className}>
                      {label}
                    </div>
                  );
                })}
                {items.length > limit ? (
                  <span className="px-1 text-[11px] text-muted-foreground">
                    {t('crm.calendar.more', { count: items.length - limit })}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </PageBody>
    </div>
  );
}

export function TasksPage() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [tab, setTab] = useState<'list' | 'calendar'>('list');
  const [creating, setCreating] = useState<{ kind: 'task' | 'appointment'; start?: string } | null>(
    null,
  );
  usePageChrome({
    title: t('nav.tasks'),
    tabs: [
      { value: 'list', label: t('crm.tasks.list') },
      { value: 'calendar', label: t('crm.calendar.title') },
    ],
    tab,
    onTabChange: (value) => setTab(value === 'calendar' ? 'calendar' : 'list'),
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {can('tasks:write') ? (
        <div className="flex justify-end gap-2 px-4 pt-3">
          <DashboardButton variant="ghost" onClick={() => setCreating({ kind: 'appointment' })}>
            <CalendarClock aria-hidden /> {t('crm.appointments.new')}
          </DashboardButton>
          <DashboardButton variant="primary" onClick={() => setCreating({ kind: 'task' })}>
            <Plus aria-hidden /> {t('crm.tasks.new')}
          </DashboardButton>
        </div>
      ) : null}
      {tab === 'list' ? (
        <TaskList />
      ) : (
        <CalendarBoard
          onCreate={(start) =>
            can('tasks:write') ? setCreating({ kind: 'appointment', start }) : undefined
          }
        />
      )}
      {creating ? (
        <NewEntryDialog
          kind={creating.kind}
          defaultStart={creating.start}
          onClose={() => setCreating(null)}
        />
      ) : null}
    </div>
  );
}

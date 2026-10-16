import type { Activity, Note, RichText, Task } from '@amable/api-types/crm';
import type { JSONContent } from '@amable/editor';
import { cn } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Input } from '@amable/ui/ui/input';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarClock, Pin, Plus, Trash2 } from 'lucide-react';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import {
  activityDetail,
  activityIcon,
  activityLabelKey,
  fallbackActivityLabel,
} from '../activity-types';
import {
  crmKeys,
  useCrm,
  useCrmMutation,
  useDirectory,
  usePermissions,
  usePipelines,
} from '../api/hooks';
import { formatDate, formatMoney } from './cells';
import { DatePicker, DateTimePicker } from './inputs';
import { ErrorNotice } from './states';

const RELOAD_FLAG = 'amb.chunkReload';

/** A chunk of an older build is gone after a deploy: reload once to get the new index. */
const NoteEditor = lazy(() =>
  import('./note-editor')
    .then((m) => {
      sessionStorage.removeItem(RELOAD_FLAG);
      return { default: m.NoteEditor };
    })
    .catch((error: unknown) => {
      if (sessionStorage.getItem(RELOAD_FLAG) === null) {
        sessionStorage.setItem(RELOAD_FLAG, '1');
        window.location.reload();
      }
      throw error;
    }),
);

export type Subject =
  | { readonly kind: 'contact'; readonly id: string }
  | { readonly kind: 'company'; readonly id: string }
  | { readonly kind: 'opportunity'; readonly id: string };

/** Page size of the record lists (notes, tasks, appointments, deals). */
const PAGE = 25;

const pageParams = {
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: { next_cursor: string | null }) => last.next_cursor ?? undefined,
};

function LoadMore({
  query,
}: {
  query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  const { t } = useI18n();
  if (!query.hasNextPage) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="justify-self-start"
      disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
    >
      {t('crm.common.loadMore')}
    </Button>
  );
}

const subjectFilter = (subject: Subject) =>
  subject.kind === 'contact'
    ? { contact_id: subject.id }
    : subject.kind === 'company'
      ? { company_id: subject.id }
      : { opportunity_id: subject.id };

// ---------------------------------------------------------------- timeline

export function TimelinePanel({
  subject,
  tagName,
}: {
  subject: Subject;
  tagName: (id: string) => string;
}) {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { nameOf } = useDirectory();
  const timeline = useInfiniteQuery({
    queryKey: crmKeys.timeline(slug, subject.kind, subject.id),
    queryFn: ({ pageParam }) =>
      subject.kind === 'contact'
        ? api.contacts.timeline(subject.id, { limit: 30, cursor: pageParam })
        : subject.kind === 'company'
          ? api.companies.timeline(subject.id, { limit: 30, cursor: pageParam })
          : api.opportunities.timeline(subject.id, { limit: 30, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  if (timeline.error) return <ErrorNotice error={timeline.error} />;
  if (timeline.isPending) return <Skeleton className="h-32 w-full" />;
  const items = timeline.data.pages.flatMap((p) => p.data);
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">{t('crm.timeline.empty')}</p>;
  return (
    <div>
      <ol className="relative ml-2 border-l">
        {items.map((activity) => {
          const key = activityLabelKey(activity.type);
          const detail = activityDetail(activity, { locale, tagName });
          const Icon = activityIcon(activity.type);
          return (
            <li key={activity.id} className="mb-3 ml-5">
              <span
                className="absolute -left-2.5 mt-0.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground"
                aria-hidden
              >
                <Icon className="size-3" />
              </span>
              <p className="text-sm" title={activity.type}>
                {key ? t(key) : fallbackActivityLabel(activity.type)}
                {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDate(locale, activity.occurred_at, true)}
                {activity.actor.type === 'user' && activity.actor.id
                  ? ` · ${nameOf(activity.actor.id)}`
                  : activity.actor.type === 'api_key'
                    ? ` · ${t('crm.timeline.api')}`
                    : ''}
              </p>
            </li>
          );
        })}
      </ol>
      {timeline.hasNextPage ? (
        <Button variant="ghost" size="sm" onClick={() => void timeline.fetchNextPage()}>
          {t('crm.common.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------- notes

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

function isEmptyDoc(doc: JSONContent | null): boolean {
  if (doc === null) return true;
  const text = JSON.stringify(doc);
  return !/"text":"[^"]*\S/.test(text) && !text.includes('"image"');
}

function NoteItem({ note, canEdit }: { note: Note; canEdit: boolean }) {
  const { t, locale } = useI18n();
  const { api } = useCrm();
  const { nameOf } = useDirectory();
  const [editing, setEditing] = useState<JSONContent | null>(null);
  const update = useCrmMutation({
    mutationFn: (input: { body?: RichText; pinned?: boolean }) => api.notes.update(note.id, input),
    success: t('crm.notes.saved'),
    onSuccess: () => setEditing(null),
  });
  const remove = useCrmMutation({
    mutationFn: () => api.notes.remove(note.id),
    success: t('crm.notes.deleted'),
  });
  return (
    <article
      className={cn('rounded-lg border p-3', note.pinned && 'border-primary/40 bg-primary/5')}
    >
      <header className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        {note.pinned ? <Pin className="size-3" aria-label={t('crm.notes.pinned')} /> : null}
        {note.title ? <span className="font-medium text-foreground">{note.title}</span> : null}
        <span>{formatDate(locale, note.created_at, true)}</span>
        {note.created_by ? <span>· {nameOf(note.created_by)}</span> : null}
        {canEdit ? (
          <span className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => update.mutate({ pinned: !note.pinned })}
            >
              {note.pinned ? t('crm.notes.unpin') : t('crm.notes.pin')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => setEditing(note.body as JSONContent)}
            >
              {t('crm.common.edit')}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t('crm.notes.delete')}
              onClick={() => remove.mutate(undefined)}
            >
              <Trash2 className="size-3" aria-hidden />
            </Button>
          </span>
        ) : null}
      </header>
      {editing !== null ? (
        <div className="grid gap-2">
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <NoteEditor value={editing} onChange={setEditing} />
          </Suspense>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={update.isPending || isEmptyDoc(editing)}
              onClick={() => update.mutate({ body: editing as RichText })}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm whitespace-pre-wrap">{note.body_text}</p>
      )}
    </article>
  );
}

export function NotesPanel({ subject }: { subject: Subject }) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const canEdit = can('contacts:write');
  const [draft, setDraft] = useState<JSONContent | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const notes = useInfiniteQuery({
    queryKey: [...crmKeys.notes(slug), subject.kind, subject.id],
    queryFn: ({ pageParam }) =>
      api.notes.list({ ...subjectFilter(subject), limit: PAGE, cursor: pageParam }),
    ...pageParams,
  });
  const create = useCrmMutation({
    mutationFn: (body: JSONContent) =>
      api.notes.create({ ...subjectFilter(subject), body: body as RichText }),
    success: t('crm.notes.added'),
    onSuccess: () => {
      setDraft(null);
      setEditorKey((k) => k + 1);
    },
  });
  const sorted = [...(notes.data?.pages.flatMap((p) => p.data) ?? [])].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at),
  );
  return (
    <div className="grid gap-3">
      {canEdit ? (
        <div className="grid gap-2" aria-label={t('crm.notes.new')}>
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <NoteEditor key={editorKey} value={draft ?? EMPTY_DOC} onChange={setDraft} />
          </Suspense>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={create.isPending || isEmptyDoc(draft)}
              onClick={() => (draft ? create.mutate(draft) : undefined)}
            >
              <Plus className="size-3.5" aria-hidden /> {t('crm.notes.add')}
            </Button>
          </div>
        </div>
      ) : null}
      {notes.error ? <ErrorNotice error={notes.error} /> : null}
      {notes.isPending ? <Skeleton className="h-20 w-full" /> : null}
      {sorted.map((note) => (
        <NoteItem key={note.id} note={note} canEdit={canEdit} />
      ))}
      <LoadMore query={notes} />
      {!notes.isPending && sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('crm.notes.empty')}</p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------- tasks

export function TaskRow({ task }: { task: Task }) {
  const { t, locale } = useI18n();
  const { api } = useCrm();
  const { can } = usePermissions();
  const { nameOf } = useDirectory();
  const toggle = useCrmMutation({
    mutationFn: () =>
      task.status === 'open' ? api.tasks.complete(task.id) : api.tasks.reopen(task.id),
  });
  const overdue =
    task.status === 'open' && task.due_at !== null && Date.parse(task.due_at) < Date.now();
  return (
    <li className="flex items-start gap-2 py-1.5">
      <Checkbox
        checked={task.status === 'completed'}
        disabled={!can('tasks:write') || toggle.isPending}
        onCheckedChange={() => toggle.mutate(undefined)}
        aria-label={t('crm.tasks.toggle', { name: task.title })}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-sm',
            task.status === 'completed' && 'text-muted-foreground line-through',
          )}
        >
          {task.title}
        </p>
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {task.due_at ? (
            <span className={cn(overdue && 'text-destructive')}>
              {formatDate(locale, task.due_at, true)}
            </span>
          ) : null}
          {task.assigned_to ? <span>{nameOf(task.assigned_to)}</span> : null}
          {task.priority !== 'normal' ? (
            <span>{t(`crm.tasks.priority.${task.priority}`)}</span>
          ) : null}
        </p>
      </div>
    </li>
  );
}

export function TasksPanel({ subject }: { subject: Subject }) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const tasks = useInfiniteQuery({
    queryKey: [...crmKeys.tasks(slug), subject.kind, subject.id],
    queryFn: ({ pageParam }) =>
      subject.kind === 'company'
        ? Promise.resolve({ data: [] as Task[], next_cursor: null })
        : api.tasks.list({ ...subjectFilter(subject), limit: PAGE, cursor: pageParam }),
    ...pageParams,
  });
  const taskItems = tasks.data?.pages.flatMap((p) => p.data) ?? [];
  const create = useCrmMutation({
    mutationFn: () =>
      api.tasks.create({
        title: title.trim(),
        ...subjectFilter(subject),
        ...(due ? { due_at: new Date(`${due}T09:00:00`).toISOString() } : {}),
      }),
    success: t('crm.tasks.created'),
    onSuccess: () => {
      setTitle('');
      setDue('');
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) create.mutate(undefined);
  };
  return (
    <div className="grid gap-2">
      {can('tasks:write') ? (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('crm.tasks.newPlaceholder')}
            aria-label={t('crm.tasks.title')}
            className="h-8 min-w-48 flex-1"
          />
          <DatePicker value={due} onChange={setDue} ariaLabel={t('crm.tasks.due')} />
          <Button type="submit" size="sm" disabled={!title.trim() || create.isPending}>
            <Plus className="size-3.5" aria-hidden /> {t('crm.common.add')}
          </Button>
        </form>
      ) : null}
      {tasks.error ? <ErrorNotice error={tasks.error} /> : null}
      <ul className="divide-y">
        {taskItems.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </ul>
      <LoadMore query={tasks} />
      {!tasks.isPending && taskItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('crm.tasks.empty')}</p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------ appointments

export function AppointmentsPanel({ contactId }: { contactId: string }) {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [minutes, setMinutes] = useState('30');
  const appointments = useInfiniteQuery({
    queryKey: [...crmKeys.appointments(slug), 'contact', contactId],
    queryFn: ({ pageParam }) =>
      api.appointments.list({ contact_id: contactId, limit: PAGE, cursor: pageParam }),
    ...pageParams,
  });
  const create = useCrmMutation({
    mutationFn: () => {
      const startMs = Date.parse(start);
      return api.appointments.create({
        title: title.trim(),
        contact_id: contactId,
        start_at: new Date(startMs).toISOString(),
        end_at: new Date(startMs + Math.max(5, Number(minutes) || 30) * 60_000).toISOString(),
      });
    },
    success: t('crm.appointments.created'),
    onSuccess: () => {
      setTitle('');
      setStart('');
    },
  });
  const items = appointments.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="grid gap-2">
      {can('tasks:write') ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() && start) create.mutate(undefined);
          }}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('crm.appointments.newPlaceholder')}
            aria-label={t('crm.appointments.title')}
            className="h-8 min-w-48 flex-1"
          />
          <DateTimePicker
            value={start}
            onChange={setStart}
            ariaLabel={t('crm.appointments.start')}
          />
          <Input
            type="number"
            min={5}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-label={t('crm.appointments.duration')}
            className="h-8 w-20"
          />
          <Button type="submit" size="sm" disabled={!title.trim() || !start || create.isPending}>
            <Plus className="size-3.5" aria-hidden /> {t('crm.common.add')}
          </Button>
        </form>
      ) : null}
      {appointments.error ? <ErrorNotice error={appointments.error} /> : null}
      <ul className="divide-y">
        {items.map((appointment) => (
          <li key={appointment.id} className="flex items-center gap-2 py-1.5">
            <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
            <span className="flex-1 text-sm">{appointment.title}</span>
            <span className="text-xs text-muted-foreground">
              {formatDate(locale, appointment.start_at, !appointment.all_day)}
            </span>
            {appointment.status !== 'scheduled' ? (
              <Badge variant="outline">{t(`crm.appointments.status.${appointment.status}`)}</Badge>
            ) : null}
          </li>
        ))}
      </ul>
      <LoadMore query={appointments} />
      {!appointments.isPending && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('crm.appointments.empty')}</p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------- deals

export function DealsPanel({ contactId, companyId }: { contactId?: string; companyId?: string }) {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const pipelines = usePipelines();
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const deals = useInfiniteQuery({
    queryKey: [...crmKeys.opportunities(slug), 'contact', contactId ?? companyId ?? ''],
    queryFn: ({ pageParam }) =>
      api.opportunities.list({
        ...(contactId ? { contact_id: contactId } : {}),
        limit: PAGE,
        cursor: pageParam,
      }),
    ...pageParams,
    enabled: contactId !== undefined,
  });
  const dealItems = deals.data?.pages.flatMap((p) => p.data) ?? [];
  const create = useCrmMutation({
    mutationFn: () =>
      api.opportunities.create({
        title: title.trim(),
        ...(contactId ? { contact_id: contactId } : {}),
        ...(companyId ? { company_id: companyId } : {}),
        ...(value ? { value_minor: Math.round(Number(value.replace(',', '.')) * 100) } : {}),
      }),
    success: t('crm.deals.created'),
    onSuccess: () => {
      setTitle('');
      setValue('');
    },
  });
  const stageName = (stageId: string) =>
    pipelines.data?.flatMap((p) => p.stages).find((s) => s.id === stageId)?.name ?? '';
  return (
    <div className="grid gap-2">
      {can('opportunities:write') ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim()) create.mutate(undefined);
          }}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('crm.deals.newPlaceholder')}
            aria-label={t('crm.deals.title')}
            className="h-8 min-w-48 flex-1"
          />
          <Input
            value={value}
            inputMode="decimal"
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('crm.deals.value')}
            aria-label={t('crm.deals.value')}
            className="h-8 w-28"
          />
          <Button type="submit" size="sm" disabled={!title.trim() || create.isPending}>
            <Plus className="size-3.5" aria-hidden /> {t('crm.common.add')}
          </Button>
        </form>
      ) : null}
      {deals.error ? <ErrorNotice error={deals.error} /> : null}
      <ul className="divide-y">
        {dealItems.map((deal) => (
          <li key={deal.id} className="flex items-center gap-2 py-1.5 text-sm">
            <Link
              to="/t/$tenant/deals/$dealId"
              params={{ tenant: slug, dealId: deal.id }}
              className="flex-1 hover:underline"
            >
              {deal.title}
            </Link>
            <Badge variant={deal.status === 'won' ? 'default' : 'secondary'}>
              {stageName(deal.stage_id)}
            </Badge>
            <span className="tabular-nums text-muted-foreground">
              {formatMoney(locale, deal.value_minor, deal.currency)}
            </span>
          </li>
        ))}
      </ul>
      <LoadMore query={deals} />
      {!deals.isPending && dealItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('crm.deals.empty')}</p>
      ) : null}
    </div>
  );
}

import type {
  Automation,
  ContactEnrollment,
  ContactSubmission,
  EmailMessage,
} from '@amable/api-types';
import { DashboardConfirmDialog } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@amable/ui/ui/sheet';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link } from '@tanstack/react-router';
import { ClipboardList, ExternalLink, Lock, Mail, Plus, Search, Workflow, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import {
  CONTACT_TAGS_PAGE,
  contactTabKeys,
  useContactEmails,
  useContactEnrollments,
  useContactSubmission,
  useContactSubmissions,
  useContactTabsApi,
  useContactTags,
} from '../api/contact-tabs';
import { crmKeys, useCrm, useCrmMutation, useDirectory, usePermissions } from '../api/hooks';
import { AutomationPicker } from './automation-picker';
import { formatDate } from './cells';
import { ErrorNotice } from './states';
import { TagPicker } from './tag-picker';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

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

// --------------------------------------------------------------------- tags

/** The contact's tags: server-side search and pages, add with the tag picker, remove. */
export function ContactTagsPanel({ contactId }: { contactId: string }) {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const { nameOf } = useDirectory();
  const canEdit = can('contacts:write');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [adding, setAdding] = useState<string[]>([]);
  const tags = useContactTags(contactId, q, true);
  const invalidate = [
    crmKeys.contact(slug, contactId),
    crmKeys.tags(slug),
    crmKeys.timeline(slug, 'contact', contactId),
  ];
  const add = useCrmMutation({
    mutationFn: (tagIds: string[]) => api.contacts.applyTags(contactId, tagIds),
    invalidate,
    success: t('crm.contactTags.added'),
    onSuccess: () => setAdding([]),
  });
  const remove = useCrmMutation({
    mutationFn: (tagId: string) => api.contacts.removeTag(contactId, tagId),
    invalidate,
  });
  const items = tags.data?.pages.flatMap((p) => p.data) ?? [];
  const searching = q.trim() !== '';

  return (
    <div className="grid gap-3">
      {canEdit ? (
        <div className="flex flex-wrap items-start gap-2">
          <TagPicker
            value={adding}
            onChange={setAdding}
            max={100}
            ariaLabel={t('crm.contact.addTag')}
            placeholder={t('crm.contact.addTag')}
            className="min-w-56 flex-1"
          />
          <Button
            size="sm"
            className="h-9"
            disabled={adding.length === 0 || add.isPending}
            onClick={() => add.mutate(adding)}
          >
            <Plus className="size-3.5" aria-hidden /> {t('crm.bulk.apply')}
          </Button>
        </div>
      ) : null}
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('crm.contactTags.search')}
          aria-label={t('crm.contactTags.search')}
          className="h-8 pl-8"
        />
      </div>
      {tags.error ? <ErrorNotice error={tags.error} /> : null}
      {tags.isPending ? <Skeleton className="h-20 w-full" /> : null}
      {!tags.isPending && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {searching ? t('crm.contactTags.noMatch') : t('crm.contactTags.empty')}
        </p>
      ) : null}
      <ul className="divide-y" aria-busy={tags.isFetching}>
        {items.map((tag) => (
          <li key={tag.id} className="flex items-center gap-2 py-1.5">
            <Link
              to="/t/$tenant/contacts"
              params={{ tenant: slug }}
              search={{ tag: tag.id }}
              className="min-w-0"
            >
              <Badge variant="secondary" className="max-w-full truncate">
                {tag.name}
              </Badge>
            </Link>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {formatDate(locale, tag.applied_at, true)}
              {tag.applied_by ? ` · ${nameOf(tag.applied_by)}` : ''}
            </span>
            {canEdit ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={t('crm.contact.removeTag', { name: tag.name })}
                disabled={remove.isPending}
                onClick={() => remove.mutate(tag.id)}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <LoadMore query={tags} />
      {items.length >= CONTACT_TAGS_PAGE && !tags.hasNextPage ? (
        <p className="text-xs text-muted-foreground">{t('crm.contactTags.end')}</p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------- emails

const EMAIL_PROBLEM: ReadonlySet<EmailMessage['status']> = new Set([
  'bounced',
  'dropped',
  'complained',
  'blocked',
  'failed',
]);

/** Emails sent to the contact (MailDb), newest first. */
export function ContactEmailsPanel({ contactId }: { contactId: string }) {
  const { t, locale } = useI18n();
  const emails = useContactEmails(contactId);
  if (emails.error) return <ErrorNotice error={emails.error} />;
  if (emails.isPending) return <Skeleton className="h-20 w-full" />;
  const items = emails.data.pages.flatMap((p) => p.data);
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">{t('crm.contactEmails.empty')}</p>;
  return (
    <div className="grid gap-2">
      <ul className="divide-y">
        {items.map((message) => (
          <li key={message.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {message.subject ?? t('crm.contactEmails.noSubject')}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDate(locale, message.sent_at ?? message.created_at, true)} ·{' '}
                {t(`crm.contactEmails.source.${message.source_type}`)}
                {message.email ? ` · ${message.email}` : ''}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              {message.open_count > 0 ? (
                <span>{t('crm.contactEmails.opens', { n: message.open_count })}</span>
              ) : null}
              {message.click_count > 0 ? (
                <span>{t('crm.contactEmails.clicks', { n: message.click_count })}</span>
              ) : null}
              <Badge
                variant={EMAIL_PROBLEM.has(message.status) ? 'destructive' : 'outline'}
                title={message.status_reason ?? undefined}
              >
                {t(`crm.contactEmails.status.${message.status}`)}
              </Badge>
            </span>
          </li>
        ))}
      </ul>
      <LoadMore query={emails} />
    </div>
  );
}

// -------------------------------------------------------- form submissions

const SUBMISSION_BADGE: Record<ContactSubmission['status'], 'outline' | 'secondary' | 'destructive'> = {
  pending: 'secondary',
  processed: 'outline',
  failed: 'destructive',
};

function pageLabel(submission: ContactSubmission): string | null {
  if (submission.page_title !== null) return submission.page_title;
  if (submission.page_url === null) return null;
  try {
    const url = new URL(submission.page_url);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return submission.page_url;
  }
}

function SubmissionDrawer({
  contactId,
  submission,
  onClose,
}: {
  contactId: string;
  submission: ContactSubmission | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { slug } = useCrm();
  const detail = useContactSubmission(contactId, submission?.id ?? null);
  return (
    <Sheet open={submission !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {submission ? (
          <>
            <SheetHeader>
              <SheetTitle>
                {t('crm.contactSubmissions.detail', {
                  form: submission.form_name,
                  date: formatDate(locale, submission.created_at, true),
                })}
              </SheetTitle>
            </SheetHeader>
            <div className="grid gap-4 px-4 pb-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={SUBMISSION_BADGE[submission.status]}>
                  {t(`crm.contactSubmissions.status.${submission.status}`)}
                </Badge>
                {submission.form_deleted ? null : (
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      to="/t/$tenant/forms/$formId/submissions"
                      params={{ tenant: slug, formId: submission.form_id }}
                      search={{ submission: submission.id }}
                    >
                      <ExternalLink className="size-3.5" aria-hidden />{' '}
                      {t('crm.contactSubmissions.openInForm')}
                    </Link>
                  </Button>
                )}
              </div>
              {detail.error ? <ErrorNotice error={detail.error} /> : null}
              {detail.isPending ? <Skeleton className="h-32 w-full" /> : null}
              {detail.data ? (
                <>
                  {detail.data.error ? (
                    <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {detail.data.error}
                    </p>
                  ) : null}
                  <section className="grid gap-2">
                    <h3 className="text-sm font-semibold">{t('crm.contactSubmissions.values')}</h3>
                    {detail.data.entries.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t('crm.contactSubmissions.noValues')}
                      </p>
                    ) : (
                      <dl className="grid gap-2 text-sm">
                        {detail.data.entries.map((entry) => (
                          <div key={entry.key} className="grid gap-0.5">
                            <dt className="text-xs text-muted-foreground">{entry.label}</dt>
                            <dd className="flex items-center gap-1.5 break-words whitespace-pre-wrap">
                              {entry.masked ? (
                                <Lock
                                  className="size-3.5 shrink-0 text-muted-foreground"
                                  aria-label={t('crm.contactSubmissions.masked')}
                                />
                              ) : null}
                              <span title={entry.masked ? t('crm.contactSubmissions.masked') : undefined}>
                                {typeof entry.value === 'boolean'
                                  ? t(entry.value ? 'crm.contactSubmissions.yes' : 'crm.contactSubmissions.no')
                                  : entry.value}
                              </span>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </section>
                  <section className="grid gap-2">
                    <h3 className="text-sm font-semibold">{t('crm.contactSubmissions.source')}</h3>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      {Object.entries({ ...detail.data.source, ...detail.data.tracking })
                        .filter(([, value]) => value !== null && value !== '')
                        .map(([key, value]) => (
                          <div key={key} className="contents">
                            <dt className="text-muted-foreground">{key}</dt>
                            <dd className="truncate">{String(value)}</dd>
                          </div>
                        ))}
                    </dl>
                  </section>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** Form submissions of the contact across every form; values open in a drawer (`forms:submissions_read`). */
export function ContactSubmissionsPanel({ contactId }: { contactId: string }) {
  const { t, locale } = useI18n();
  const { can } = usePermissions();
  const canReadValues = can('forms:submissions_read');
  const list = useContactSubmissions(contactId);
  const [open, setOpen] = useState<ContactSubmission | null>(null);
  if (list.error) return <ErrorNotice error={list.error} />;
  if (list.isPending) return <Skeleton className="h-20 w-full" />;
  const items = list.data.pages.flatMap((p) => p.data);
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">{t('crm.contactSubmissions.empty')}</p>;
  return (
    <div className="grid gap-2">
      {canReadValues ? null : (
        <p className="text-xs text-muted-foreground">{t('crm.contactSubmissions.noValuesAccess')}</p>
      )}
      <ul className="divide-y">
        {items.map((submission) => {
          const page = pageLabel(submission);
          const body = (
            <>
              <ClipboardList className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{submission.form_name}</span>
                  {submission.form_deleted ? (
                    <Badge variant="outline">{t('crm.contactSubmissions.formDeleted')}</Badge>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {formatDate(locale, submission.created_at, true)}
                  {page === null ? '' : ` · ${t('crm.contactSubmissions.onPage', { page })}`}
                  {submission.contact_created ? ` · ${t('crm.contactSubmissions.newContact')}` : ''}
                </span>
              </span>
              <Badge variant={SUBMISSION_BADGE[submission.status]} className="shrink-0">
                {t(`crm.contactSubmissions.status.${submission.status}`)}
              </Badge>
            </>
          );
          return (
            <li key={submission.id}>
              {canReadValues ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-md px-1 py-2 text-left hover:bg-muted/50"
                  aria-label={`${t('crm.contactSubmissions.open')}: ${submission.form_name}`}
                  onClick={() => setOpen(submission)}
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-center gap-3 px-1 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <LoadMore query={list} />
      {canReadValues ? (
        <SubmissionDrawer contactId={contactId} submission={open} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------- automations

/** Engine log lines that end an enrollment, localized; other texts are shown as they are. */
const OUTCOME_KEYS = {
  'automation completed': 'crm.contactAutomations.why.completed',
  'automation ended with errors': 'crm.contactAutomations.why.errors',
  'automation ended for the contact': 'crm.contactAutomations.why.endStep',
  'removed manually': 'crm.contactAutomations.why.manual',
  'automation deleted': 'crm.contactAutomations.why.deleted',
  'removed by an automation step': 'crm.contactAutomations.why.step',
  'contact deleted': 'crm.contactAutomations.why.contactDeleted',
  'contact merged': 'crm.contactAutomations.why.contactMerged',
} as const;

function outcomeText(text: string, t: ReturnType<typeof useI18n>['t']): string {
  const key = (OUTCOME_KEYS as Record<string, (typeof OUTCOME_KEYS)[keyof typeof OUTCOME_KEYS]>)[
    text
  ];
  return key === undefined ? text : t(key);
}

function positionText(
  position: ContactEnrollment['positions'][number],
  t: ReturnType<typeof useI18n>['t'],
): string {
  const node =
    position.node_label ??
    (position.node_type ? t(`auto.node.${position.node_type}`) : position.node_id);
  const step = position.step_type
    ? t(`auto.step.${position.step_type}` as 'auto.step.delay')
    : null;
  return step === null ? node : `${node} › ${step}`;
}

function EnrollmentRow({
  enrollment,
  canWrite,
  onRemove,
}: {
  enrollment: ContactEnrollment;
  canWrite: boolean;
  onRemove: (enrollment: ContactEnrollment) => void;
}) {
  const { t, locale } = useI18n();
  const { slug } = useCrm();
  const active = enrollment.status === 'active';
  return (
    <li className="grid gap-1 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Workflow className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {enrollment.automation_status === 'deleted' ? (
          <span className="font-medium">{enrollment.automation_name}</span>
        ) : (
          <Link
            to="/t/$tenant/automations/$automationId"
            params={{ tenant: slug, automationId: enrollment.automation_id }}
            className="font-medium hover:underline"
          >
            {enrollment.automation_name}
          </Link>
        )}
        {enrollment.version_number !== null ? (
          <span className="text-xs text-muted-foreground">v{enrollment.version_number}</span>
        ) : null}
        {enrollment.automation_status !== 'active' ? (
          <Badge variant="outline">
            {enrollment.automation_status === 'deleted'
              ? t('crm.contactAutomations.deleted')
              : t(`auto.status.${enrollment.automation_status}`)}
          </Badge>
        ) : null}
        <Badge
          variant={
            enrollment.status === 'failed'
              ? 'destructive'
              : enrollment.status === 'active'
                ? 'default'
                : 'secondary'
          }
          className="ml-auto"
        >
          {t(`auto.enr.status.${enrollment.status}`)}
        </Badge>
        {active && canWrite ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => onRemove(enrollment)}
          >
            <X className="size-3.5" aria-hidden /> {t('crm.contactAutomations.remove')}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('crm.contactAutomations.entered', {
          date: formatDate(locale, enrollment.started_at, true),
        })}
        {` · ${t(`crm.contactAutomations.source.${enrollment.source}`)}`}
        {enrollment.ended_at
          ? ` · ${t('crm.contactAutomations.ended', { date: formatDate(locale, enrollment.ended_at, true) })}`
          : ''}
      </p>
      {enrollment.positions.map((position) => (
        <p key={position.id} className="text-sm">
          <span className="text-muted-foreground">{t('crm.contactAutomations.at')} </span>
          {positionText(position, t)}
          <span className="text-xs text-muted-foreground">
            {' · '}
            {position.status === 'failed'
              ? (position.last_error ?? t('auto.enr.status.failed'))
              : position.status === 'paused'
                ? t('crm.contactAutomations.paused')
                : position.status === 'suspended'
                  ? t('crm.contactAutomations.suspended')
                  : position.due_at
                    ? t('crm.contactAutomations.next', {
                        date: formatDate(locale, position.due_at, true),
                      })
                    : t('crm.contactAutomations.waitingGoal')}
          </span>
        </p>
      ))}
      {enrollment.goals_reached.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('crm.contactAutomations.goals', {
            goals: enrollment.goals_reached
              .map((g) => `${g.node_label ?? t('auto.node.goal')} (${formatDate(locale, g.at)})`)
              .join(', '),
          })}
        </p>
      ) : null}
      {enrollment.outcome ? (
        <p className="text-xs text-muted-foreground">
          {t('crm.contactAutomations.outcome', { text: outcomeText(enrollment.outcome, t) })}
        </p>
      ) : null}
    </li>
  );
}

function AddToAutomation({ contactId }: { contactId: string }) {
  const { t } = useI18n();
  const { slug, tabsApi } = useContactTabsApi();
  const [automation, setAutomation] = useState<Automation | null>(null);
  const enroll = useCrmMutation({
    mutationFn: (id: string) => tabsApi.enroll(id, contactId),
    invalidate: [['automations', slug], contactTabKeys.counts(slug, contactId)],
    success: t('auto.enroll.done'),
    onSuccess: () => setAutomation(null),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <AutomationPicker value={automation} onChange={setAutomation} className="flex-1" />
      <Button
        size="sm"
        disabled={automation === null || enroll.isPending}
        onClick={() => (automation === null ? undefined : enroll.mutate(automation.id))}
      >
        <Plus className="size-3.5" aria-hidden /> {t('crm.contactAutomations.add')}
      </Button>
    </div>
  );
}

function EnrollmentList({
  contactId,
  scope,
  canWrite,
  onRemove,
}: {
  contactId: string;
  scope: 'current' | 'history';
  canWrite: boolean;
  onRemove: (enrollment: ContactEnrollment) => void;
}) {
  const { t } = useI18n();
  const list = useContactEnrollments(contactId, scope);
  if (list.error) return <ErrorNotice error={list.error} />;
  if (list.isPending) return <Skeleton className="h-16 w-full" />;
  const items = list.data.pages.flatMap((p) => p.data);
  if (items.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {scope === 'current'
          ? t('crm.contactAutomations.noneActive')
          : t('crm.contactAutomations.noHistory')}
      </p>
    );
  return (
    <div className="grid gap-1">
      <ul className="divide-y">
        {items.map((enrollment) => (
          <EnrollmentRow
            key={enrollment.id}
            enrollment={enrollment}
            canWrite={canWrite}
            onRemove={onRemove}
          />
        ))}
      </ul>
      <LoadMore query={list} />
    </div>
  );
}

/** Automations the contact is in now (with position and next action) and past runs. */
export function ContactAutomationsPanel({ contactId }: { contactId: string }) {
  const { t } = useI18n();
  const { slug, tabsApi } = useContactTabsApi();
  const { can } = usePermissions();
  const canWrite = can('automations:write');
  const [removing, setRemoving] = useState<ContactEnrollment | null>(null);
  const remove = useCrmMutation({
    mutationFn: (enrollment: ContactEnrollment) =>
      tabsApi.unenroll(enrollment.automation_id, contactId),
    invalidate: [
      ['automations', slug],
      contactTabKeys.enrollments(slug, contactId, 'history'),
      contactTabKeys.counts(slug, contactId),
    ],
    success: t('auto.enr.removed'),
    onSuccess: () => setRemoving(null),
  });
  return (
    <div className="grid gap-4">
      {canWrite ? <AddToAutomation contactId={contactId} /> : null}
      <section className="grid gap-1" aria-label={t('crm.contactAutomations.current')}>
        <h3 className="text-sm font-semibold">{t('crm.contactAutomations.current')}</h3>
        <EnrollmentList
          contactId={contactId}
          scope="current"
          canWrite={canWrite}
          onRemove={setRemoving}
        />
      </section>
      <section className="grid gap-1" aria-label={t('crm.contactAutomations.history')}>
        <h3 className="text-sm font-semibold">{t('crm.contactAutomations.history')}</h3>
        <EnrollmentList
          contactId={contactId}
          scope="history"
          canWrite={canWrite}
          onRemove={setRemoving}
        />
      </section>
      <DashboardConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={t('crm.contactAutomations.confirmRemove', {
          name: removing?.automation_name ?? '',
        })}
        description={t('crm.contactAutomations.confirmRemoveBody')}
        confirmLabel={t('crm.contactAutomations.remove')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => (removing ? remove.mutate(removing) : undefined)}
      />
    </div>
  );
}

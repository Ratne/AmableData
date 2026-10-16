import type { Enrollment } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { ChoiceSelect } from '../../crm/components/inputs';
import { automationKeys, useAutomationApi, useAutomationMutation } from '../api/hooks';

const STATUS_TONE: Record<Enrollment['status'], string> = {
  active: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  removed: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/15 text-destructive',
};

function useDate() {
  const { locale } = useI18n();
  return (iso: string | null) =>
    iso === null
      ? ''
      : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(
          new Date(iso),
        );
}

function ContactName({ contactId }: { contactId: string }) {
  const { slug, api } = useAutomationApi();
  const contact = useQuery({
    queryKey: ['crm', slug, 'contacts', contactId],
    queryFn: () => api.contact(contactId),
    staleTime: 60_000,
    retry: false,
  });
  const name =
    contact.data === undefined
      ? contactId
      : [contact.data.given_name, contact.data.family_name].filter(Boolean).join(' ') ||
        (contact.data.emails[0]?.email ?? '') ||
        contactId;
  return <span className="truncate">{name}</span>;
}

function EnrollmentDetailView({
  automationId,
  enrollmentId,
  nodeLabel,
  onBack,
  canWrite,
}: {
  automationId: string;
  enrollmentId: string;
  nodeLabel: (nodeId: string | null) => string;
  onBack: () => void;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const { slug, api } = useAutomationApi();
  const date = useDate();
  const detail = useQuery({
    queryKey: [...automationKeys.enrollments(slug, automationId), enrollmentId],
    queryFn: () => api.enrollment(automationId, enrollmentId),
  });
  const remove = useAutomationMutation({
    mutationFn: (contactId: string) => api.removeContact(automationId, contactId),
    success: t('auto.enr.removed'),
  });
  const data = detail.data;
  return (
    <div className="grid gap-3" data-testid="enrollment-detail">
      <Button variant="ghost" size="sm" className="h-7 justify-self-start" onClick={onBack}>
        <ArrowLeft className="size-3.5" aria-hidden /> {t('auto.enr.back')}
      </Button>
      {data === undefined ? (
        <p className="text-xs text-muted-foreground">{t('auto.loading')}</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <Link
              to="/t/$tenant/contacts/$contactId"
              params={{ tenant: slug, contactId: data.contact_id }}
              className="min-w-0 truncate text-sm font-semibold hover:underline"
            >
              <ContactName contactId={data.contact_id} />
            </Link>
            <Badge className={cn('border-0', STATUS_TONE[data.status])}>
              {t(`auto.enr.status.${data.status}`)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('auto.enr.started', { date: date(data.started_at) })}
          </p>
          {data.positions.length > 0 ? (
            <div className="grid gap-1">
              <p className="text-xs font-medium text-muted-foreground">{t('auto.enr.positions')}</p>
              {data.positions.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs"
                >
                  <span className="truncate">
                    {nodeLabel(p.node_id)}
                    {p.step_id ? (
                      <span className="text-muted-foreground"> · {p.step_id}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {p.status}
                    {p.due_at ? ` · ${t('auto.enr.due', { date: date(p.due_at) })}` : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="grid gap-1">
            <p className="text-xs font-medium text-muted-foreground">{t('auto.enr.log')}</p>
            <ol className="grid gap-1 border-l pl-3" data-testid="enrollment-log">
              {data.log.map((entry) => (
                <li key={entry.id} className="relative text-xs">
                  <span
                    className={cn(
                      'absolute top-1.5 -left-[15px] size-1.5 rounded-full',
                      entry.kind.includes('failed')
                        ? 'bg-destructive'
                        : entry.kind.includes('retry')
                          ? 'bg-amber-500'
                          : 'bg-primary',
                    )}
                  />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {date(entry.at)}
                  </span>{' '}
                  <span className="font-medium">{entry.kind}</span>
                  {entry.node_id ? (
                    <span className="text-muted-foreground"> · {nodeLabel(entry.node_id)}</span>
                  ) : null}
                  <p className="text-muted-foreground">{entry.message}</p>
                </li>
              ))}
            </ol>
          </div>
          {canWrite && data.status === 'active' ? (
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start text-destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(data.contact_id, { onSuccess: onBack })}
            >
              <UserMinus className="size-3.5" aria-hidden /> {t('auto.enr.remove')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Drill-down of the reporting overlay: contacts at a node, then one enrollment with its log. */
export function EnrollmentsPanel({
  automationId,
  nodeId,
  nodeLabel,
  canWrite,
}: {
  automationId: string;
  nodeId: string | null;
  nodeLabel: (nodeId: string | null) => string;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const { slug, api } = useAutomationApi();
  const queryClient = useQueryClient();
  const date = useDate();
  const [status, setStatus] = useState<Enrollment['status'] | ''>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: [...automationKeys.enrollments(slug, automationId), nodeId, status],
    queryFn: ({ pageParam }) =>
      api.enrollments(automationId, {
        ...(nodeId === null ? {} : { node_id: nodeId, scope: 'visited' as const }),
        ...(status === '' ? {} : { status }),
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });

  if (openId !== null) {
    return (
      <EnrollmentDetailView
        automationId={automationId}
        enrollmentId={openId}
        nodeLabel={nodeLabel}
        canWrite={canWrite}
        onBack={() => {
          setOpenId(null);
          void queryClient.invalidateQueries({
            queryKey: automationKeys.enrollments(slug, automationId),
          });
        }}
      />
    );
  }
  const rows = list.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <div className="grid gap-3" data-testid="enrollments-panel">
      <ChoiceSelect
        value={status === '' ? 'all' : status}
        allowEmpty={false}
        className="w-full"
        ariaLabel={t('auto.enr.allStatuses')}
        choices={[
          { value: 'all', label: t('auto.enr.allStatuses') },
          ...(['active', 'completed', 'removed', 'failed'] as const).map((s) => ({
            value: s,
            label: t(`auto.enr.status.${s}`),
          })),
        ]}
        onChange={(v) => setStatus(v === 'all' ? '' : (v as Enrollment['status']))}
      />
      {list.isPending ? <p className="text-xs text-muted-foreground">{t('auto.loading')}</p> : null}
      {!list.isPending && rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {t('auto.enr.empty')}
        </p>
      ) : null}
      <ul className="grid gap-1">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left text-sm hover:bg-muted/50"
              onClick={() => setOpenId(row.id)}
              data-testid="enrollment-row"
            >
              <span className="min-w-0 flex-1">
                <ContactName contactId={row.contact_id} />
                <span className="block text-[11px] text-muted-foreground">
                  {date(row.started_at)}
                </span>
              </span>
              <Badge className={cn('border-0', STATUS_TONE[row.status])}>
                {t(`auto.enr.status.${row.status}`)}
              </Badge>
            </button>
          </li>
        ))}
      </ul>
      {list.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('auto.enr.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

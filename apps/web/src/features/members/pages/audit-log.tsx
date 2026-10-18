import { DashboardButton, PageBody, usePageChrome } from '@amable/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@amable/ui/ui/table';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { PageState, SectionCard } from '../../commerce/components/common';
import { memberKeys, useMembersApi, type AuditEntry } from '../api';

const PAGE_SIZE = 50;

function formatDateTime(locale: string, value: number): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
    new Date(value),
  );
}

/** `key: value` pairs of the details JSON; the raw text when it is not an object. */
function detailPairs(details: string | null): string[] {
  if (details === null || details === '') return [];
  try {
    const parsed: unknown = JSON.parse(details);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(
        ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
      );
    }
  } catch {
    // Not JSON: shown as is.
  }
  return [details];
}

export function AuditLogPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useMembersApi();
  usePageChrome({ title: t('nav.auditLog') });
  const me = useQuery({ queryKey: memberKeys.me(slug), queryFn: api.me, staleTime: 60_000 });
  const allowed = me.data?.permissions.includes('audit:read') ?? false;
  const canListMembers = me.data?.permissions.includes('users:manage') ?? false;
  const entries = useInfiniteQuery({
    queryKey: memberKeys.audit(slug),
    queryFn: ({ pageParam }) => api.audit(pageParam, PAGE_SIZE),
    initialPageParam: null as number | null,
    getNextPageParam: (last) =>
      last.entries.length < PAGE_SIZE ? undefined : (last.entries.at(-1)?.createdAt ?? undefined),
    enabled: allowed,
  });
  const members = useQuery({
    queryKey: memberKeys.members(slug),
    queryFn: api.members,
    enabled: canListMembers,
  });
  const names = useMemo(
    () => new Map((members.data?.members ?? []).map((m) => [m.userId, m.name ?? m.email])),
    [members.data],
  );

  if (me.data !== undefined && !allowed) {
    return <PageBody className="pt-4 text-sm">{t('members.noAccess')}</PageBody>;
  }

  const actorOf = (entry: AuditEntry): string => {
    switch (entry.actorType) {
      case 'system':
        return t('audit.actor.system');
      case 'api_key':
        return t('audit.actor.apiKey');
      case 'app':
        return t('audit.actor.app', { app: entry.actorAppId ?? '' });
    }
    if (entry.actorUserId === null) return t('audit.actor.system');
    return names.get(entry.actorUserId) ?? entry.actorUserId;
  };

  return (
    <PageState isPending={me.isPending || entries.isPending} error={me.error ?? entries.error}>
      {() => {
        const rows = entries.data?.pages.flatMap((p) => p.entries) ?? [];
        return (
          <PageBody className="grid max-w-6xl gap-4 pt-4">
            <SectionCard title={t('nav.auditLog')}>
              <p className="pb-3 text-xs text-muted-foreground">{t('audit.hint')}</p>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('audit.empty')}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('audit.col.when')}</TableHead>
                      <TableHead>{t('audit.col.actor')}</TableHead>
                      <TableHead>{t('audit.col.action')}</TableHead>
                      <TableHead>{t('audit.col.target')}</TableHead>
                      <TableHead>{t('audit.col.details')}</TableHead>
                      <TableHead>{t('audit.col.ip')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((entry) => (
                      <TableRow key={entry.id} className="align-top">
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatDateTime(locale, entry.createdAt)}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-xs">{actorOf(entry)}</TableCell>
                        <TableCell className="font-mono text-xs">{entry.action}</TableCell>
                        <TableCell className="max-w-48 truncate font-mono text-xs">
                          {entry.target ?? ''}
                        </TableCell>
                        <TableCell className="max-w-80 text-xs text-muted-foreground">
                          {detailPairs(entry.details).map((line) => (
                            <div key={line} className="break-all">
                              {line}
                            </div>
                          ))}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {entry.ip ?? ''}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {entries.hasNextPage ? (
                <div className="pt-3">
                  <DashboardButton
                    variant="secondary"
                    size="sm"
                    disabled={entries.isFetchingNextPage}
                    onClick={() => void entries.fetchNextPage()}
                  >
                    {t('audit.more')}
                  </DashboardButton>
                </div>
              ) : null}
            </SectionCard>
          </PageBody>
        );
      }}
    </PageState>
  );
}

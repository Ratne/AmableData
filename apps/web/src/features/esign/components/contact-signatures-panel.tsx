import { Button } from '@amable/ui/ui/button';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link } from '@tanstack/react-router';
import { FilePen, Send } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { ListFooter } from '../../../components/feature-kit';
import { useEsign, useEsignDates, useEsignPermissions, useRequests } from '../api/hooks';
import { ErrorNotice, RequestStatusPill, type PickedContact } from './common';
import { SendDialog } from './send-dialog';

export interface ContactSignaturesPanelProps {
  readonly contact: PickedContact;
}

/** Signature requests where the contact is one of the signers, with a shortcut to send a new one. */
export function ContactSignaturesPanel({ contact }: ContactSignaturesPanelProps) {
  const { t } = useI18n();
  const { slug } = useEsign();
  const { can } = useEsignPermissions();
  const dates = useEsignDates();
  const list = useRequests({ contact_id: contact.id, limit: 20 });
  const [sending, setSending] = useState(false);

  const items = list.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <div className="grid gap-3">
      {can('esign:write') && contact.email !== '' ? (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => setSending(true)}>
            <Send aria-hidden /> {t('esign.action.send')}
          </Button>
        </div>
      ) : null}
      {list.error ? (
        <ErrorNotice error={list.error} />
      ) : list.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('esign.contact.empty')}</p>
      ) : (
        <ul className="divide-y">
          {items.map((request) => {
            const own = request.signers.find((s) => s.contact_id === contact.id);
            const signed = request.signers.filter((s) => s.status === 'completed').length;
            return (
              <li key={request.id}>
                <Link
                  to="/t/$tenant/signatures/$requestId"
                  params={{ tenant: slug, requestId: request.id }}
                  className="flex items-center gap-3 rounded-md px-1 py-2 hover:bg-muted/50"
                >
                  <FilePen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{request.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {dates.dateTime(request.created_at)}
                      {own === undefined ? '' : ` · ${own.party_name}`}
                      {` · ${t('esign.requests.signedCount', { signed, total: request.signers.length })}`}
                    </span>
                  </span>
                  <RequestStatusPill status={request.status} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {list.hasNextPage ? (
        <ListFooter
          hasMore
          loading={list.isFetchingNextPage}
          onMore={() => void list.fetchNextPage()}
        />
      ) : null}
      {sending ? <SendDialog contact={contact} onClose={() => setSending(false)} /> : null}
    </div>
  );
}

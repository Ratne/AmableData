import type { Contact, EsignRequestStatus, EsignSignerStatus, EsignTemplate } from '@amable/api-types';
import { PageBody, usePageChrome } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Search, ShieldAlert, TriangleAlert, UserRound, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { Pill, useDebounced } from '../../commerce/components/common';
import { EsignApiError } from '../api/client';
import { errorMessage, esignKeys, useEsign } from '../api/hooks';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  const forbidden = error instanceof EsignApiError && error.status === 403;
  return (
    <Alert variant={forbidden ? 'default' : 'destructive'} role="alert">
      {forbidden ? <ShieldAlert aria-hidden /> : <TriangleAlert aria-hidden />}
      <AlertTitle>{forbidden ? t('esign.error.forbiddenTitle') : t('common.error')}</AlertTitle>
      <AlertDescription>{errorMessage(t, error)}</AlertDescription>
    </Alert>
  );
}

export function PageState({ isPending, error, children }: { isPending: boolean; error: unknown; children: () => ReactNode }) {
  if (error) {
    return (
      <PageBody className="pt-4">
        <ErrorNotice error={error} />
      </PageBody>
    );
  }
  if (isPending) {
    return (
      <PageBody className="grid gap-3 pt-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </PageBody>
    );
  }
  return <>{children()}</>;
}

export type EsignSection = 'requests' | 'templates';

const SECTION_PATHS: Record<EsignSection, '/t/$tenant/signatures' | '/t/$tenant/signatures/templates'> = {
  requests: '/t/$tenant/signatures',
  templates: '/t/$tenant/signatures/templates',
};

/** Header of the signatures area: requests / templates tabs. */
export function useEsignChrome(section: EsignSection, title?: string, status?: { label: string; tone: 'success' | 'warning' | 'neutral' }): void {
  const { t } = useI18n();
  const { slug } = useEsign();
  const navigate = useNavigate();
  usePageChrome({
    title: title ?? t('nav.signatures'),
    status: status?.label,
    statusTone: status?.tone,
    tabs: (['requests', 'templates'] as const).map((value) => ({ value, label: t(`esign.tab.${value}`) })),
    tab: section,
    onTabChange: (value) => {
      const next = value as EsignSection;
      if (next !== section) void navigate({ to: SECTION_PATHS[next], params: { tenant: slug } });
    },
  });
}

export const REQUEST_STATUS_TONE: Record<EsignRequestStatus, Tone> = {
  sent: 'info',
  partially_signed: 'warning',
  completed: 'success',
  declined: 'danger',
  voided: 'neutral',
  expired: 'neutral',
};

export const SIGNER_STATUS_TONE: Record<EsignSignerStatus, Tone> = {
  pending: 'neutral',
  sent: 'info',
  opened: 'warning',
  completed: 'success',
  declined: 'danger',
};

export const TEMPLATE_STATUS_TONE: Record<EsignTemplate['status'], Tone> = {
  draft: 'neutral',
  active: 'success',
  archived: 'warning',
};

export function RequestStatusPill({ status }: { status: EsignRequestStatus }) {
  const { t } = useI18n();
  return <Pill tone={REQUEST_STATUS_TONE[status]}>{t(`esign.requestStatus.${status}`)}</Pill>;
}

export function SignerStatusPill({ status }: { status: EsignSignerStatus }) {
  const { t } = useI18n();
  return <Pill tone={SIGNER_STATUS_TONE[status]}>{t(`esign.signerStatus.${status}`)}</Pill>;
}

export function TemplateStatusPill({ status }: { status: EsignTemplate['status'] }) {
  const { t } = useI18n();
  return <Pill tone={TEMPLATE_STATUS_TONE[status]}>{t(`esign.templateStatus.${status}`)}</Pill>;
}

export interface PickedContact {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

function contactLabel(contact: Contact): PickedContact {
  const name = [contact.given_name, contact.family_name].filter(Boolean).join(' ').trim();
  const email = contact.emails.find((e) => e.is_primary)?.email ?? contact.emails[0]?.email ?? '';
  return { id: contact.id, name, email };
}

/** CRM contact search with a single selection (only contacts with an email can sign). */
export function ContactPicker({ value, onChange, label }: { value: PickedContact | null; onChange: (contact: PickedContact | null) => void; label: string }) {
  const { t } = useI18n();
  const { slug, api } = useEsign();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const results = useQuery({
    queryKey: esignKeys.contacts(slug, debounced),
    enabled: value === null,
    queryFn: async () => (await api.contacts.search(debounced)).data.map(contactLabel).filter((c) => c.email !== ''),
    staleTime: 30_000,
  });

  if (value !== null) {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2">
        <UserRound className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{value.name || value.email}</p>
          {value.name ? <p className="truncate text-xs text-muted-foreground">{value.email}</p> : null}
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('esign.send.changeContact')} onClick={() => onChange(null)}>
          <X aria-hidden />
        </Button>
      </div>
    );
  }

  const rows = results.data ?? [];
  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input type="search" value={q} className="pl-9" placeholder={t('esign.send.searchContact')} aria-label={label} onChange={(event) => setQ(event.target.value)} />
      </div>
      {debounced !== '' ? (
        <ul className="grid max-h-44 gap-0.5 overflow-auto" role="listbox" aria-label={label}>
          {results.isPending ? (
            <li className="px-3 py-1.5 text-sm text-muted-foreground">{t('common.loading')}</li>
          ) : rows.length === 0 ? (
            <li className="px-3 py-1.5 text-sm text-muted-foreground">{t('esign.send.noContacts')}</li>
          ) : (
            rows.map((contact) => (
              <li key={contact.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="flex w-full flex-col rounded-lg px-3 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  onClick={() => onChange(contact)}
                >
                  <span className="truncate font-medium">{contact.name || contact.email}</span>
                  {contact.name ? <span className="truncate text-xs text-muted-foreground">{contact.email}</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** Opens a same-origin file (cookie-authenticated) in a new tab. */
export function openFile(url: string): void {
  window.open(url, '_blank', 'noopener');
}

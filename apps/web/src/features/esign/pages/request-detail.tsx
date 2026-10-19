import { ESIGN_EVENT_TYPES, type EsignEvent, type EsignEventType, type EsignRequestDetail, type EsignSigner } from '@amable/api-types';
import { DashboardButton, PageBody, PageToolbar, toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Textarea } from '@amable/ui/ui/textarea';
import { Link, useParams } from '@tanstack/react-router';
import { Ban, BellRing, Download, FileText, Link2, RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { Facts, FormField, SectionCard } from '../../commerce/components/common';
import { errorMessage, useEsign, useEsignDates, useEsignMutation, useEsignPermissions, useRequestDetail } from '../api/hooks';
import { openFile, PageState, SignerStatusPill, useEsignChrome } from '../components/common';

const OPEN_STATUSES = new Set(['sent', 'partially_signed']);
const AWAITING = new Set(['sent', 'opened']);

export function EsignRequestDetailPage() {
  const { requestId } = useParams({ from: '/t/$tenant/signatures/$requestId' });
  const request = useRequestDetail(requestId);
  return (
    <PageState isPending={request.isPending} error={request.error}>
      {() => (request.data === undefined ? null : <RequestDetail request={request.data} />)}
    </PageState>
  );
}

function RequestDetail({ request }: { request: EsignRequestDetail }) {
  const { t } = useI18n();
  const { slug, api } = useEsign();
  const { can } = useEsignPermissions();
  const dates = useEsignDates();
  const [voiding, setVoiding] = useState(false);
  const writable = can('esign:write');
  const open = OPEN_STATUSES.has(request.status);
  const tone = request.status === 'completed' ? 'success' : open ? 'warning' : 'neutral';
  useEsignChrome('requests', request.name, { label: t(`esign.requestStatus.${request.status}`), tone });

  const remind = useEsignMutation({
    mutationFn: (signerId: string | undefined) => api.requests.remind(request.id, signerId),
    success: t('esign.detail.reminded'),
  });
  const finalize = useEsignMutation({
    mutationFn: () => api.requests.finalize(request.id),
    success: t('esign.detail.finalizeQueued'),
  });

  const copyLink = async (signer: EsignSigner) => {
    try {
      const { url } = await api.requests.signerLink(request.id, signer.id);
      await navigator.clipboard.writeText(url);
      toast.success(t('esign.detail.linkCopied'));
    } catch (error) {
      toast.error(errorMessage(t, error));
    }
  };

  const sealing = request.status === 'completed' && !request.document_ready;
  // Whose turn it is, as the server reminds: in sequential order only the first party still to sign.
  const pending = request.signers.filter((s) => s.status !== 'completed' && s.status !== 'declined');
  const inTurn = new Set((request.signing_order === 'sequential' ? pending.slice(0, 1) : pending).map((s) => s.id));
  // The automatic attempts gave up: only then staff retries by hand.
  const gaveUp = sealing && request.finalize_error !== null && request.finalize_next_attempt_at === null;
  const signerName = useMemo(() => new Map(request.signers.map((s) => [s.id, s.name || s.email])), [request.signers]);

  return (
    <>
      <PageToolbar
        filters={
          <Link to="/t/$tenant/signatures" params={{ tenant: slug }} className="text-sm text-muted-foreground hover:text-foreground">
            ← {t('esign.detail.back')}
          </Link>
        }
        actions={
          <>
            {request.document_ready ? (
              <DashboardButton variant="primary" onClick={() => openFile(api.requests.documentUrl(request.id, 'completed', true))}>
                <Download aria-hidden /> {t('esign.detail.downloadSigned')}
              </DashboardButton>
            ) : null}
            <DashboardButton onClick={() => openFile(api.requests.documentUrl(request.id, 'original'))}>
              <FileText aria-hidden /> {t('esign.detail.viewOriginal')}
            </DashboardButton>
            {writable && open ? (
              <>
                <DashboardButton onClick={() => remind.mutate(undefined)} disabled={remind.isPending}>
                  <BellRing aria-hidden /> {t('esign.detail.remindAll')}
                </DashboardButton>
                <DashboardButton onClick={() => setVoiding(true)}>
                  <Ban aria-hidden /> {t('esign.detail.void')}
                </DashboardButton>
              </>
            ) : null}
            {writable && sealing && gaveUp ? (
              <DashboardButton onClick={() => finalize.mutate(undefined)} disabled={finalize.isPending}>
                <RotateCw aria-hidden /> {t('esign.detail.retryFinalize')}
              </DashboardButton>
            ) : null}
          </>
        }
      />
      <PageBody className="grid gap-4 pb-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="grid content-start gap-4">
          <SectionCard title={t('esign.detail.summary')}>
            <Facts
              rows={[
                [t('esign.field.status'), t(`esign.requestStatus.${request.status}`)],
                [t('esign.field.origin'), t(`esign.origin.${request.origin}`)],
                [t('esign.field.signingOrder'), t(`esign.signingOrder.${request.signing_order}`)],
                [t('esign.field.sentAt'), dates.dateTime(request.created_at)],
                [t('esign.field.expiresAt'), request.expires_at === null ? t('esign.detail.never') : dates.dateTime(request.expires_at)],
                ...(request.completed_at !== null ? [[t('esign.field.completedAt'), dates.dateTime(request.completed_at)] as const] : []),
                ...(request.declined_at !== null ? [[t('esign.field.declinedAt'), dates.dateTime(request.declined_at)] as const] : []),
                ...(request.voided_at !== null
                  ? [[t('esign.field.voidedAt'), `${dates.dateTime(request.voided_at)}${request.void_reason ? ` — ${request.void_reason}` : ''}`] as const]
                  : []),
                [t('esign.field.originalHash'), <code key="o" className="text-xs break-all">{request.source_sha256}</code>],
                ...(request.completed_sha256 !== null
                  ? [[t('esign.field.signedHash'), <code key="c" className="text-xs break-all">{request.completed_sha256}</code>] as const]
                  : []),
              ]}
            />
            {sealing ? (
              <p className={`mt-3 text-sm ${gaveUp ? 'text-destructive' : 'text-muted-foreground'}`}>
                {request.finalize_error === null
                  ? t('esign.detail.sealing')
                  : gaveUp
                    ? t('esign.detail.finalizeFailed', { error: request.finalize_error })
                    : t('esign.detail.finalizeRetrying', { error: request.finalize_error })}
              </p>
            ) : null}
            {request.message ? <p className="mt-3 rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">{request.message}</p> : null}
          </SectionCard>
          <SectionCard title={t('esign.field.signers')}>
            <ul className="grid gap-3">
              {request.signers.map((signer) => (
                <li key={signer.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {request.signing_order === 'sequential' ? `${String(signer.position + 1)}. ` : ''}
                        {signer.party_name}
                      </p>
                      <p className="truncate text-sm font-medium">{signer.name || signer.email}</p>
                      {signer.name ? <p className="truncate text-xs text-muted-foreground">{signer.email}</p> : null}
                    </div>
                    <SignerStatusPill status={signer.status} />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <dt>{t('esign.signer.sent')}</dt>
                    <dd>{dates.dateTime(signer.sent_at)}</dd>
                    <dt>{t('esign.signer.opened')}</dt>
                    <dd>{dates.dateTime(signer.opened_at)}</dd>
                    <dt>{signer.status === 'declined' ? t('esign.signer.declined') : t('esign.signer.signed')}</dt>
                    <dd>{dates.dateTime(signer.status === 'declined' ? signer.declined_at : signer.completed_at)}</dd>
                    <dt>{t('esign.signer.reminders')}</dt>
                    <dd>
                      {signer.reminders_sent}
                      {signer.next_reminder_at !== null && AWAITING.has(signer.status) ? ` · ${t('esign.signer.next', { when: dates.dateTime(signer.next_reminder_at) })}` : ''}
                    </dd>
                    {signer.otp_verified_at !== null ? (
                      <>
                        <dt>{t('esign.signer.emailVerified')}</dt>
                        <dd>{dates.dateTime(signer.otp_verified_at)}</dd>
                      </>
                    ) : null}
                  </dl>
                  {signer.decline_reason ? <p className="rounded-md bg-red-500/10 p-2 text-xs">{signer.decline_reason}</p> : null}
                  {writable && open && AWAITING.has(signer.status) ? (
                    <div className="flex flex-wrap gap-1.5">
                      {inTurn.has(signer.id) ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => remind.mutate(signer.id)} disabled={remind.isPending}>
                          <BellRing aria-hidden /> {t('esign.detail.remind')}
                        </Button>
                      ) : null}
                      <Button type="button" size="sm" variant="outline" onClick={() => void copyLink(signer)}>
                        <Link2 aria-hidden /> {t('esign.detail.copyLink')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
        <SectionCard title={t('esign.detail.audit')}>
          <p className="mb-3 text-xs text-muted-foreground">{t('esign.detail.auditHint')}</p>
          <ol className="relative grid gap-3 border-l pl-4">
            {request.events.map((event) => (
              <AuditEvent key={event.id} event={event} signer={event.signer_id === null ? null : (signerName.get(event.signer_id) ?? null)} />
            ))}
          </ol>
        </SectionCard>
      </PageBody>
      {voiding ? <VoidDialog requestId={request.id} onClose={() => setVoiding(false)} /> : null}
    </>
  );
}

function metaText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(metaText).join(', ');
  return JSON.stringify(value);
}

const KNOWN_EVENTS: ReadonlySet<string> = new Set(ESIGN_EVENT_TYPES);

function AuditEvent({ event, signer }: { event: EsignEvent; signer: string | null }) {
  const { t } = useI18n();
  const dates = useEsignDates();
  const facts = Object.entries(event.meta).filter(([, value]) => metaText(value) !== '');
  const label = KNOWN_EVENTS.has(event.type) ? t(`esign.event.${event.type as EsignEventType}`) : event.type;
  return (
    <li className="relative">
      <span className="absolute top-1.5 -left-[1.36rem] size-2.5 rounded-full border-2 border-background bg-primary" aria-hidden />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-sm font-medium">
          {label}
          {signer !== null ? <span className="font-normal text-muted-foreground"> · {signer}</span> : null}
        </p>
        <time className="text-xs text-muted-foreground tabular-nums" dateTime={event.occurred_at}>
          {dates.precise(event.occurred_at)}
        </time>
      </div>
      {event.ip !== null || event.user_agent !== null || facts.length > 0 ? (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {[event.ip, event.country].filter(Boolean).join(' · ') || t('esign.detail.details')}
          </summary>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {event.user_agent !== null ? (
              <>
                <dt>{t('esign.audit.userAgent')}</dt>
                <dd className="break-all">{event.user_agent}</dd>
              </>
            ) : null}
            {facts.map(([key, value]) => (
              <div key={key} className="contents">
                <dt>{key}</dt>
                <dd className="break-all whitespace-pre-wrap">{metaText(value)}</dd>
              </div>
            ))}
            <dt>{t('esign.audit.actor')}</dt>
            <dd>{event.actor.type}</dd>
          </dl>
        </details>
      ) : null}
    </li>
  );
}

function VoidDialog({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { api } = useEsign();
  const [reason, setReason] = useState('');
  const voidRequest = useEsignMutation({
    mutationFn: () => api.requests.void(requestId, reason.trim()),
    success: t('esign.detail.voided'),
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('esign.detail.voidTitle')}</DialogTitle>
          <DialogDescription>{t('esign.detail.voidDescription')}</DialogDescription>
        </DialogHeader>
        <FormField label={t('esign.field.reason')}>
          {(id) => <Textarea id={id} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </FormField>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" variant="destructive" disabled={voidRequest.isPending} onClick={() => voidRequest.mutate(undefined)}>
            {t('esign.detail.void')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

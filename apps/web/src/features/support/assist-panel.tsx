import { ASSIST_GRANT_DEFAULT_DAYS, ASSIST_GRANT_MAX_DAYS } from '@amable/core/platform';
import { PageBody, toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@amable/ui/ui/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { apiFetch } from '../../lib/api';
import { isStepUpRequired } from '../../lib/step-up';
import { base, errorKey, postJson, supportKeys, useDate, type AssistGrant, type AssistSession, type Ticket } from './api';
import { ErrorText, Pill, Section, type Tone } from './components';

const STATE_TONE: Record<AssistGrant['state'], Tone> = { active: 'success', revoked: 'neutral', expired: 'neutral' };
const NO_TICKET = '__none__';

/** Owner/Admin: grant (with step-up), list and revoke assisted access for the support team. */
export function AssistPanel({ slug }: { slug: string }) {
  const { t } = useI18n();
  const date = useDate();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(ASSIST_GRANT_DEFAULT_DAYS);
  const [reason, setReason] = useState('');
  const [ticketId, setTicketId] = useState(NO_TICKET);

  const data = useQuery({
    queryKey: supportKeys.grants(slug),
    queryFn: () => apiFetch<{ grants: AssistGrant[]; sessions: AssistSession[] }>(`${base(slug)}/assist/grants`),
  });
  const tickets = useQuery({
    queryKey: supportKeys.tickets(slug),
    queryFn: () => apiFetch<{ tickets: Ticket[] }>(`${base(slug)}/support/tickets`),
    retry: false,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: supportKeys.root(slug) });

  const grant = useMutation({
    mutationFn: () =>
      postJson(`${base(slug)}/assist/grants`, {
        days,
        reason,
        ticketId: ticketId === NO_TICKET ? null : ticketId,
      }),
    onSuccess: () => {
      toast.success(t('sup.assist.granted'));
      setReason('');
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiFetch(`${base(slug)}/assist/grants/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('sup.assist.revoked'));
      refresh();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    grant.mutate();
  };
  const grantError = grant.error && !isStepUpRequired(grant.error) ? grant.error : null;
  const sessionsByGrant = new Map<string, AssistSession[]>();
  for (const session of data.data?.sessions ?? []) {
    sessionsByGrant.set(session.grantId, [...(sessionsByGrant.get(session.grantId) ?? []), session]);
  }

  return (
    <PageBody className="grid gap-4 pt-4 lg:grid-cols-[minmax(18rem,26rem)_1fr]">
      <Section title={t('sup.assist.title')}>
        <p className="mb-3 text-sm text-muted-foreground">{t('sup.assist.body')}</p>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="assist-days">{t('sup.assist.days')}</Label>
            <Input
              id="assist-days"
              type="number"
              min={1}
              max={ASSIST_GRANT_MAX_DAYS}
              value={days}
              onChange={(e) => setDays(Math.min(ASSIST_GRANT_MAX_DAYS, Math.max(1, Number(e.target.value) || 1)))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="assist-reason">{t('sup.assist.reason')}</Label>
            <Input id="assist-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
          </div>
          <div className="space-y-1.5">
            <Label>{t('sup.assist.ticket')}</Label>
            <Select value={ticketId} onValueChange={setTicketId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TICKET}>{t('sup.assist.noTicket')}</SelectItem>
                {(tickets.data?.tickets ?? []).map((ticket) => (
                  <SelectItem key={ticket.id} value={ticket.id}>
                    {ticket.subject}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {grantError ? <ErrorText>{t(errorKey(grantError))}</ErrorText> : null}
          <Button type="submit" size="sm" disabled={grant.isPending || reason.trim() === ''}>
            {t('sup.assist.grant')}
          </Button>
        </form>
      </Section>

      <Section title={t('sup.assist.sessions')}>
        {(data.data?.grants ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('sup.assist.noGrants')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {(data.data?.grants ?? []).map((g) => (
              <li key={g.id} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={STATE_TONE[g.state]}>{t(`sup.assist.state.${g.state}`)}</Pill>
                  <span className="min-w-0 flex-1 truncate text-sm">{g.reason}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('sup.assist.until', { date: date(g.revokedAt ?? g.expiresAt) })}
                  </span>
                  {g.state === 'active' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(g.id)}
                    >
                      {t('sup.assist.revoke')}
                    </Button>
                  ) : null}
                </div>
                {g.state === 'active' && !g.mirrored ? (
                  <p className="text-xs text-amber-600">{t('sup.assist.notMirrored')}</p>
                ) : null}
                {(sessionsByGrant.get(g.id) ?? []).map((s) => (
                  <div key={s.id} className="flex items-center gap-2 pl-2 text-xs text-muted-foreground">
                    {s.active ? <Pill tone="warning">{t('sup.assist.live')}</Pill> : null}
                    <span>{s.staffName}</span>
                    <span>· {date(s.startedAt)}</span>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </PageBody>
  );
}

import type { TicketCategory, TicketStatus } from '@amable/core/platform';
import { cn, PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@amable/ui/ui/select';
import { Textarea } from '@amable/ui/ui/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Download, Paperclip, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { apiFetch } from '../../lib/api';
import {
  base,
  errorKey,
  isUnavailable,
  postJson,
  supportKeys,
  TICKET_CATEGORIES,
  uploadAttachment,
  useAssistStatus,
  useDate,
  type Ticket,
  type TicketDetail,
} from './api';
import { AssistPanel } from './assist-panel';
import { ErrorText, Pill, UnavailableNotice, type Tone } from './components';

const STATUS_TONE: Record<TicketStatus, Tone> = { open: 'info', waiting_customer: 'warning', resolved: 'success' };

function useSlug(): string {
  return useParams({ strict: false, select: (p: { tenant?: string }) => p.tenant ?? '' });
}

/** `/t/$tenant/support` — tickets with the support team, plus assisted access for Owner/Admin. */
export function SupportPage() {
  const { t } = useI18n();
  const slug = useSlug();
  const status = useAssistStatus(slug);
  const canManage = status.data?.canManage === true && status.data.available;
  const [tab, setTab] = useState<'tickets' | 'access'>('tickets');
  usePageChrome({
    title: t('nav.support'),
    ...(canManage
      ? {
          tabs: [
            { value: 'tickets', label: t('sup.tickets') },
            { value: 'access', label: t('sup.assist.title') },
          ],
          tab,
          onTabChange: (value: string) => setTab(value === 'access' ? 'access' : 'tickets'),
        }
      : {}),
  });
  if (canManage && tab === 'access') return <AssistPanel slug={slug} />;
  return <TicketsView slug={slug} />;
}

function TicketsView({ slug }: { slug: string }) {
  const { t } = useI18n();
  const date = useDate();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const tickets = useQuery({
    queryKey: supportKeys.tickets(slug),
    queryFn: () => apiFetch<{ tickets: Ticket[] }>(`${base(slug)}/support/tickets`),
    retry: false,
  });
  if (isUnavailable(tickets.error)) return <UnavailableNotice />;
  const list = tickets.data?.tickets ?? [];

  return (
    <>
      <PageToolbar
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('sup.newTicket')}
          </Button>
        }
      />
      <PageBody>
        {tickets.error ? <ErrorText>{t(errorKey(tickets.error))}</ErrorText> : null}
        <div className="grid gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {list.length === 0 && !tickets.isPending ? (
              <li className="p-4 text-sm text-muted-foreground">{t('sup.noTickets')}</li>
            ) : null}
            {list.map((ticket) => (
              <li key={ticket.id}>
                <button
                  type="button"
                  onClick={() => setSelected(ticket.id)}
                  className={cn(
                    'flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-accent',
                    selected === ticket.id && 'bg-accent',
                  )}
                >
                  <span className="truncate text-sm font-medium">{ticket.subject}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Pill tone={STATUS_TONE[ticket.status]}>{t(`sup.status.${ticket.status}`)}</Pill>
                    {t(`sup.category.${ticket.category}`)} · {date(ticket.lastMessageAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected === null ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
              {t('sup.selectTicket')}
            </div>
          ) : (
            <TicketThread slug={slug} id={selected} />
          )}
        </div>
      </PageBody>
      <NewTicketDialog
        slug={slug}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => setSelected(id)}
      />
    </>
  );
}

function NewTicketDialog({
  slug,
  open,
  onClose,
  onCreated,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<TicketCategory>('question');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const create = useMutation({
    mutationFn: async () => {
      const { ticket } = await postJson<{ ticket: Ticket }>(`${base(slug)}/support/tickets`, { subject, category, body });
      for (const file of files) await uploadAttachment(slug, ticket.id, file);
      return ticket;
    },
    onSuccess: (ticket) => {
      toast.success(t('sup.created'));
      void queryClient.invalidateQueries({ queryKey: supportKeys.tickets(slug) });
      setSubject('');
      setBody('');
      setFiles([]);
      onCreated(ticket.id);
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>{t('sup.newTicket')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="sup-subject">{t('sup.subject')}</Label>
            <Input id="sup-subject" value={subject} onChange={(e) => setSubject(e.target.value)} minLength={3} maxLength={200} required />
          </div>
          <div className="space-y-1.5">
            <Label>{t('sup.category')}</Label>
            <Select value={category} onValueChange={(value) => setCategory(value as TicketCategory)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TICKET_CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`sup.category.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sup-body">{t('sup.message')}</Label>
            <Textarea id="sup-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10_000} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sup-files">{t('sup.attachments')}</Label>
            <Input id="sup-files" type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
            <p className="text-xs text-muted-foreground">{t('sup.attachHint')}</p>
          </div>
          {create.error ? <ErrorText>{t(errorKey(create.error))}</ErrorText> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('sup.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {t('sup.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TicketThread({ slug, id }: { slug: string; id: string }) {
  const { t } = useI18n();
  const date = useDate();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const detail = useQuery({
    queryKey: supportKeys.ticket(slug, id),
    queryFn: () => apiFetch<TicketDetail>(`${base(slug)}/support/tickets/${id}`),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: supportKeys.ticket(slug, id) });
    void queryClient.invalidateQueries({ queryKey: supportKeys.tickets(slug) });
  };
  const send = useMutation({
    mutationFn: () => postJson(`${base(slug)}/support/tickets/${id}/messages`, { body: reply }),
    onSuccess: () => {
      setReply('');
      refresh();
    },
  });
  const attach = useMutation({
    mutationFn: (file: File) => uploadAttachment(slug, id, file),
    onSuccess: refresh,
  });

  if (detail.isPending) return <div className="h-40 animate-pulse rounded-lg bg-muted" />;
  if (detail.error) return <ErrorText>{t(errorKey(detail.error))}</ErrorText>;
  const { ticket, messages, attachments } = detail.data;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{ticket.subject}</h2>
        <Pill tone={STATUS_TONE[ticket.status]}>{t(`sup.status.${ticket.status}`)}</Pill>
      </div>
      <ol className="space-y-2">
        {messages.map((message) => (
          <li
            key={message.id}
            className={cn(
              'rounded-md border border-border px-3 py-2',
              message.authorKind === 'staff' ? 'bg-sky-500/5' : 'bg-background',
            )}
          >
            <div className="mb-1 flex justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {message.authorKind === 'staff' ? t('sup.author.staff') : (message.authorName ?? '—')}
              </span>
              <span>{date(message.createdAt)}</span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{message.body}</p>
          </li>
        ))}
      </ol>
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {attachments.map((file) => (
            <a
              key={file.id}
              href={`${base(slug)}/support/tickets/${id}/attachments/${file.id}`}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
            >
              <Download className="size-3" aria-hidden />
              {file.filename}
            </a>
          ))}
        </div>
      ) : null}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          send.mutate();
        }}
      >
        <Textarea rows={3} value={reply} placeholder={t('sup.replyPlaceholder')} onChange={(e) => setReply(e.target.value)} maxLength={10_000} />
        {send.error || attach.error ? <ErrorText>{t(errorKey(send.error ?? attach.error))}</ErrorText> : null}
        <div className="flex justify-between gap-2">
          <Button type="button" variant="outline" size="sm" asChild>
            <label className="cursor-pointer">
              <Paperclip aria-hidden />
              {t('sup.attach')}
              <input
                type="file"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) attach.mutate(file);
                  e.target.value = '';
                }}
              />
            </label>
          </Button>
          <Button type="submit" size="sm" disabled={reply.trim() === '' || send.isPending}>
            {t('sup.send')}
          </Button>
        </div>
      </form>
    </div>
  );
}

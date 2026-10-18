import { replyWindowOpen } from '@amable/api-types';
import { cn, PageBody, toast, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Textarea } from '@amable/ui/ui/textarea';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { CheckCircle2, Clock, FileText, Lock, MessagesSquare, RotateCcw, Send, StickyNote, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../../i18n';
import { useMe } from '../../../lib/api';
import { tenantRoute } from '../../../routes/tenant';
import { UserSelect } from '../../crm/components/inputs';
import { useDirectory } from '../../crm/api/hooks';
import {
  channelName,
  useChannels,
  useChannelTemplates,
  useConversation,
  useInbox,
  useInboxCounts,
  useInboxMutation,
  useThread,
  type Conversation,
  type ConversationChannel,
  type ConversationMessage,
  type InboxView,
  type OutgoingMessage,
} from '../api';
import { TemplatePicker, templateMessage, type TemplateDraft } from '../template-picker';
import { INBOX_VIEWS, inboxRoute, isInboxView, type InboxSearch } from '../routes';

function timeLabel(locale: string, iso: string): string {
  const date = new Date(iso);
  const sameDay = new Date().toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { timeStyle: 'short' } : { dateStyle: 'short' }).format(date);
}

function ConversationRow({ conversation, active, onOpen }: { conversation: Conversation; active: boolean; onOpen: () => void }) {
  const { t, locale } = useI18n();
  const channels = useChannels();
  const { nameOf } = useDirectory();
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'grid w-full gap-0.5 border-b border-border px-3 py-2.5 text-left hover:bg-(--obsidian-dashboard-shell-hover)',
        active && 'bg-(--obsidian-dashboard-shell-muted)',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('min-w-0 flex-1 truncate text-sm', conversation.unread > 0 && 'font-semibold')}>
          {conversation.contact?.name ?? conversation.address}
        </span>
        <span className="shrink-0 text-xs text-(--obsidian-dashboard-shell-text-subtle)">{timeLabel(locale, conversation.last_message_at)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-(--obsidian-dashboard-shell-text-subtle)">
          {conversation.last_direction === 'out' ? `${t('conversations.you')}: ` : ''}
          {conversation.last_message_preview ?? ''}
        </span>
        {conversation.unread > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground">{conversation.unread}</span>
        ) : null}
      </div>
      <div className="flex gap-2 text-xs text-(--obsidian-dashboard-shell-text-subtle)">
        <span>{channelName(channels.data, conversation.channel, locale)}</span>
        {conversation.assigned_to !== null ? <span>· {nameOf(conversation.assigned_to)}</span> : null}
      </div>
    </button>
  );
}

function DeliveryIcon({ message }: { message: ConversationMessage }) {
  const { t } = useI18n();
  if (message.direction !== 'out') return null;
  const label = t(`conversations.status.${message.status}` as 'conversations.status.sent');
  if (message.status === 'failed') return <XCircle aria-label={label} className="size-3.5 text-destructive" />;
  if (message.status === 'queued') return <Clock aria-label={label} className="size-3.5" />;
  return <CheckCircle2 aria-label={label} className={cn('size-3.5', message.status === 'read' && 'text-primary')} />;
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  const { t, locale } = useI18n();
  const { nameOf } = useDirectory();
  const mine = message.direction !== 'in';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[75%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap',
          message.direction === 'in' && 'bg-(--obsidian-dashboard-shell-hover)',
          message.direction === 'out' && 'bg-primary text-primary-foreground',
          message.direction === 'note' && 'border border-dashed border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100',
        )}
      >
        {message.direction === 'note' ? (
          <div className="mb-1 flex items-center gap-1 text-xs font-medium">
            <StickyNote className="size-3" /> {t('conversations.note')} · {nameOf(message.author.id)}
          </div>
        ) : null}
        {message.template !== null ? (
          <div className="mb-1 flex items-center gap-1 text-xs opacity-80">
            <FileText className="size-3" /> {t('conversations.templates.sent')}
          </div>
        ) : null}
        {message.text}
        <div className={cn('mt-1 flex items-center justify-end gap-1 text-[11px] opacity-70')}>
          {message.direction === 'out' && message.author.id !== null ? <span>{nameOf(message.author.id)} ·</span> : null}
          <span>{timeLabel(locale, message.sent_at)}</span>
          <DeliveryIcon message={message} />
        </div>
        {message.status === 'failed' && message.error !== null ? (
          <div className="mt-1 text-xs">{t('conversations.failed', { error: message.error })}</div>
        ) : null}
      </div>
    </div>
  );
}

function Composer({ conversation, channel }: { conversation: Conversation; channel: ConversationChannel | undefined }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [note, setNote] = useState(false);
  const [useTemplate, setUseTemplate] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft>({ id: '', params: {} });
  const windowOpen = replyWindowOpen(conversation.last_inbound_at, channel?.reply_window_hours);
  const templates = useChannelTemplates(channel, channel?.templates === true && (useTemplate || !windowOpen));
  const templateMode = !note && channel?.templates === true && (useTemplate || !windowOpen);
  const blocked = !note && !windowOpen && channel?.templates !== true;
  const reply = useInboxMutation((api, input: OutgoingMessage) => api.reply(conversation.id, input));
  const outgoing: OutgoingMessage | null = templateMode
    ? templateMessage(templates.data, draft)
    : text.trim() === '' || blocked
      ? null
      : { text: text.trim(), note };
  const submit = () => {
    if (outgoing === null) return;
    reply.mutate(outgoing, {
      onSuccess: (result) => {
        if (templateMode) {
          setDraft({ id: '', params: {} });
          setUseTemplate(false);
        } else setText('');
        if (result.data.status === 'failed') toast.error(t('conversations.failed', { error: result.data.error ?? '' }));
      },
      onError: () => toast.error(t('common.error')),
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className={cn('grid gap-2 border-t border-border p-3', note && 'bg-amber-50/60 dark:bg-amber-950/20')}>
      {!windowOpen && !note ? (
        <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
          {channel?.templates === true
            ? t('conversations.window.closed', { hours: String(channel.reply_window_hours ?? 24) })
            : t('conversations.window.closedNoTemplates', { hours: String(channel?.reply_window_hours ?? 24) })}
        </p>
      ) : null}
      {templateMode && channel !== undefined ? (
        <TemplatePicker channel={channel} draft={draft} onChange={setDraft} disabled={reply.isPending} />
      ) : (
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          maxLength={4096}
          disabled={blocked}
          placeholder={note ? t('conversations.notePlaceholder') : t('conversations.replyPlaceholder')}
          aria-label={note ? t('conversations.note') : t('conversations.reply')}
        />
      )}
      <div className="flex items-center gap-2">
        <Button type="button" variant={note ? 'secondary' : 'ghost'} size="sm" onClick={() => setNote((v) => !v)} aria-pressed={note}>
          <StickyNote /> {t('conversations.note')}
        </Button>
        {channel?.templates === true && windowOpen && !note ? (
          <Button type="button" variant={useTemplate ? 'secondary' : 'ghost'} size="sm" onClick={() => setUseTemplate((v) => !v)} aria-pressed={useTemplate}>
            <FileText /> {t('conversations.templates.label')}
          </Button>
        ) : null}
        <span className="flex-1 text-xs text-(--obsidian-dashboard-shell-text-subtle)">{templateMode ? '' : t('conversations.sendHint')}</span>
        <Button type="button" size="sm" onClick={submit} disabled={reply.isPending || outgoing === null}>
          {note ? <StickyNote /> : <Send />} {note ? t('conversations.addNote') : t('conversations.send')}
        </Button>
      </div>
    </div>
  );
}

function Thread({ id, canWrite }: { id: string; canWrite: boolean }) {
  const { t, locale } = useI18n();
  const { tenant } = useParams({ from: tenantRoute.id });
  const conversation = useConversation(id);
  const thread = useThread(id);
  const channels = useChannels();
  const update = useInboxMutation((api, data: { status?: 'open' | 'pending' | 'closed'; assigned_to?: string | null }) => api.update(id, data));
  const read = useInboxMutation((api, _: null) => api.read(id));
  const bottom = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => (thread.data?.pages ?? []).flatMap((p) => p.data).slice().reverse(), [thread.data]);
  const unread = conversation.data?.unread ?? 0;
  const markRead = read.mutate;

  useEffect(() => {
    if (unread > 0) markRead(null);
  }, [id, unread, markRead]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const current = conversation.data;
  if (current === undefined) {
    return <div className="grid flex-1 place-items-center text-sm">{conversation.isError ? t('common.error') : t('common.loading')}</div>;
  }
  const closed = current.status === 'closed';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {current.contact === null ? (
              current.address
            ) : (
              <Link to="/t/$tenant/contacts/$contactId" params={{ tenant, contactId: current.contact.id }} className="hover:underline">
                {current.contact.name}
              </Link>
            )}
          </div>
          <div className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">
            {channelName(channels.data, current.channel, locale)} · {current.address}
          </div>
        </div>
        <div className="w-48">
          <UserSelect
            disabled={!canWrite}
            value={current.assigned_to ?? ''}
            onChange={(value) => update.mutate({ assigned_to: value === '' ? null : value })}
            ariaLabel={t('conversations.assignee')}
            emptyLabel={t('conversations.unassigned')}
          />
        </div>
        {canWrite && current.status === 'open' ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => update.mutate({ status: 'pending' })}>
            <Clock /> {t('conversations.markPending')}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" disabled={!canWrite} onClick={() => update.mutate({ status: closed ? 'open' : 'closed' })}>
          {closed ? <RotateCcw /> : <Lock />} {closed ? t('conversations.reopen') : t('conversations.close')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {thread.hasNextPage ? (
          <div className="mb-3 text-center">
            <Button type="button" variant="ghost" size="sm" onClick={() => void thread.fetchNextPage()} disabled={thread.isFetchingNextPage}>
              {t('conversations.older')}
            </Button>
          </div>
        ) : null}
        <div className="grid gap-2">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>
        <div ref={bottom} />
      </div>
      {canWrite ? <Composer conversation={current} channel={channels.data?.find((c) => c.id === current.channel)} /> : null}
    </div>
  );
}

export function InboxPage() {
  const { t } = useI18n();
  const { tenant } = useParams({ from: tenantRoute.id });
  const search = useSearch({ from: inboxRoute.id });
  const navigate = useNavigate();
  const view: InboxView = search.view ?? 'open';
  const inbox = useInbox(view);
  const counts = useInboxCounts();
  const me = useMe();
  const membership = me.data?.memberships.find((m) => m.slug === tenant);
  const canWrite = membership === undefined || membership.permissions.includes('conversations:write');
  const channels = useChannels();

  const go = (next: InboxSearch) =>
    void navigate({ to: '/t/$tenant/conversations', params: { tenant }, search: (prev: InboxSearch) => ({ ...prev, ...next }), replace: true });

  const badge = (n: number | undefined) => (n === undefined || n === 0 ? '' : ` (${String(n)})`);
  usePageChrome({
    title: t('conversations.title'),
    tabs: INBOX_VIEWS.map((value) => ({
      value,
      label:
        t(`conversations.view.${value}` as 'conversations.view.open') +
        (value === 'open' ? badge(counts.data?.open) : value === 'mine' ? badge(counts.data?.mine) : value === 'unassigned' ? badge(counts.data?.unassigned) : ''),
    })),
    tab: view,
    onTabChange: (value) => {
      if (isInboxView(value)) go({ view: value, c: undefined });
    },
  });

  const rows = (inbox.data?.pages ?? []).flatMap((p) => p.data);
  const noChannels = channels.data !== undefined && channels.data.length === 0;

  return (
    <PageBody className="flex h-[calc(100dvh-8rem)] min-h-[420px] px-0 pb-0">
      <div className="flex min-h-0 w-full overflow-hidden rounded-lg border border-border">
        <aside className="flex w-80 shrink-0 flex-col border-r border-border">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((conversation) => (
              <ConversationRow key={conversation.id} conversation={conversation} active={conversation.id === search.c} onOpen={() => go({ c: conversation.id })} />
            ))}
            {inbox.isPending ? <p className="p-3 text-sm">{t('common.loading')}</p> : null}
            {!inbox.isPending && rows.length === 0 ? <p className="p-3 text-sm text-(--obsidian-dashboard-shell-text-subtle)">{t('conversations.empty')}</p> : null}
            {inbox.hasNextPage ? (
              <div className="p-2 text-center">
                <Button type="button" variant="ghost" size="sm" onClick={() => void inbox.fetchNextPage()}>
                  {t('conversations.more')}
                </Button>
              </div>
            ) : null}
          </div>
        </aside>
        {search.c !== undefined ? (
          <Thread key={search.c} id={search.c} canWrite={canWrite} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div className="grid max-w-sm justify-items-center gap-2 text-sm text-(--obsidian-dashboard-shell-text-subtle)">
              <MessagesSquare className="size-8" />
              <p>{noChannels ? t('conversations.noChannels') : t('conversations.pick')}</p>
              {noChannels ? (
                <Button asChild variant="outline" size="sm">
                  <Link to="/t/$tenant/settings/apps" params={{ tenant }}>
                    {t('conversations.browseApps')}
                  </Link>
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </PageBody>
  );
}

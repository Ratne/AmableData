import { replyWindowOpen } from '@amable/api-types';
import { toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Textarea } from '@amable/ui/ui/textarea';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { MessageSquarePlus, MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { ApiError, useMe } from '../../lib/api';
import { ChoiceSelect } from '../crm/components/inputs';
import { SectionCard } from '../crm/components/states';
import { channelName, useChannels, useChannelTemplates, useContactConversations, useInboxMutation, type OutgoingMessage } from './api';
import { TemplatePicker, templateMessage, type TemplateDraft } from './template-picker';

/** Threads of a contact on the contact page, and "write first" on a channel. */
export function ContactConversations({ contactId }: { contactId: string }) {
  const { t, locale } = useI18n();
  const { tenant } = useParams({ strict: false });
  const slug = tenant ?? 'demo';
  const navigate = useNavigate();
  const me = useMe();
  const membership = me.data?.memberships.find((m) => m.slug === slug);
  const canRead = membership === undefined || membership.permissions.includes('conversations:read');
  const canWrite = membership === undefined || membership.permissions.includes('conversations:write');
  const channels = useChannels(canRead);
  const threads = useContactConversations(contactId, canRead);
  const usable = (channels.data ?? []).filter((c) => !c.paused);
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState('');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<TemplateDraft>({ id: '', params: {} });
  const selected = usable.find((c) => c.id === channel) ?? usable[0];
  const existing = threads.data?.find((thread) => thread.channel === selected?.id);
  // Without a recent message from the contact, channels like WhatsApp only accept a template.
  const templateOnly = selected !== undefined && !replyWindowOpen(existing?.last_inbound_at ?? null, selected.reply_window_hours);
  const templates = useChannelTemplates(selected, open && templateOnly);
  const start = useInboxMutation((api, input: { channel: string; contact_id: string } & OutgoingMessage) => api.start(input));

  if (!canRead || (usable.length === 0 && (threads.data?.length ?? 0) === 0)) return null;

  const outgoing: OutgoingMessage | null = templateOnly
    ? templateMessage(templates.data, draft)
    : text.trim() === ''
      ? null
      : { text: text.trim() };
  const submit = () => {
    if (selected === undefined || outgoing === null) return;
    start.mutate(
      { channel: selected.id, contact_id: contactId, ...outgoing },
      {
        onSuccess: (result) => {
          setOpen(false);
          setText('');
          setDraft({ id: '', params: {} });
          if (result.message.status === 'failed') toast.error(t('conversations.failed', { error: result.message.error ?? '' }));
          void navigate({ to: '/t/$tenant/conversations', params: { tenant: slug }, search: { c: result.data.id } });
        },
        onError: (error) =>
          toast.error(error instanceof ApiError && error.code === 'validation_failed' ? t('conversations.start.noAddress') : t('common.error')),
      },
    );
  };

  return (
    <SectionCard
      title={t('conversations.title')}
      actions={
        canWrite && usable.length > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            <MessageSquarePlus /> {t('conversations.start.button')}
          </Button>
        ) : null
      }
    >
      {(threads.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('conversations.contact.none')}</p>
      ) : (
        <ul className="grid gap-1">
          {threads.data!.map((thread) => (
            <li key={thread.id}>
              <Link
                to="/t/$tenant/conversations"
                params={{ tenant: slug }}
                search={{ c: thread.id }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
                <MessagesSquare className="size-4 shrink-0" />
                <span className="shrink-0 font-medium">{channelName(channels.data, thread.channel, locale)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{thread.last_message_preview ?? ''}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{t(`conversations.view.${thread.status}` as 'conversations.view.open')}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('conversations.start.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            {usable.length > 1 ? (
              <ChoiceSelect
                value={selected?.id ?? ''}
                onChange={(id) => {
                  setChannel(id);
                  setDraft({ id: '', params: {} });
                }}
                allowEmpty={false}
                ariaLabel={t('conversations.channel')}
                choices={usable.map((c) => ({ value: c.id, label: `${channelName(usable, c.id, locale)} · ${c.app_name}` }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t('conversations.start.via', { channel: channelName(usable, usable[0]!.id, locale) })}</p>
            )}
            {templateOnly && selected !== undefined ? (
              selected.templates ? (
                <>
                  <p className="text-xs text-muted-foreground">{t('conversations.window.startWithTemplate')}</p>
                  <TemplatePicker channel={selected} draft={draft} onChange={setDraft} disabled={start.isPending} />
                </>
              ) : (
                <p className="text-xs text-destructive">{t('conversations.window.closedNoTemplates', { hours: String(selected.reply_window_hours ?? 24) })}</p>
              )
            ) : (
              <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} maxLength={4096} aria-label={t('conversations.reply')} />
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={submit} disabled={start.isPending || outgoing === null}>
              {t('conversations.send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

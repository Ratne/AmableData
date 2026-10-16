import type { BroadcastStatus, Contact } from '@amable/api-types';
import { defaultLiquidFields, EmailPreview, type JSONContent, type LiquidFieldGroup } from '@amable/editor';
import type { MessageKey } from '@amable/i18n';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Checkbox } from '@amable/ui/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { useQuery } from '@tanstack/react-query';
import { Monitor, Send, Smartphone, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { useMe } from '../../lib/api';
import { emailKeys, useEmailApi, useEmailMutation } from './api';

type Translate = ReturnType<typeof useI18n>['t'];

const BLOCK_KEYS: Readonly<Record<string, MessageKey>> = {
  domain_not_verified: 'email.block.domain_not_verified',
  from_domain_not_verified: 'email.block.from_domain_not_verified',
  missing_from_email: 'email.block.missing_from_email',
  sending_suspended: 'email.block.sending_suspended',
  missing_physical_address: 'email.block.missing_physical_address',
  no_segment: 'email.block.no_segment',
  empty_segment: 'email.block.empty_segment',
  no_content: 'email.block.no_content',
  invalid_content: 'email.block.invalid_content',
  quota_denied: 'email.block.quota_denied',
  quota_paused: 'email.block.quota_paused',
};

/** Human text of a sending block reason / error code. */
export function blockText(t: Translate, code: string | null): string {
  if (code === null) return '';
  const key = BLOCK_KEYS[code];
  return key === undefined ? code : t(key);
}

const STATUS_KEYS: Readonly<Record<BroadcastStatus, MessageKey>> = {
  draft: 'broadcasts.status.draft',
  scheduled: 'broadcasts.status.scheduled',
  sending: 'broadcasts.status.sending',
  paused: 'broadcasts.status.paused',
  sent: 'broadcasts.status.sent',
  cancelled: 'broadcasts.status.cancelled',
};

export function BroadcastStatusBadge({ status }: { status: BroadcastStatus }) {
  const { t } = useI18n();
  const variant = status === 'sent' ? 'default' : status === 'cancelled' ? 'outline' : 'secondary';
  return <Badge variant={variant}>{t(STATUS_KEYS[status])}</Badge>;
}

export function contactLabel(contact: Contact): string {
  const name = [contact.given_name, contact.family_name].filter(Boolean).join(' ');
  const email = contact.emails[0]?.email ?? '';
  return name === '' ? email : email === '' ? name : `${name} · ${email}`;
}

/** Liquid fields of the `{{` picker: built-ins, contact custom fields and Dynamic Content snippets. */
export function useLiquidFields(): LiquidFieldGroup[] {
  const { slug, api } = useEmailApi();
  const { t } = useI18n();
  const custom = useQuery({ queryKey: emailKeys.crm(slug, 'customFields'), queryFn: api.crm.customFields, staleTime: 60_000 });
  const snippets = useQuery({ queryKey: emailKeys.snippets(slug), queryFn: api.snippets.list, staleTime: 30_000 });
  return useMemo(() => {
    const groups = defaultLiquidFields(
      (custom.data?.data ?? []).map((field) => ({ key: field.key, label: field.label })),
    );
    const list = snippets.data?.data ?? [];
    if (list.length > 0) {
      groups.push({
        id: 'snippets',
        label: t('email.snippets.group'),
        fields: list.map((s) => ({ path: `snippets.${s.key}`, label: s.name })),
      });
    }
    return groups;
  }, [custom.data, snippets.data, t]);
}

/** Search-as-you-type contact picker (preview with a real contact). */
export function ContactPicker({
  value,
  onChange,
}: {
  value: Contact | null;
  onChange: (contact: Contact | null) => void;
}) {
  const { t } = useI18n();
  const { slug, api } = useEmailApi();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);
  const results = useQuery({
    queryKey: emailKeys.crm(slug, `contacts:${debounced}`),
    queryFn: () => api.crm.searchContacts(debounced),
    enabled: value === null,
  });
  if (value !== null) {
    return (
      <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
        <span className="min-w-0 flex-1 truncate">{contactLabel(value)}</span>
        <Button type="button" size="icon" variant="ghost" className="size-6" onClick={() => onChange(null)} aria-label={t('email.preview.sample')}>
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('email.preview.searchContact')} />
      {(results.data?.data.length ?? 0) > 0 && q !== '' ? (
        <ul className="max-h-48 overflow-auto rounded-md border text-sm">
          {results.data?.data.map((contact) => (
            <li key={contact.id}>
              <button
                type="button"
                className="w-full truncate px-2 py-1.5 text-left hover:bg-(--obsidian-dashboard-shell-muted)"
                onClick={() => {
                  onChange(contact);
                  setQ('');
                }}
              >
                {contactLabel(contact)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const SAMPLE_CONTEXT = {
  contact: { first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace', email: 'ada@example.com', tags: [], custom: {} },
  owner: { name: 'Marco Rossi', email: 'marco@example.com' },
  company: { name: 'Analytical Engines Srl' },
  snippets: {},
};

/** Live preview of the email as a sample or a real contact receives it. */
export function EmailPreviewPanel({
  doc,
  subject,
  contact,
  onContactChange,
  deviceToggle = false,
}: {
  doc: JSONContent;
  subject: string;
  contact: Contact | null;
  onContactChange: (contact: Contact | null) => void;
  /** Desktop / mobile width switch for the HTML view. */
  deviceToggle?: boolean;
}) {
  const { t, locale } = useI18n();
  const { slug, api } = useEmailApi();
  const [view, setView] = useState<'html' | 'text'>('html');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const settings = useQuery({ queryKey: emailKeys.settings(slug), queryFn: api.settings.get, staleTime: 30_000 });
  const context = useQuery({
    queryKey: emailKeys.crm(slug, `preview:${contact?.id ?? ''}`),
    queryFn: () => api.previewContext(contact?.id ?? ''),
    enabled: contact !== null,
  });
  const options = useMemo(
    () => ({
      subject,
      lang: locale,
      unsubscribeLabel: t('editor.unsubscribeDefault'),
      ...(settings.data?.physical_address ? { footerAddress: settings.data.physical_address } : {}),
      ...(settings.data?.timezone ? { timezone: settings.data.timezone } : {}),
    }),
    [locale, settings.data?.physical_address, settings.data?.timezone, subject, t],
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid min-w-64 flex-1 gap-1.5">
          <Label>{t('email.preview.as')}</Label>
          <ContactPicker value={contact} onChange={onContactChange} />
        </div>
        <div className="flex flex-wrap gap-2">
          {deviceToggle && view === 'html' ? (
            <Tabs value={device} onValueChange={(value) => setDevice(value === 'mobile' ? 'mobile' : 'desktop')}>
              <TabsList>
                <TabsTrigger value="desktop" aria-label={t('email.preview.desktop')}>
                  <Monitor className="size-3.5" aria-hidden />
                  {t('email.preview.desktop')}
                </TabsTrigger>
                <TabsTrigger value="mobile" aria-label={t('email.preview.mobile')}>
                  <Smartphone className="size-3.5" aria-hidden />
                  {t('email.preview.mobile')}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          <Tabs value={view} onValueChange={(value) => setView(value === 'text' ? 'text' : 'html')}>
            <TabsList>
              <TabsTrigger value="html">{t('email.preview.html')}</TabsTrigger>
              <TabsTrigger value="text">{t('email.preview.text')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>
      <div
        className={
          deviceToggle && device === 'mobile' && view === 'html'
            ? 'mx-auto w-[375px] max-w-full overflow-hidden rounded-[1.5rem] border-8 border-(--obsidian-dashboard-shell-muted)'
            : 'w-full'
        }
        data-device={deviceToggle ? device : undefined}
      >
        <EmailPreview
          doc={doc}
          context={contact !== null && context.data ? context.data.context : SAMPLE_CONTEXT}
          options={options}
          view={view}
        />
      </div>
    </div>
  );
}

/** Test send to workspace members only (server enforces it too). */
export function TestSendDialog({
  open,
  onOpenChange,
  send,
  contact,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  send: (input: { user_ids: string[]; contact_id?: string }) => Promise<{ sent: { email: string }[] }>;
  contact: Contact | null;
}) {
  const { t } = useI18n();
  const { slug, api } = useEmailApi();
  const me = useMe();
  const directory = useQuery({ queryKey: emailKeys.crm(slug, 'directory'), queryFn: api.tenant.directory, enabled: open });
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (open && me.data?.user.id) setSelected([me.data.user.id]);
  }, [open, me.data?.user.id]);
  const mutation = useEmailMutation({
    mutationFn: () => send({ user_ids: selected, ...(contact === null ? {} : { contact_id: contact.id }) }),
    success: (out) => t('email.test.sent', { emails: out.sent.map((s) => s.email).join(', ') }),
    onSuccess: () => onOpenChange(false),
    errorText: (message) => t('email.common.error', { message: blockText(t, message) }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('email.test.title')}</DialogTitle>
          <DialogDescription>{t('email.test.body')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label>{t('email.test.recipients')}</Label>
          {(directory.data?.members ?? []).map((member) => (
            <label key={member.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.includes(member.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked === true ? [...new Set([...current, member.id])] : current.filter((id) => id !== member.id),
                  )
                }
              />
              {member.name}
            </label>
          ))}
          <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">
            {t('email.test.contact')}: {contact === null ? t('email.preview.sample') : contactLabel(contact)}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('email.common.cancel')}
          </Button>
          <Button disabled={selected.length === 0 || mutation.isPending} onClick={() => mutation.mutate(undefined)}>
            <Send className="size-4" />
            {t('email.test.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function formatDateTime(locale: string, iso: string | null): string {
  if (iso === null) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function percent(value: number): string {
  return (Math.round(value * 1000) / 10).toString();
}

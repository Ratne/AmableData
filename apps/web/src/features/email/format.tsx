import type { BroadcastStatus, Contact } from '@amable/api-types';
import type { MessageKey } from '@amable/i18n';
import { Badge } from '@amable/ui/ui/badge';
import { useI18n } from '../../i18n';

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

export function formatDateTime(locale: string, iso: string | null): string {
  if (iso === null) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function percent(value: number): string {
  return (Math.round(value * 1000) / 10).toString();
}

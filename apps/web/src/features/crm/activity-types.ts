import type { Activity } from '@amable/api-types/crm';
import type { MessageKey } from '@amable/i18n';
import {
  Activity as ActivityIcon,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  CheckSquare,
  ClipboardList,
  CreditCard,
  FileText,
  Globe,
  Handshake,
  Mail,
  MailOpen,
  MailWarning,
  MailX,
  MousePointerClick,
  RefreshCw,
  ShoppingCart,
  StickyNote,
  Tag,
  Upload,
  User,
  type LucideIcon,
} from 'lucide-react';
import { formatDate, formatMoney } from './components/cells';

const ACTIVITY_LABELS: Readonly<Record<string, MessageKey>> = {
  'contact.created': 'crm.activity.contactCreated',
  'contact.updated': 'crm.activity.contactUpdated',
  'contact.deleted': 'crm.activity.contactDeleted',
  'contact.restored': 'crm.activity.contactRestored',
  'contact.merged': 'crm.activity.contactMerged',
  'contact.tag_applied': 'crm.activity.tagApplied',
  'contact.tag_removed': 'crm.activity.tagRemoved',
  'contact.score_changed': 'crm.activity.scoreChanged',
  'contact.owner_assigned': 'crm.activity.ownerAssigned',
  'company.created': 'crm.activity.companyCreated',
  'company.updated': 'crm.activity.companyUpdated',
  'company.deleted': 'crm.activity.companyDeleted',
  'note.added': 'crm.activity.noteAdded',
  'note.updated': 'crm.activity.noteUpdated',
  'note.deleted': 'crm.activity.noteDeleted',
  'task.created': 'crm.activity.taskCreated',
  'task.updated': 'crm.activity.taskUpdated',
  'task.completed': 'crm.activity.taskCompleted',
  'task.reopened': 'crm.activity.taskReopened',
  'task.deleted': 'crm.activity.taskDeleted',
  'appointment.created': 'crm.activity.appointmentCreated',
  'appointment.updated': 'crm.activity.appointmentUpdated',
  'appointment.cancelled': 'crm.activity.appointmentCancelled',
  'appointment.deleted': 'crm.activity.appointmentDeleted',
  'appointment.booked': 'crm.activity.appointmentBooked',
  'appointment.rescheduled': 'crm.activity.appointmentRescheduled',
  'booking.created': 'crm.activity.bookingCreated',
  'opportunity.created': 'crm.activity.dealCreated',
  'opportunity.updated': 'crm.activity.dealUpdated',
  'opportunity.stage_changed': 'crm.activity.dealStageChanged',
  'opportunity.won': 'crm.activity.dealWon',
  'opportunity.lost': 'crm.activity.dealLost',
  'opportunity.deleted': 'crm.activity.dealDeleted',
  'import.completed': 'crm.activity.imported',
  'form.submitted': 'crm.activity.formSubmitted',
  'page.published': 'crm.activity.pagePublished',
  'page.unpublished': 'crm.activity.pageUnpublished',
  'email.sent': 'crm.activity.emailSent',
  'email.delivered': 'crm.activity.emailDelivered',
  'email.opened': 'crm.activity.emailOpened',
  'email.link_clicked': 'crm.activity.emailClicked',
  'email.clicked': 'crm.activity.emailClicked',
  'email.bounced': 'crm.activity.emailBounced',
  'email.complained': 'crm.activity.emailComplained',
  'email.unsubscribed': 'crm.activity.emailUnsubscribed',
  'order.created': 'crm.activity.orderCreated',
  'order.paid': 'crm.activity.orderPaid',
  'order.cancelled': 'crm.activity.orderCancelled',
  'payment.recorded': 'crm.activity.paymentRecorded',
  'payment.failed': 'crm.activity.paymentFailed',
  'refund.recorded': 'crm.activity.refundRecorded',
  'subscription.started': 'crm.activity.subscriptionStarted',
  'subscription.upgraded': 'crm.activity.subscriptionUpgraded',
  'subscription.downgraded': 'crm.activity.subscriptionDowngraded',
  'subscription.renewed': 'crm.activity.subscriptionRenewed',
  'subscription.cancel_scheduled': 'crm.activity.subscriptionCancelScheduled',
  'subscription.reactivated': 'crm.activity.subscriptionReactivated',
  'subscription.paused': 'crm.activity.subscriptionPaused',
  'subscription.past_due': 'crm.activity.subscriptionPastDue',
  'subscription.ended': 'crm.activity.subscriptionEnded',
  'subscription.trial_started': 'crm.activity.subscriptionTrialStarted',
  'subscription.trial_converted': 'crm.activity.subscriptionTrialConverted',
};

const EXACT_ICONS: Readonly<Record<string, LucideIcon>> = {
  'contact.tag_applied': Tag,
  'contact.tag_removed': Tag,
  'appointment.cancelled': CalendarX,
  'appointment.deleted': CalendarX,
  'appointment.booked': CalendarCheck,
  'booking.created': CalendarCheck,
  'appointment.rescheduled': RefreshCw,
  'email.opened': MailOpen,
  'email.link_clicked': MousePointerClick,
  'email.clicked': MousePointerClick,
  'email.bounced': MailWarning,
  'email.complained': MailWarning,
  'email.unsubscribed': MailX,
};

const PREFIX_ICONS: Readonly<Record<string, LucideIcon>> = {
  contact: User,
  company: Building2,
  note: StickyNote,
  task: CheckSquare,
  appointment: CalendarClock,
  booking: CalendarClock,
  opportunity: Handshake,
  import: Upload,
  form: ClipboardList,
  page: Globe,
  email: Mail,
  order: ShoppingCart,
  payment: CreditCard,
  refund: CreditCard,
  subscription: RefreshCw,
};

/** Catalog key of a known activity type, or null for types this build does not know. */
export function activityLabelKey(type: string): MessageKey | null {
  return ACTIVITY_LABELS[type] ?? null;
}

/** Readable label for unknown types: `foo.bar_baz` → `Foo · bar baz`. */
export function fallbackActivityLabel(type: string): string {
  const [head = '', ...rest] = type.split('.');
  const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();
  const first = words(head);
  const label = first.charAt(0).toUpperCase() + first.slice(1);
  const tail = words(rest.join(' '));
  return tail === '' ? label || type : `${label} · ${tail}`;
}

export function activityIcon(type: string): LucideIcon {
  const exact = EXACT_ICONS[type];
  if (exact) return exact;
  const prefix = type.split('.')[0] ?? '';
  return PREFIX_ICONS[prefix] ?? (type === '' ? FileText : ActivityIcon);
}

export interface ActivityDetailContext {
  readonly locale: string;
  readonly tagName: (id: string) => string;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** Short secondary text shown after the label (changed fields, tag, title, date, amount…). */
export function activityDetail(activity: Activity, ctx: ActivityDetailContext): string {
  const data = activity.data;
  const fields = data['changedFields'];
  if (Array.isArray(fields) && fields.length > 0) return fields.map(String).join(', ');
  const tagId = str(data['tagId']);
  if (tagId !== null) {
    const live = ctx.tagName(tagId);
    return live === tagId ? (str(data['tagName']) ?? tagId) : live;
  }
  const title = str(data['title']);
  if (title !== null) return title;

  if (activity.type === 'appointment.booked' || activity.type === 'appointment.rescheduled') {
    return formatDate(ctx.locale, str(data['startsAt']), true);
  }
  if (activity.type === 'form.submitted') {
    const values = data['fields'];
    if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
      return Object.values(values as Record<string, unknown>)
        .filter((v): v is string => typeof v === 'string' && v !== '')
        .slice(0, 3)
        .join(', ');
    }
    return '';
  }
  if (activity.type.startsWith('email.')) {
    return str(data['subject']) ?? str(data['url']) ?? str(data['reason']) ?? '';
  }
  const amount = data['amountMinor'];
  const currency = str(data['currency']);
  if (typeof amount === 'number' && currency !== null) {
    const money = formatMoney(ctx.locale, amount, currency);
    const orderNumber = str(data['orderNumber']);
    return orderNumber === null ? money : `${orderNumber} · ${money}`;
  }
  return str(data['path']) ?? '';
}

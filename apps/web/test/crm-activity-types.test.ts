import type { Activity } from '@amable/api-types/crm';
import { t } from '@amable/i18n';
import { Activity as ActivityIcon, CalendarCheck, Mail, MousePointerClick } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import {
  activityDetail,
  activityIcon,
  activityLabelKey,
  fallbackActivityLabel,
} from '../src/features/crm/activity-types';

const activity = (type: string, data: Record<string, unknown>): Activity =>
  ({
    id: 'a1',
    type,
    contact_id: 'c1',
    company_id: null,
    opportunity_id: null,
    actor: { type: 'system', id: null },
    data,
    occurred_at: '2026-10-15T10:00:00.000Z',
  }) as Activity;

const ctx = { locale: 'en', tagName: (id: string) => `tag:${id}` };

describe('activity types', () => {
  it('labels publishing, booking and email events in both catalogs', () => {
    const types = [
      'form.submitted',
      'appointment.booked',
      'appointment.rescheduled',
      'appointment.cancelled',
      'page.published',
      'email.sent',
      'email.delivered',
      'email.opened',
      'email.link_clicked',
      'email.bounced',
      'email.complained',
      'email.unsubscribed',
      'order.paid',
      'subscription.started',
    ];
    for (const type of types) {
      const key = activityLabelKey(type);
      expect(key, type).not.toBeNull();
      if (key === null) continue;
      expect(t('en', key), type).not.toBe(t('it', key));
    }
    expect(t('en', activityLabelKey('appointment.booked') ?? 'crm.activity.imported')).toBe('Appointment booked');
  });

  it('falls back to a readable label and a generic icon for unknown types', () => {
    expect(activityLabelKey('sms.delivered')).toBeNull();
    expect(fallbackActivityLabel('sms.delivery_failed')).toBe('Sms · delivery failed');
    expect(fallbackActivityLabel('custom')).toBe('Custom');
    expect(fallbackActivityLabel('')).toBe('');
    expect(activityIcon('sms.delivered')).toBe(ActivityIcon);
  });

  it('picks icons by exact type, then by prefix', () => {
    expect(activityIcon('appointment.booked')).toBe(CalendarCheck);
    expect(activityIcon('email.link_clicked')).toBe(MousePointerClick);
    expect(activityIcon('email.delivered')).toBe(Mail);
  });

  it('renders details for the new types', () => {
    expect(activityDetail(activity('appointment.booked', { startsAt: '2026-10-20T09:00:00.000Z' }), ctx)).not.toBe('');
    expect(
      activityDetail(activity('form.submitted', { fields: { email: 'a@b.it', name: 'Ada', empty: '' } }), ctx),
    ).toBe('a@b.it, Ada');
    expect(activityDetail(activity('email.link_clicked', { url: 'https://x.it' }), ctx)).toBe('https://x.it');
    expect(
      activityDetail(activity('order.paid', { orderNumber: '#1001', amountMinor: 1250, currency: 'EUR' }), ctx),
    ).toBe('#1001 · €12.50');
    expect(activityDetail(activity('contact.tag_applied', { tagId: 't1' }), ctx)).toBe('tag:t1');
    expect(activityDetail(activity('weird.thing', {}), ctx)).toBe('');
  });
});

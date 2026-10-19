import type { EsignEvent } from '@amable/api-types';
import { renderEmail, type TiptapDocument } from '@amable/email-render';
import { describe, expect, it } from 'vitest';
import { signingDay } from '../../src/esign/fields';
import { esignEmail } from '../../src/esign/messages';
import type { RequestRow } from '../../src/esign/model';
import { certificateLocale } from '../../src/esign/pdf';

const consent = (locale: string): EsignEvent => ({
  id: `e_${locale}_${String(Math.random())}`,
  signer_id: 's1',
  type: 'consent_given',
  actor: { type: 'signer', id: 's1' },
  ip: null,
  user_agent: null,
  country: null,
  meta: { locale },
  occurred_at: '2026-10-15T12:00:00.000Z',
});

describe('certificate language', () => {
  const request = (locale: string) => ({ locale }) as RequestRow;

  it('uses the request language, or the one the signers saw with auto', () => {
    expect(certificateLocale(request('it'), [consent('en')])).toBe('it');
    expect(certificateLocale(request('auto'), [consent('it')])).toBe('it');
    expect(certificateLocale(request('auto'), [consent('it'), consent('en'), consent('en')])).toBe(
      'en',
    );
    expect(certificateLocale(request('auto'), [consent('it'), consent('en')])).toBe('it');
    expect(certificateLocale(request('auto'), [])).toBe('en');
  });
});

describe('deadline in signer emails', () => {
  // 23:30 UTC on 31 October: already 1 November in Rome.
  const expiresAt = Date.UTC(2026, 9, 31, 23, 30);
  const mail = (timeZone: string | null) =>
    esignEmail({
      id: 'm1',
      tenantId: 't1',
      senderName: 'Acme',
      tenantTimeZone: 'America/New_York',
      kind: 'invite',
      mail: {
        contactId: 'c1',
        email: 'a@example.com',
        partyName: 'Cliente',
        requestName: 'Contratto',
        requestId: 'r1',
        message: '',
        subject: '',
        locale: 'it',
        expiresAt,
        timeZone,
      },
      url: 'https://sign.example/x',
      now: Date.UTC(2026, 9, 15),
    });
  const text = (timeZone: string | null) => JSON.stringify(mail(timeZone).content.body);

  it('is shown in the signer’s time zone, else the workspace’s, with the hour', () => {
    expect(text('Europe/Rome')).toMatch(/1 novembre 2026.*00:30/);
    expect(text(null)).toMatch(/31 ottobre 2026.*19:30/);
    expect(text('Not/AZone')).toMatch(/31 ottobre 2026.*23:30/);
  });
});

describe('signer email text', () => {
  const invite = (locale: 'it' | 'en', message: string, firstName: string | null) =>
    esignEmail({
      id: 'm1',
      tenantId: 't1',
      senderName: 'Acme',
      kind: 'invite',
      mail: {
        contactId: 'c1',
        email: 'a@example.com',
        partyName: 'Cliente',
        requestName: 'Contratto',
        requestId: 'r1',
        message,
        subject: '',
        locale,
        expiresAt: null,
        firstName,
      },
      url: 'https://sign.example/x',
      now: Date.UTC(2026, 9, 15),
    });
  const rendered = async (locale: 'it' | 'en', firstName: string | null, message = '') =>
    (
      await renderEmail(invite(locale, message, firstName).content.body as unknown as TiptapDocument, {
        contact: { first_name: firstName },
      }, { requireUnsubscribe: false })
    ).text;

  it('greets without a dangling space when the contact has no first name', async () => {
    expect(await rendered('it', null)).toMatch(/^Ciao,/);
    expect(await rendered('it', 'Rita')).toMatch(/^Ciao Rita,/);
    expect(await rendered('en', null)).toMatch(/^Hi there,/);
  });

  it('fills esign variables written in the custom message', async () => {
    const text = await rendered('en', 'Rita', 'Please sign {{ esign.document }} as {{ esign.party }}.');
    expect(text).toContain('Please sign Contratto as Cliente.');
  });
});

describe('signing date', () => {
  // 23:30 UTC on 31 October: already 1 November in Rome.
  const now = Date.UTC(2026, 9, 31, 23, 30);
  it('is the day the signer’s browser showed, else UTC', () => {
    expect(signingDay(now, 'Europe/Rome')).toBe('2026-11-01');
    expect(signingDay(now, 'America/New_York')).toBe('2026-10-31');
    expect(signingDay(now, undefined)).toBe('2026-10-31');
    expect(signingDay(now, 'Not/AZone')).toBe('2026-10-31');
  });
});

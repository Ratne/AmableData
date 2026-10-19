import { renderEmailLayout, renderSystemEmail } from '@amable/i18n';
import { describe, expect, it } from 'vitest';

describe('system email layout', () => {
  it('renders the branded card with the action, escaping every variable', () => {
    const email = renderSystemEmail(
      'invite',
      'it',
      { tenant: 'Acme <b>', inviter: 'Ada', role: 'Admin', url: 'https://crm.example.com/invite#token=a"b', days: 7 },
      { logoUrl: 'https://crm.example.com/brand/logo.png' },
    );
    expect(email.subject).toBe('Ada ti ha invitato in Acme <b>');
    expect(email.html).toContain('<img src="https://crm.example.com/brand/logo.png"');
    expect(email.html).toContain('Acme &lt;b&gt;');
    expect(email.html).not.toContain('Acme <b>');
    expect(email.html).toContain('href="https://crm.example.com/invite#token=a&quot;b"');
    expect(email.html).toContain('background:#2563eb');
    expect(email.text).toContain('Accetta invito: https://crm.example.com/invite#token=a"b');
  });

  it('shows codes as a highlighted block and keeps the plain text in sync', () => {
    const email = renderSystemEmail('email_code', 'en', { code: '123456', minutes: 10 });
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('>123456</p>');
    expect(email.text.split('\n\n')).toEqual([
      'Your verification code: 123456',
      'Your verification code is below. It expires in 10 minutes.',
      '123456',
      'Never share this code. We will never ask for it.\n',
    ]);
  });

  it('renders detail rows', () => {
    const { html, text } = renderEmailLayout({
      lang: 'en',
      title: 'Summary',
      blocks: [{ type: 'details', rows: [['Emails sent', '1,200']] }],
    });
    expect(html).toContain('Emails sent</td>');
    expect(text).toContain('Emails sent: 1,200');
  });
});

import { describe, expect, it } from 'vitest';
import {
  compileEmail,
  createRecipientRenderer,
  MissingUnsubscribeUrlError,
  renderEmail,
  type TiptapDocument,
} from '../src';
import { newsletter, regularContext, vipContext } from './fixtures';

/** The token nonce changes per compile; everything else must be deterministic. */
function stable(html: string): string {
  return html.replace(/%%AMBLQ[0-9a-f]+_/g, '%%AMBLQ_');
}

describe('compileEmail', () => {
  it('produces a table-based, inline-styled, fixed-width HTML template', () => {
    const compiled = compileEmail(newsletter, { subject: 'News for {{ contact.first_name }}' });
    expect(compiled.htmlTemplate.startsWith('<!DOCTYPE html')).toBe(true);
    expect(compiled.htmlTemplate).toContain('<table');
    expect(compiled.htmlTemplate).toContain('max-width:600px');
    expect(compiled.htmlTemplate).not.toContain('class=');
    expect(compiled.htmlTemplate).not.toContain('%%AMBLQ');
    expect(stable(compiled.htmlTemplate)).toMatchSnapshot();
  });

  it('keeps Liquid unresolved in the templates', () => {
    const compiled = compileEmail(newsletter);
    expect(compiled.htmlTemplate).toContain('{{ contact.first_name | default: "there" }}');
    expect(compiled.htmlTemplate).toContain('{% if contact.tags contains "VIP" %}');
    expect(compiled.htmlTemplate).toContain('{% else %}');
    expect(compiled.htmlTemplate).toContain('{% endif %}');
    expect(compiled.textTemplate).toContain('{{ contact.first_name | default: "there" }}');
  });

  it('generates the plain-text version from the same document', () => {
    const compiled = compileEmail(newsletter);
    expect(compiled.textTemplate).toMatchSnapshot();
    expect(compiled.textTemplate).toContain('AUTUMN NEWS');
    expect(compiled.textTemplate).toContain('blog (https://example.com/blog?a=1&b=2)');
    expect(compiled.textTemplate).toContain('Open the app: https://example.com/app');
    expect(compiled.textTemplate).toContain('- Faster search');
  });

  it('treats Liquid typed as plain text literally', async () => {
    const doc: TiptapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Literal {{ contact.secret }} and {% assign x = 1 %}' }],
        },
      ],
    };
    const email = await renderEmail(doc, {
      contact: { secret: 'leaked' },
      unsubscribe_url: 'https://t.example.com/u/1',
    });
    expect(email.html).not.toContain('leaked');
    expect(email.html).toContain('&#123;&#123; contact.secret }}');
    expect(email.html).not.toContain('{{');
    expect(email.text).toContain('Literal {{ contact.secret }}');
    expect(email.text).not.toContain('leaked');
  });
});

describe('per-recipient rendering', () => {
  const renderer = createRecipientRenderer(
    compileEmail(newsletter, { subject: 'News for {{ contact.first_name | default: "you" }}' }),
  );

  it('resolves variables, conditions and raw Liquid for each recipient', async () => {
    const vip = await renderer.render(vipContext);
    expect(vip.subject).toBe('News for Ada');
    expect(vip.html).toContain('Hi Ada,');
    expect(vip.html).toContain('Thanks for being a VIP.');
    expect(vip.html).not.toContain('Upgrade to VIP today.');
    expect(vip.html).toContain('Free shipping on your next order.');
    expect(vip.text).toContain('Thanks for being a VIP.');

    const regular = await renderer.render(regularContext);
    expect(regular.subject).toBe('News for you');
    expect(regular.html).toContain('Hi there,');
    expect(regular.html).toContain('Upgrade to VIP today.');
    expect(regular.html).not.toContain('Thanks for being a VIP.');
    expect(regular.html).not.toContain('Free shipping');
    expect(regular.text).not.toMatch(/\n{3,}/);
  });

  it('HTML-escapes contact data in the HTML and keeps it raw in the text', async () => {
    const email = await renderer.render({
      ...vipContext,
      contact: { first_name: '<img src=x onerror=alert(1)>', tags: [] },
    });
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.text).toContain('Hi <img src=x onerror=alert(1)>,');
  });

  it('sanitizes dangerous markup produced by raw Liquid and contact-controlled links', async () => {
    const doc: TiptapDocument = {
      type: 'doc',
      content: [
        {
          type: 'liquidRaw',
          attrs: { code: '<script>alert(1)</script><p onclick="x()">Hello</p>' },
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [{ type: 'link', attrs: { href: '{{ contact.website }}' } }],
              text: 'site',
            },
          ],
        },
      ],
    };
    const email = await renderEmail(doc, {
      contact: { website: 'javascript:alert(1)' },
      unsubscribe_url: 'https://t.example.com/u/2',
    });
    expect(email.html).not.toContain('<script');
    expect(email.html).not.toContain('onclick');
    expect(email.html).not.toContain('javascript:');
    expect(email.html).toContain('<p>Hello</p>');
  });

  it('runs Liquid in a sandbox without filesystem access', async () => {
    const doc: TiptapDocument = {
      type: 'doc',
      content: [{ type: 'liquidRaw', attrs: { code: "{% include '/etc/passwd' %}" } }],
    };
    await expect(
      renderEmail(doc, { unsubscribe_url: 'https://t.example.com/u/3' }),
    ).rejects.toThrow();
  });
});

describe('unsubscribe footer', () => {
  const bare: TiptapDocument = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
  };

  it('is appended when the document has none', async () => {
    const email = await renderEmail(
      bare,
      { unsubscribe_url: 'https://t.example.com/unsub/abc' },
      { unsubscribeLabel: 'Stop these emails' },
    );
    expect(email.html).toContain('href="https://t.example.com/unsub/abc"');
    expect(email.html).toContain('Stop these emails');
    expect(email.text).toContain('Stop these emails: https://t.example.com/unsub/abc');
  });

  it('always renders the link inside an author footer, with the physical address', async () => {
    const email = await renderEmail(newsletter, vipContext, {
      footerAddress: 'Example Srl, Via Roma 1, Milano',
    });
    expect(email.html).toContain('Unsubscribe from these emails');
    expect(email.html).toContain('href="https://t.example.com/unsub/tok_vip"');
    expect(email.html).toContain('Example Srl, Via Roma 1, Milano');
  });

  it('refuses to render without a real unsubscribe URL', async () => {
    await expect(renderEmail(bare, {})).rejects.toBeInstanceOf(MissingUnsubscribeUrlError);
    await expect(
      renderEmail(bare, { unsubscribe_url: 'javascript:alert(1)' }),
    ).rejects.toBeInstanceOf(MissingUnsubscribeUrlError);
  });

  it('can be disabled for transactional system email', async () => {
    const email = await renderEmail(bare, {}, { requireUnsubscribe: false });
    expect(email.html).not.toContain('Unsubscribe');
    expect(email.text).toBe('Hello');
  });
});

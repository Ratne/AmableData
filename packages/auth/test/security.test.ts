import { describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  isPrivateAddress,
  redactIpAddresses,
  renderSandboxed,
  safeFetch,
  sanitizeEmailDocument,
  sanitizeHtml,
  sanitizeStyle,
  SsrfBlockedError,
  ResponseTooLargeError,
} from '../src/security/index';

describe('IP address redaction', () => {
  it('masks IPv4 and every IPv6 form', () => {
    const cases = [
      'connect 2001:0db8:85a3:0000:0000:8a2e:0370:7334 failed',
      'from 2001:db8::1 port 443',
      'peer [fe80::1%eth0]:8080',
      'loopback ::1 refused',
      'mapped ::ffff:192.168.1.10 blocked',
      'client 2606:4700:4700::1111, retry',
      'origin 10.0.0.12 down',
    ];
    for (const text of cases) {
      const out = redactIpAddresses(text);
      expect(out, text).toContain('[ip]');
      expect(out, text).not.toMatch(/\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}::|::[0-9a-f]{1,4}/i);
    }
  });

  it('keeps clock times, ratios and identifiers that are not addresses', () => {
    for (const text of ['at 12:30:45 UTC', 'ratio 3:2:1', 'Engine::alarm crashed', 'key a:b:c']) {
      expect(redactIpAddresses(text)).toBe(text);
    }
  });
});

describe('SSRF guard', () => {
  it.each([
    'http://127.0.0.1/',
    'http://localhost/',
    'http://foo.localhost/',
    'http://10.1.2.3/',
    'http://172.20.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://metadata.google.internal/',
    'http://intranet/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'https://user:pass@example.com/',
    'https://example.com:22/',
    'http://0177.0.0.1/',
    'http://017700000001/',
    'http://127.1/',
    'http://LOCALHOST./',
    'http://localhost.localdomain/',
    'http://ip6-localhost/',
    'http://printer.home/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[2002:a00:1::]/',
    'http://[2001:0:4136:e378::1]/',
    'http://[fec0::1]/',
    'http://[64:ff9b:1::a00:1]/',
    'http://[100::1]/',
    'http://[ff02::1]/',
    'http://[fe80::1%25eth0]/',
    'http://１２７.０.０.１/',
  ])('blocks %s', (url) => {
    expect(() => assertSafeUrl(url)).toThrow(SsrfBlockedError);
  });

  it('allows public URLs', () => {
    expect(assertSafeUrl('https://hooks.example.com/x').hostname).toBe('hooks.example.com');
    expect(assertSafeUrl('http://93.184.216.34/').hostname).toBe('93.184.216.34');
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('re-validates redirects and refuses private hops', async () => {
    const fetchFn = (url: string) =>
      Promise.resolve(
        url.startsWith('https://public.example.com')
          ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
          : new Response('secret'),
      );
    await expect(safeFetch('https://public.example.com/', {}, { fetchFn })).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('drops credentials on cross-origin redirects, keeps them same-origin, caps redirects', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url === 'https://a.example.com/1')
        return Promise.resolve(new Response(null, { status: 307, headers: { location: '/2' } }));
      if (url === 'https://a.example.com/2')
        return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://b.example.com/3' } }));
      return Promise.resolve(new Response('ok'));
    };
    await safeFetch('https://a.example.com/1', { headers: { authorization: 'Bearer s' } }, { fetchFn });
    expect(seen.map((s) => s.auth)).toEqual(['Bearer s', 'Bearer s', null]);

    let hops = 0;
    const loop = () => {
      hops += 1;
      return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://loop.example.com/' } }));
    };
    await expect(safeFetch('https://loop.example.com/', {}, { fetchFn: loop, maxRedirects: 50 })).rejects.toThrow(
      'too many redirects',
    );
    expect(hops).toBe(6);
  });

  it('aborts on timeout', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(safeFetch('https://slow.example.com/', {}, { fetchFn: hang, timeoutMs: 20 })).rejects.toThrow();
  });

  it('refuses hosts resolving to private addresses and oversized bodies', async () => {
    const fetchFn = () => Promise.resolve(new Response('x'.repeat(2048)));
    await expect(
      safeFetch('https://rebind.example.com/', {}, { fetchFn, resolver: () => Promise.resolve(['10.0.0.5']) }),
    ).rejects.toThrow(SsrfBlockedError);
    await expect(safeFetch('https://big.example.com/', {}, { fetchFn, maxBytes: 1024 })).rejects.toThrow(
      ResponseTooLargeError,
    );
    const ok = await safeFetch('https://ok.example.com/', {}, { fetchFn, maxBytes: 4096 });
    expect(ok.status).toBe(200);
    expect(ok.body.byteLength).toBe(2048);
  });
});

describe('HTML sanitizer', () => {
  it('keeps the editor whitelist and strips everything dangerous', () => {
    const dirty =
      '<p onclick="x()">Hi <strong>there</strong><script>alert(1)</script></p>' +
      '<a href="javascript:alert(1)">bad</a><a href="java\tscript:alert(1)">bad2</a>' +
      '<a href="https://ok.example" target="_blank">ok</a>' +
      '<img src="x" onerror="alert(1)"><iframe src="https://evil"></iframe>' +
      '<style>body{}</style><svg><script>1</script></svg><p>{{ contact.first_name }}</p>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|javascript|iframe|style|svg/i);
    expect(clean).toContain('<strong>there</strong>');
    expect(clean).toContain('<a href="https://ok.example" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(clean).toContain('<a>bad</a>');
    expect(clean).toContain('{{ contact.first_name }}');
  });

  it('escapes text and closes unbalanced tags', () => {
    expect(sanitizeHtml('<p>1 &lt; 2 <b>bold')).toBe('<p>1 &lt; 2 <b>bold</b></p>');
  });

  it('filters inline styles when enabled', () => {
    expect(sanitizeStyle('color: red; background: url(javascript:x); position: fixed')).toBe('color: red');
    const html = sanitizeHtml('<p style="text-align:center;behavior:url(x)">x</p>', { allowStyles: true });
    expect(html).toBe('<p style="text-align: center">x</p>');
    expect(sanitizeHtml('<p style="color:red">x</p>')).toBe('<p>x</p>');
  });
});

describe('email document sanitizer (shared with email-render)', () => {
  it('keeps the document structure, layout attributes and email CSS', () => {
    const html =
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html lang="en"><head>' +
      '<meta charset="utf-8"><title>T</title><style>*{}</style></head><body bgcolor="#fff">' +
      '<table role="presentation" cellpadding="0"><tr><td style="mso-line-height-rule: exactly; font: 14px/1.4 Arial !important">x</td></tr></table>' +
      '</body></html>';
    const clean = sanitizeEmailDocument(html);
    expect(clean.startsWith('<!DOCTYPE html PUBLIC')).toBe(true);
    expect(clean).toContain('<meta charset="utf-8"><title>T</title></head>');
    expect(clean).toContain('<table role="presentation" cellpadding="0">');
    expect(clean).toContain('style="mso-line-height-rule: exactly; font: 14px/1.4 Arial !important"');
    expect(clean).not.toContain('<style');
  });

  it('drops hostile doctypes, scripts, non-raster data URLs, CSS comments and re-encodes Liquid braces', () => {
    const clean = sanitizeEmailDocument(
      '<!DOCTYPE x [<!ENTITY a "b">]><p style="color: re/**/d">{{ contact.secret }}</p>' +
        '<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/svg+xml;base64,PHN2Zz4=">' +
        '<a href="https://x.example" target="_blank" rel="opener">l</a><script>1</script>',
    );
    expect(clean).not.toContain('DOCTYPE');
    expect(clean).not.toContain('{');
    expect(clean).toContain('&#123;&#123; contact.secret }}');
    expect(clean).toContain('<img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(clean).toContain('<img>');
    expect(clean).toContain('<p>');
    expect(clean).toContain('<a href="https://x.example" target="_blank" rel="noopener noreferrer">l</a>');
    expect(clean).not.toContain('script');
  });

  it('never allows data URLs outside images or by default', () => {
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA">')).toBe('<img>');
    expect(sanitizeEmailDocument('<a href="data:image/png;base64,AAAA">x</a>')).toBe('<a>x</a>');
  });
});

describe('sandboxed Liquid dates', () => {
  const at = '2026-10-16T07:00:00Z';
  const render = (template: string, data: Record<string, unknown>, timezone?: string) =>
    renderSandboxed(template, data, { escapeHtml: false, ...(timezone === undefined ? {} : { timezone }) });

  it('uses the engine timezone by default and lets an explicit zone win', async () => {
    expect(await render('{{ at | date: "%H:%M" }}', { at }, 'Europe/Rome')).toBe('09:00');
    expect(await render('{{ at | date: "%H:%M" }}', { at }, 'America/New_York')).toBe('03:00');
    expect(await render('{{ at | date: "%H:%M", "Asia/Tokyo" }}', { at }, 'Europe/Rome')).toBe('16:00');
    expect(await render('{{ at | date: "%H:%M", 0 }}', { at }, 'Europe/Rome')).toBe('07:00');
  });

  it('falls back to the engine timezone for a blank or unknown zone instead of failing', async () => {
    const template = '{{ at | date: "%H:%M", zone }}';
    expect(await render(template, { at, zone: '' }, 'Europe/Rome')).toBe('09:00');
    expect(await render(template, { at }, 'Europe/Rome')).toBe('09:00');
    expect(await render(template, { at, zone: 'Mars/Base' }, 'Europe/Rome')).toBe('09:00');
  });

  it('never shifts calendar dates', async () => {
    const template = '{{ d | date: "%Y-%m-%d" }}';
    for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      expect(await render(template, { d: '2026-12-01' }, zone)).toBe('2026-12-01');
    }
    expect(await render('{{ d | date: "%d/%m", "Pacific/Honolulu" }}', { d: '2026-12-01' })).toBe('01/12');
  });
});

describe('sandboxed Liquid', () => {
  it('does not escape when asked (plain text parts) and resolves no relative or absolute files', async () => {
    expect(await renderSandboxed('{{ v }}', { v: '<b>' }, { escapeHtml: false })).toBe('<b>');
    await expect(renderSandboxed("{% render '../footer' %}", {}, { partials: { footer: 'F' } })).rejects.toThrow();
    await expect(renderSandboxed("{% layout 'base' %}x", {})).rejects.toThrow();
  });

  it('renders, escapes by default and reads own properties only', async () => {
    const out = await renderSandboxed('Hi {{ contact.first_name | default: "there" }} {{ html }}', {
      contact: { first_name: 'Ada' },
      html: '<b>x</b>',
    });
    expect(out).toBe('Hi Ada &lt;b&gt;x&lt;/b&gt;');
    class Proto {
      secret = 'own';
    }
    Object.defineProperty(Proto.prototype, 'leak', { value: 'prototype' });
    expect(await renderSandboxed('{{ o.leak }}|{{ o.secret }}', { o: new Proto() })).toBe('|own');
  });

  it('has no filesystem and rejects unknown filters', async () => {
    await expect(renderSandboxed("{% include '/etc/passwd' %}", {})).rejects.toThrow();
    await expect(renderSandboxed('{{ x | nope }}', { x: 1 })).rejects.toThrow();
    expect(await renderSandboxed("{% render 'footer' %}", {}, { partials: { footer: 'F' } })).toBe('F');
  });

  it('bounds runaway templates', async () => {
    await expect(
      renderSandboxed('{% for i in (1..100000000) %}{% for j in (1..100000000) %}x{% endfor %}{% endfor %}', {}, {
        renderLimitMs: 50,
      }),
    ).rejects.toThrow();
  });
});

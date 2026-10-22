import { describe, expect, it } from 'vitest';
import {
  BUILDER_LABELS_IT,
  WIDGET_LIST,
  applyCanvasOp,
  builderDocumentSchema,
  builderLabel,
  builderPageCsp,
  createNode,
  emptyBuilderDocument,
  renderBuilderPage,
  sanitizeBuilderDocument,
  validateBuilderDocument,
  type BuilderDocument,
  type ElementNode,
} from '../src/index';

function node(id: string, type: string, settings: Record<string, unknown> = {}, children: ElementNode[] = []): ElementNode {
  return { id, type, settings, styles: [], children, locked: false };
}

function doc(body: ElementNode[]): BuilderDocument {
  return builderDocumentSchema.parse({ editorKind: 'canvas', body });
}

describe('builder schema', () => {
  it('fills defaults (tokens included) on a minimal document', () => {
    const d = builderDocumentSchema.parse({ body: [{ id: 'a', type: 'container' }] });
    expect(d.tokens.primary).toBe('#2563eb');
    expect(d.body[0]).toMatchObject({ settings: {}, styles: [], children: [], locked: false });
  });

  it('accepts the empty document and every catalog widget', () => {
    const body = WIDGET_LIST.map((w) => createNode(w.type));
    expect(validateBuilderDocument(emptyBuilderDocument()).ok).toBe(true);
    expect(validateBuilderDocument({ editorKind: 'canvas', body }).ok).toBe(true);
  });

  it('rejects malformed documents', () => {
    expect(validateBuilderDocument({ editorKind: 'sections' }).ok).toBe(false);
    expect(validateBuilderDocument({ body: [{ type: 'heading' }] }).ok).toBe(false);
    const unknown = validateBuilderDocument({ body: [{ id: 'x', type: 'nope' }] });
    expect(unknown.ok ? [] : unknown.issues.map((i) => i.message)).toEqual(['unknown widget type "nope"']);
    const dup = validateBuilderDocument({ body: [{ id: 'x', type: 'spacer' }, { id: 'x', type: 'spacer' }] });
    expect(dup.ok).toBe(false);
    const leafChildren = validateBuilderDocument({
      body: [{ id: 'h', type: 'heading', children: [{ id: 'c', type: 'spacer' }] }],
    });
    expect(leafChildren.ok).toBe(false);
  });

  it('applies canvas ops', () => {
    const d = doc([node('root', 'container')]);
    const next = applyCanvasOp(d, { kind: 'insert_node', node: node('h', 'heading', { title: 'Hi' }), parentId: 'root', index: 0 });
    expect(next.body[0]?.children.map((c) => c.id)).toEqual(['h']);
    expect(applyCanvasOp(next, { kind: 'insert_node', node: node('h', 'heading'), parentId: null, index: 0 })).toBe(next);
  });

  it('sanitizes rich text, including repeater rows', () => {
    const d = doc([
      node('t', 'text', { editor: '<p>ok</p><script>x</script>' }),
      node('tabs', 'tabs', { items: [{ title: 'A', content: '<img onerror=x>' }] }),
    ]);
    const clean = sanitizeBuilderDocument(d, (html) => html.replace(/<script>.*?<\/script>|<img[^>]*>/g, ''));
    expect(clean.body[0]?.settings.editor).toBe('<p>ok</p>');
    expect(clean.body[1]?.settings.items).toEqual([{ title: 'A', content: '' }]);
  });

  it('ships an Italian dictionary keyed by the English labels', () => {
    expect(builderLabel('Heading', 'it')).toBe('Titolo');
    expect(builderLabel('Heading', 'en')).toBe('Heading');
    expect(builderLabel('Padding', 'it')).toBe('Padding');
    expect(Object.keys(BUILDER_LABELS_IT).length).toBeGreaterThan(200);
  });
});

describe('builder render', () => {
  const page = doc([
    node('root', 'container', { htmlTag: 'section' }, [
      node('h1', 'heading', { title: 'Hello <strong>world</strong><script>bad()</script>', htmlTag: 'h1' }),
      node('btn', 'button', { text: 'Go', link: { url: 'javascript:alert(1)' } }),
      node('img', 'image', { image: { url: 'http://localhost:8788/m/acme/01HX.png' }, alt: 'Pic' }),
      node('f', 'form', { formId: '01FORM' }),
      node('f2', 'form', { formId: '01FORM2' }),
      node('b', 'booking', { eventSlug: 'intro-call' }),
    ]),
  ]);

  it('renders the public page with native embeds, meta and tracker', () => {
    const out = renderBuilderPage(page, {
      tenantSlug: 'acme',
      pageId: '01PAGE',
      mediaBaseUrl: '/m/acme/',
      trackerSiteId: 'site_1',
      meta: { title: 'Acme', description: 'Desc', canonical: 'https://acme.test/x', ogImage: 'https://acme.test/og.png', lang: 'it' },
    });
    const { html } = out;
    expect(html).toContain('<html lang="it">');
    expect(html).toContain('<title>Acme</title>');
    expect(html).toContain('<link rel="canonical" href="https://acme.test/x"/>');
    expect(html).toContain('<meta property="og:image" content="https://acme.test/og.png"/>');
    expect(html).toContain('<meta name="amable-page-id" content="01PAGE"/>');
    expect(html).toContain('<div data-amable-form="01FORM" data-amable-tenant="acme" data-amable-page="01PAGE"></div>');
    expect(html).toContain('<div data-amable-booking="intro-call" data-amable-tenant="acme" data-amable-page="01PAGE"></div>');
    expect(html.match(/src="\/forms\.js"/g)).toHaveLength(1);
    expect(html.match(/src="\/booking\.js"/g)).toHaveLength(1);
    expect(html).toContain('<script defer data-site="site_1" src="/s.js"></script>');
    expect(html).toContain('src="/m/acme/01HX.png"');
    expect(html).toContain('Hello <strong>world</strong>&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('javascript:');
    expect(out.embeds.sort()).toEqual(['booking', 'forms']);
    expect(out.inlineScripts).toHaveLength(2);
    expect(out.hasRawHtml).toBe(false);
    const start = html.indexOf('<body>');
    const body = html.slice(start, html.indexOf('<script>', start));
    expect(body).toMatchSnapshot();
  });

  it('renders placeholders and no tracker in editor mode', () => {
    const { html, embeds } = renderBuilderPage(page, { mode: 'editor', tenantSlug: 'acme', trackerSiteId: 'site_1' });
    expect(html).toContain('data-b-embed-ph="form"');
    expect(html).toContain('data-b-embed-ph="booking"');
    expect(html).not.toContain('data-amable-form=');
    expect(html).not.toContain('/s.js');
    expect(embeds).toEqual([]);
  });

  it('keeps style content inside the <style> element', () => {
    const evil = doc([
      { ...node('x', 'heading'), styles: [{ breakpoint: 'desktop', state: 'normal', props: { color: 'red}</style><script>alert(1)</script>' } }] },
    ]);
    const { html } = renderBuilderPage(evil);
    expect(html).not.toContain('</style><script>alert(1)');
  });

  it('builds a hash-based CSP unless the page has author HTML', () => {
    const strict = renderBuilderPage(page, {});
    expect(builderPageCsp(strict, ['abc'])).toContain("script-src 'self' 'sha256-abc'");
    const raw = renderBuilderPage(doc([node('h', 'html', { html: '<b>x</b>' })]), {});
    expect(raw.hasRawHtml).toBe(true);
    expect(builderPageCsp(raw, [])).toContain("'unsafe-inline' https:");
    expect(builderPageCsp(strict, [])).not.toContain('stripe');
  });

  it('embeds checkouts and offer blocks with one script and the Stripe CSP', () => {
    const sales = doc([
      node('co', 'checkout', { checkoutId: '01CO' }),
      node('of', 'checkout-offer', { display: 'buttons', buttonColor: '#16a34a' }),
    ]);
    const out = renderBuilderPage(sales, { tenantSlug: 'acme', pageId: '01PAGE' });
    expect(out.html).toContain('<div data-amable-checkout="01CO" data-amable-tenant="acme" data-amable-page="01PAGE"></div>');
    expect(out.html).toContain('data-amable-offer');
    expect(out.html).toContain('data-amable-buttons-only');
    expect(out.html.match(/src="\/checkout\.js"/g)).toHaveLength(1);
    expect(out.embeds).toEqual(['checkout']);
    const csp = builderPageCsp(out, []);
    expect(csp).toContain('https://js.stripe.com');
    expect(csp).toContain('frame-src https://www.youtube.com');
    expect(csp).toContain('https://hooks.stripe.com');
    expect(csp).toContain("connect-src 'self' https://api.stripe.com");
    const editor = renderBuilderPage(sales, { mode: 'editor', tenantSlug: 'acme' });
    expect(editor.html).toContain('data-b-embed-ph="checkout"');
    expect(editor.embeds).toEqual([]);
  });
});

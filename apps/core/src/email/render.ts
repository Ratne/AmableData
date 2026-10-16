import { renderSandboxed } from '@amable/auth/security';
import { signEmailToken } from '@amable/core';
import {
  compileEmail,
  createRecipientRenderer,
  EmailTemplateError,
  type CompiledEmail,
  type RecipientRenderer,
  type TiptapDocument,
} from '@amable/email-render';
import type { MailSendContact } from '../crm/mail-reads';
import { chunked, MailError, type MailDeps, type TenantUser } from './context';
import { tenantTimeZone } from './settings';

/**
 * Rendering pipeline of a marketing email:
 * 1. compile the Tiptap document once per content version (cached in memory,
 *    and persisted on templates as the compiled HTML cache);
 * 2. build the recipient Liquid context (contact, owner, company, snippets,
 *    unsubscribe URL) and render with `@amable/email-render`;
 * 3. rewrite links for click tracking and append the open pixel.
 */

export interface CompiledContent {
  readonly key: string;
  readonly compiled: CompiledEmail;
  readonly renderer: RecipientRenderer;
  /** Snippet keys referenced as `snippets.<key>` (rendered per recipient). */
  readonly snippetKeys: readonly string[];
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SNIPPET_RE = /snippets\.([a-z][a-z0-9_]{0,62})/g;

function snippetKeysOf(compiled: CompiledEmail): string[] {
  const keys = new Set<string>();
  for (const source of [compiled.htmlTemplate, compiled.textTemplate, compiled.subjectTemplate]) {
    for (const match of source.matchAll(SNIPPET_RE)) if (match[1] !== undefined) keys.add(match[1]);
  }
  return [...keys];
}

export interface CompileInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly subject: string;
  readonly footerAddress: string | null;
  readonly lang?: string;
  /** Transactional email: no unsubscribe footer is added. */
  readonly transactional?: boolean;
  /** Default zone of the Liquid `date` filter: the tenant timezone. */
  readonly timezone: string;
}

export async function contentKey(input: Omit<CompileInput, 'timezone'>): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      input.body,
      input.subject,
      input.footerAddress ?? '',
      input.lang ?? 'en',
      ...(input.transactional === true ? ['transactional'] : []),
    ]),
  );
}

export function compileDocument(input: Omit<CompileInput, 'timezone'>): CompiledEmail {
  if (input.body['type'] !== 'doc') {
    throw new MailError('invalid_content', 422, 'email body must be a Tiptap document');
  }
  try {
    return compileEmail(input.body as unknown as TiptapDocument, {
      subject: input.subject,
      lang: input.lang ?? 'en',
      requireUnsubscribe: input.transactional !== true,
      ...(input.footerAddress === null ? {} : { footerAddress: input.footerAddress }),
    });
  } catch (error) {
    throw new MailError(
      'invalid_content',
      422,
      error instanceof Error ? error.message : 'invalid email content',
    );
  }
}

const cache = new Map<string, CompiledContent>();
const CACHE_LIMIT = 64;

/** Builds (or reuses) the per-recipient renderer of a compiled email, dates in `timezone` by default. */
export function rendererFor(key: string, compiled: CompiledEmail, timezone: string): CompiledContent {
  const cacheKey = `${timezone}|${key}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  let renderer: RecipientRenderer;
  try {
    renderer = createRecipientRenderer(compiled, { timezone });
  } catch (error) {
    throw new MailError(
      'invalid_content',
      422,
      error instanceof EmailTemplateError ? error.message : 'invalid Liquid in email',
    );
  }
  const entry: CompiledContent = { key, compiled, renderer, snippetKeys: snippetKeysOf(compiled) };
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, entry);
  return entry;
}

export async function compileContent(input: CompileInput): Promise<CompiledContent> {
  const key = await contentKey(input);
  const hit = cache.get(`${input.timezone}|${key}`);
  if (hit !== undefined) return hit;
  return rendererFor(key, compileDocument(input), input.timezone);
}

// ------------------------------------------------------------------ context

export function recipientContext(
  data: MailSendContact,
  owner: TenantUser | null,
): Record<string, unknown> {
  const c = data.contact;
  const address = c.addresses[0];
  const fullName = [c.given_name, c.family_name].filter((p) => p !== null && p !== '').join(' ');
  return {
    contact: {
      id: c.id,
      first_name: c.preferred_name ?? c.given_name ?? '',
      last_name: c.family_name ?? '',
      full_name: fullName,
      email: c.emails.find((e) => e.is_primary)?.email ?? c.emails[0]?.email ?? '',
      phone: c.phones[0]?.number ?? '',
      city: address?.locality ?? '',
      region: address?.region ?? '',
      country: address?.country_code ?? '',
      job_title: c.job_title ?? '',
      website: c.website ?? '',
      time_zone: c.time_zone ?? '',
      score: c.score_value,
      tags: data.tag_names,
      custom: c.custom_fields,
    },
    owner: owner === null ? {} : { name: owner.name ?? '', email: owner.email, signature: '' },
    company: data.company ?? {},
  };
}

/** Sample context for test sends without a contact. */
export function sampleContext(user: TenantUser): Record<string, unknown> {
  const [first = '', ...rest] = (user.name ?? '').split(' ');
  return {
    contact: {
      id: 'sample',
      first_name: first,
      last_name: rest.join(' '),
      full_name: user.name ?? '',
      email: user.email,
      tags: [],
      custom: {},
    },
    owner: { name: user.name ?? '', email: user.email, signature: '' },
    company: {},
  };
}

export const SNIPPET_RENDER_MS = 500;

/**
 * Renders snippet bodies for one recipient. The output is plain text: the
 * email's own `{{ snippets.<key> }}` tag escapes it once in the HTML part and
 * leaves it as-is in the text part. A snippet that fails renders empty.
 */
export async function renderSnippetBodies(
  rows: readonly { key: string; body: string }[],
  context: Record<string, unknown>,
  timezone: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      out[row.key] = (
        await renderSandboxed(row.body, context, { escapeHtml: false, renderLimitMs: SNIPPET_RENDER_MS, timezone })
      ).trim();
    } catch {
      out[row.key] = '';
    }
  }
  return out;
}

/** Renders the referenced Dynamic Content snippets (Liquid partials) for one recipient. */
export async function renderSnippets(
  deps: MailDeps,
  keys: readonly string[],
  context: Record<string, unknown>,
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const rows = chunked(keys).flatMap((chunk) =>
    deps.db.all<{ key: string; body: string }>(
      `SELECT key, body FROM mail_snippets WHERE key IN (${chunk.map(() => '?').join(', ')})`,
      ...chunk,
    ),
  );
  return renderSnippetBodies(rows, context, tenantTimeZone(deps));
}

// -------------------------------------------------------------- tracking

export interface TrackingTarget {
  readonly origin: string;
  readonly secret: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly contactId: string;
}

export interface TrackedLink {
  readonly position: number;
  readonly url: string;
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const HREF_RE = /href="(https?:\/\/[^"]+)"/gi;

/**
 * Rewrites every http(s) link of the HTML body to `<origin>/r/<signed token>`;
 * links already pointing at the tracking origin (unsubscribe) are left alone.
 * The destination travels inside the signed token, so the redirect can never
 * be abused as an open redirect.
 */
export async function rewriteLinks(
  html: string,
  target: TrackingTarget,
): Promise<{ html: string; links: TrackedLink[] }> {
  const origin = target.origin.replace(/\/+$/, '');
  const matches = [...html.matchAll(HREF_RE)];
  const links: TrackedLink[] = [];
  const replacements: string[] = [];
  for (const match of matches) {
    const url = decodeAttr(match[1] ?? '');
    if (url.startsWith(`${origin}/`)) {
      replacements.push(match[0]);
      continue;
    }
    const position = links.length;
    links.push({ position, url });
    const token = await signEmailToken(target.secret, {
      k: 'click',
      t: target.tenantId,
      m: target.messageId,
      c: target.contactId,
      l: position,
      u: url,
    });
    replacements.push(`href="${origin}/r/${token}"`);
  }
  let index = 0;
  const out = html.replace(HREF_RE, () => replacements[index++] ?? '');
  return { html: out, links };
}

export async function openPixelUrl(target: TrackingTarget): Promise<string> {
  const token = await signEmailToken(target.secret, {
    k: 'open',
    t: target.tenantId,
    m: target.messageId,
    c: target.contactId,
  });
  return `${target.origin.replace(/\/+$/, '')}/o/${token}`;
}

export function appendOpenPixel(html: string, pixelUrl: string): string {
  const img = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${img}</body>`) : html + img;
}

export async function unsubscribeUrl(
  origin: string,
  secret: string,
  input: { tenantId: string; messageId: string | null; contactId: string; email: string },
): Promise<string> {
  const token = await signEmailToken(secret, {
    k: 'unsubscribe',
    t: input.tenantId,
    m: input.messageId,
    c: input.contactId,
    e: input.email,
  });
  return `${origin.replace(/\/+$/, '')}/unsub/${token}`;
}

/** RFC 2369 + RFC 8058 one-click unsubscribe headers. */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

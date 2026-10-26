import { pageSeoSchema, pageSettingsSchema } from '@amable/api-types';
import { isHtmlDocument, type ElementNode, type PageDocument } from '@amable/builder';
import { strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { z } from 'zod';
import type { MediaRow } from './library';

/**
 * Landing page transfer between installations: one `.zip` with `page.json`
 * (the manifest, written last) and `media/<file>` (the library images the page
 * uses, stored uncompressed: they are already compressed formats).
 *
 * Forms, bookings and checkouts are not exported: their widgets keep the
 * source ids and must be relinked to resources of the destination.
 */

export const PAGE_EXPORT_FORMAT = 'amable-page';
export const PAGE_EXPORT_VERSION = 1;
export const PAGE_MANIFEST_NAME = 'page.json';
/** Media bytes per export; later files are listed in `media_skipped`. */
export const PAGE_EXPORT_MAX_MEDIA_BYTES = 50 * 1024 * 1024;
/** Import body cap: the media cap plus the manifest, so every export is importable. */
export const PAGE_IMPORT_MAX_BYTES = PAGE_EXPORT_MAX_MEDIA_BYTES + 5 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

/** Public file name of a library image (`<ulid>.<ext>`, see api.ts upload). */
const MEDIA_FILE_RE = /^[0-9A-Z]{26}\.(?:png|jpg|gif|webp|avif)$/;
/** An amable media URL, absolute or relative: `[https://host]/m/<slug>/<file>`. */
const MEDIA_URL_RE = /(?:https?:\/\/[A-Za-z0-9.-]+(?::\d+)?)?\/m\/[a-z0-9][a-z0-9-]*\/([0-9A-Z]{26}\.(?:png|jpg|gif|webp|avif))/g;

const mediaEntrySchema = z.object({
  file: z.string().regex(MEDIA_FILE_RE),
  filename: z.string().max(255),
  content_type: z.string().max(64),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PageExportMedia = z.infer<typeof mediaEntrySchema>;

export const pageManifestSchema = z.object({
  format: z.literal(PAGE_EXPORT_FORMAT),
  version: z.literal(PAGE_EXPORT_VERSION),
  exported_at: z.string().max(64),
  source: z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    edge_origin: z.string().url().max(300),
    page_id: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
  }),
  page: z.object({
    title: z.string().trim().min(1).max(200),
    path: z.string().max(300),
    document: z.record(z.string(), z.unknown()),
    seo: pageSeoSchema.default({}),
    settings: pageSettingsSchema.default({}),
  }),
  media: z.array(mediaEntrySchema).max(2000),
  media_skipped: z.array(z.string().max(255)).max(2000).default([]),
});
export type PageManifest = z.infer<typeof pageManifestSchema>;

// ------------------------------------------------------------- strings

/** Applies `fn` to every string value of a JSON tree (keys unchanged). */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, walk(child)]));
    }
    return v;
  };
  return walk(value) as T;
}

function eachString(value: unknown, fn: (s: string) => void): void {
  mapStrings(value, (s) => {
    fn(s);
    return s;
  });
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Distinct library file names referenced anywhere in the values (documents, SEO, settings). */
export function collectMediaFiles(values: unknown[]): string[] {
  const files = new Set<string>();
  for (const value of values) {
    eachString(value, (s) => {
      for (const match of s.matchAll(MEDIA_URL_RE)) files.add(match[1] as string);
    });
  }
  return [...files];
}

/** Points media URLs of known files at `<mediaBase><new file>`; unknown files stay as they are. */
export function rewriteMediaUrls(value: string, files: ReadonlyMap<string, string>, mediaBase: string): string {
  const base = mediaBase.endsWith('/') ? mediaBase : `${mediaBase}/`;
  return value.replace(MEDIA_URL_RE, (whole, file: string) => {
    const next = files.get(file);
    return next === undefined ? whole : `${base}${next}`;
  });
}

export interface RetargetInput {
  from: { edge: string; slug: string; pageId: string };
  to: { edge: string; slug: string; pageId: string };
  files: ReadonlyMap<string, string>;
}

/**
 * Moves a string from the source installation to the destination: media URLs,
 * embed script URLs, `/p/<slug>` fallback links and the tenant/page attributes
 * of hand-written embed snippets.
 */
export function retargetString(value: string, input: RetargetInput): string {
  const fromEdge = input.from.edge.replace(/\/+$/, '');
  const toEdge = input.to.edge.replace(/\/+$/, '');
  let out = rewriteMediaUrls(value, input.files, `${toEdge}/m/${input.to.slug}/`);
  const edge = escapeRegExp(fromEdge);
  out = out.replace(new RegExp(`${edge}/(forms|booking|checkout|s)\\.js`, 'g'), `${toEdge}/$1.js`);
  out = out.replace(
    new RegExp(`${edge}/p/${escapeRegExp(input.from.slug)}(?=[/?#"'\\s)]|$)`, 'g'),
    `${toEdge}/p/${input.to.slug}`,
  );
  out = out.replace(
    new RegExp(`data-amable-tenant=(["'])${escapeRegExp(input.from.slug)}\\1`, 'g'),
    `data-amable-tenant=$1${input.to.slug}$1`,
  );
  out = out.replace(
    new RegExp(`data-amable-page=(["'])${escapeRegExp(input.from.pageId)}\\1`, 'g'),
    `data-amable-page=$1${input.to.pageId}$1`,
  );
  return out;
}

// --------------------------------------------------------------- relink

export interface RelinkCounts {
  forms: number;
  bookings: number;
  checkouts: number;
}

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** Form / booking / checkout embeds of a document (widgets and hand-written snippets). */
export function countRelinkEmbeds(document: PageDocument): RelinkCounts {
  const counts: RelinkCounts = { forms: 0, bookings: 0, checkouts: 0 };
  const scan = (s: string) => {
    counts.forms += s.match(/data-amable-form=/g)?.length ?? 0;
    counts.bookings += s.match(/data-amable-booking=/g)?.length ?? 0;
    counts.checkouts += s.match(/data-amable-checkout=/g)?.length ?? 0;
  };
  if (isHtmlDocument(document)) {
    scan(document.html);
    return counts;
  }
  const walk = (nodes: ElementNode[]) => {
    for (const node of nodes) {
      if (node.type === 'form' && filled(node.settings.formId)) counts.forms += 1;
      if (node.type === 'booking' && filled(node.settings.eventSlug)) counts.bookings += 1;
      if (node.type === 'checkout' && filled(node.settings.checkoutId)) counts.checkouts += 1;
      eachString(node.settings, scan);
      walk(node.children);
    }
  };
  walk(document.body);
  return counts;
}

// --------------------------------------------------------------- export

export interface PageExportInput {
  bucket: R2Bucket;
  manifest: Omit<PageManifest, 'media' | 'media_skipped'>;
  media: MediaRow[];
  maxMediaBytes?: number;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The export zip as a stream: one R2 object in memory at a time; the manifest
 * goes last so it lists only the images actually written.
 */
export function streamPageExport(input: PageExportInput): ReadableStream<Uint8Array> {
  const maxBytes = input.maxMediaBytes ?? PAGE_EXPORT_MAX_MEDIA_BYTES;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const zip = new Zip((error, chunk, final) => {
        if (error !== null) {
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      const run = async () => {
        const media: PageExportMedia[] = [];
        const skipped: string[] = [];
        let total = 0;
        for (const row of input.media) {
          if (total + row.size > maxBytes) {
            skipped.push(row.filename);
            continue;
          }
          const object = await input.bucket.get(row.r2_key);
          if (object === null) {
            skipped.push(row.filename);
            continue;
          }
          const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
          total += bytes.byteLength;
          const entry = new ZipPassThrough(`media/${row.file}`);
          zip.add(entry);
          entry.push(bytes, true);
          media.push({
            file: row.file,
            filename: row.filename,
            content_type: row.content_type,
            size: bytes.byteLength,
            sha256: await sha256Hex(bytes),
          });
        }
        const manifest: PageManifest = { ...input.manifest, media, media_skipped: skipped };
        const entry = new ZipDeflate(PAGE_MANIFEST_NAME, { level: 6 });
        zip.add(entry);
        entry.push(strToU8(JSON.stringify(manifest, null, 2)), true);
        zip.end();
      };
      run().catch((error: unknown) => {
        zip.terminate();
        controller.error(error);
      });
    },
  });
}

// --------------------------------------------------------------- import

export class PageArchiveError extends Error {}

/** One entry of the archive, decompressed alone (the body stays the only big buffer). */
export function readArchiveEntry(archive: Uint8Array, name: string, maxBytes: number): Uint8Array | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive, { filter: (f) => f.name === name && f.originalSize <= maxBytes });
  } catch {
    throw new PageArchiveError('not a valid zip archive');
  }
  return files[name] ?? null;
}

/** The validated manifest of an export archive. */
export function readPageManifest(archive: Uint8Array): PageManifest {
  const bytes = readArchiveEntry(archive, PAGE_MANIFEST_NAME, MANIFEST_MAX_BYTES);
  if (bytes === null) throw new PageArchiveError(`${PAGE_MANIFEST_NAME} missing: not a landing page export`);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PageArchiveError(`${PAGE_MANIFEST_NAME} is not valid JSON`);
  }
  const parsed = pageManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PageArchiveError(
      `${PAGE_MANIFEST_NAME}: ${issue === undefined ? 'invalid' : `${issue.path.join('.')} ${issue.message}`}`,
    );
  }
  return parsed.data;
}

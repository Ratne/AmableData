import { CrmError } from './errors';

export function toIso(ms: number): string;
export function toIso(ms: number | null): string | null;
export function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Parses an ISO 8601 date-time (already Zod-validated) into epoch ms. */
export function parseIsoMs(value: string, path = 'value'): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new CrmError('validation_failed', `${path}: invalid date-time`);
  return ms;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function bool(value: number | null | undefined): boolean {
  return value === 1;
}

/** Trims and turns empty strings into null. */
export function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// ------------------------------------------------------------------ cursors

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Opaque keyset cursor: the sort value and id of the last row of a page. */
export interface Cursor {
  v: string | number | null;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

export function decodeCursor(text: string): Cursor {
  try {
    const parsed = JSON.parse(fromBase64Url(text)) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof parsed.id === 'string' &&
      'v' in parsed &&
      (typeof parsed.v === 'string' || typeof parsed.v === 'number' || parsed.v === null)
    ) {
      return { v: parsed.v, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw new CrmError('bad_request', 'invalid cursor');
}

/** Splits `limit + 1` fetched rows into a page and its next cursor. */
export function paginate<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => Cursor,
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: last === undefined ? null : encodeCursor(cursorOf(last)) };
}

/** Lowercase + strip diacritics; used by search documents and fallbacks. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** Extracts the plain text of a Tiptap JSON document. */
export function richTextToPlain(doc: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if ('text' in node && typeof node.text === 'string') parts.push(node.text);
    if ('content' in node && Array.isArray(node.content)) {
      const blockish = 'type' in node && node.type !== 'text';
      for (const child of node.content) walk(child);
      if (blockish) parts.push('\n');
    }
  };
  walk(doc);
  return parts
    .join('')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export const MAX_RICH_TEXT_BYTES = 256 * 1024;

export function serializeRichText(doc: unknown, path: string): string {
  const json = JSON.stringify(doc);
  if (new TextEncoder().encode(json).length > MAX_RICH_TEXT_BYTES) {
    throw new CrmError('payload_too_large', `${path}: document exceeds 256 KB`);
  }
  return json;
}

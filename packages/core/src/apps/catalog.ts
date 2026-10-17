import { z } from 'zod';
import { appManifestSchema, type AppManifest } from './manifest';

/**
 * Signed catalog index, built by the catalog repo (`Ratne/amable-apps`) and
 * published as a release asset. Installations download it, verify the Ed25519
 * signature against a pinned public key and only then trust its content.
 *
 * Envelope: `{ format: 1, key_id, payload, signature }` where `payload` is the
 * exact JSON text of the index and `signature` is Ed25519(payload) in base64url.
 */

export const CATALOG_INDEX_FORMAT = 1;
export const DEFAULT_CATALOG_URL =
  'https://github.com/Ratne/amable-apps/releases/latest/download/index.signed.json';

/** Pinned catalog signing keys (raw Ed25519 public key, base64), by key id. */
export const CATALOG_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  '2026-10': 'SktT3wW81sTnU+lDvhffndRVxnhLtoyZjKHKa3goJLo=',
};

export const catalogEntrySchema = z.object({
  manifest: appManifestSchema,
  /** Reviewed and merged in the catalog repo. */
  verified: z.boolean().default(true),
  /** Kill switch: installations disable every install of a revoked app. */
  revoked: z.boolean().default(false),
  revoked_reason: z.string().max(500).optional(),
  added_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogIndexSchema = z.object({
  format: z.literal(CATALOG_INDEX_FORMAT),
  generated_at: z.string(),
  apps: z.array(catalogEntrySchema).max(5000),
});
export type CatalogIndex = z.infer<typeof catalogIndexSchema>;

export const signedCatalogSchema = z.object({
  format: z.literal(CATALOG_INDEX_FORMAT),
  key_id: z.string().min(1).max(40),
  payload: z.string().min(2).max(20_000_000),
  signature: z.string().min(40).max(200),
});
export type SignedCatalog = z.infer<typeof signedCatalogSchema>;

const encoder = new TextEncoder();

function fromB64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toB64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  return fromB64Url(value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

export type CatalogVerification =
  | { ok: true; index: CatalogIndex; invalid: Array<{ id: string; issues: string[] }> }
  | { ok: false; reason: 'malformed' | 'unknown_key' | 'bad_signature' | 'invalid_index' };

/**
 * Verifies the envelope and parses the index. Entries whose manifest does not
 * validate against THIS release's schema are skipped (reported in `invalid`)
 * instead of rejecting the whole catalog: newer catalogs may use fields an
 * older installation does not know.
 */
export async function verifySignedCatalog(
  raw: unknown,
  keys: Readonly<Record<string, string>> = CATALOG_PUBLIC_KEYS,
): Promise<CatalogVerification> {
  const envelope = signedCatalogSchema.safeParse(raw);
  if (!envelope.success) return { ok: false, reason: 'malformed' };
  const publicKey = keys[envelope.data.key_id];
  if (publicKey === undefined) return { ok: false, reason: 'unknown_key' };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('raw', fromB64(publicKey), { name: 'Ed25519' }, false, ['verify']);
    valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      fromB64Url(envelope.data.signature),
      encoder.encode(envelope.data.payload),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope.data.payload);
  } catch {
    return { ok: false, reason: 'invalid_index' };
  }
  const head = z
    .object({ format: z.literal(CATALOG_INDEX_FORMAT), generated_at: z.string(), apps: z.array(z.unknown()).max(5000) })
    .safeParse(parsed);
  if (!head.success) return { ok: false, reason: 'invalid_index' };
  const apps: CatalogEntry[] = [];
  const invalid: Array<{ id: string; issues: string[] }> = [];
  for (const candidate of head.data.apps) {
    const entry = catalogEntrySchema.safeParse(candidate);
    if (entry.success) {
      apps.push(entry.data);
      continue;
    }
    const id =
      typeof candidate === 'object' && candidate !== null
        ? String((candidate as { manifest?: { id?: unknown } }).manifest?.id ?? '?')
        : '?';
    invalid.push({ id, issues: entry.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
  }
  return { ok: true, index: { format: head.data.format, generated_at: head.data.generated_at, apps }, invalid };
}

/** Signs an index (catalog tooling and tests). `privateKey` is PKCS#8 base64. */
export async function signCatalogIndex(
  index: { format: number; generated_at: string; apps: unknown[] },
  privateKey: string,
  keyId: string,
): Promise<SignedCatalog> {
  const payload = JSON.stringify(index);
  const key = await crypto.subtle.importKey('pkcs8', fromB64(privateKey), { name: 'Ed25519' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, encoder.encode(payload)));
  return { format: CATALOG_INDEX_FORMAT, key_id: keyId, payload, signature: toB64Url(signature) };
}

/** Stable hash of a manifest (detects catalog updates). */
export async function manifestHash(manifest: AppManifest | unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(stableStringify(manifest))));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

import { generateAppKey, jwksOf, type PrivateJwk } from '@amable/app-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * `.amable/keys.json` (gitignored) holds the app's private signing keys, the
 * active one first. Rotation keeps the previous key published so tokens
 * signed with it keep verifying until it is pruned.
 */

export const KEYS_FILE = join('.amable', 'keys.json');

export interface KeyFile {
  readonly keys: PrivateJwk[];
}

export function readKeys(dir: string): KeyFile {
  const path = join(dir, KEYS_FILE);
  if (!existsSync(path)) return { keys: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
}

export function writeKeys(dir: string, file: KeyFile): void {
  const path = join(dir, KEYS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

/** Value of the `APP_KEYS` secret (JSON array, active key first). */
export function secretValue(file: KeyFile): string {
  return JSON.stringify(file.keys);
}

export async function generateKeys(dir: string): Promise<KeyFile> {
  const existing = readKeys(dir);
  if (existing.keys.length > 0) return existing;
  const file = { keys: [await generateAppKey(kidFor(0))] };
  writeKeys(dir, file);
  return file;
}

function kidFor(index: number): string {
  return `k-${new Date().toISOString().slice(0, 10)}-${String(index + 1)}`;
}

/** New active key; the previous active key stays published (at most two keys). */
export async function rotateKeys(dir: string): Promise<KeyFile> {
  const current = readKeys(dir);
  const next = await generateAppKey(kidFor(current.keys.length));
  const file = { keys: [next, ...current.keys.slice(0, 1)] };
  writeKeys(dir, file);
  return file;
}

/** Drops every key but the active one (run a day after a rotation). */
export function pruneKeys(dir: string): KeyFile {
  const current = readKeys(dir);
  const file = { keys: current.keys.slice(0, 1) };
  writeKeys(dir, file);
  return file;
}

export function publicJwks(file: KeyFile) {
  return jwksOf(file.keys);
}

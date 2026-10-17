import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeys, secretValue } from './keys';

/** `create-amable-app <dir>`: copies the Worker template, fills in the app id and creates its signing key. */

const APP_ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
const TEXT = /\.(ts|tsx|js|mjs|json|jsonc|md|html|css|toml|txt)$|^_gitignore$|^\.dev\.vars\.example$/;

export function templateDir(): string {
  // dist/cli.mjs → ../template; src/create.ts (tests) → ../template.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'template');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export interface CreateOptions {
  readonly dir: string;
  readonly appId?: string;
  readonly name?: string;
  readonly baseUrl?: string;
}

export async function createApp(options: CreateOptions): Promise<{ dir: string; appId: string; secret: string }> {
  const dir = resolve(options.dir);
  const appId = options.appId ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!APP_ID_RE.test(appId)) throw new Error(`invalid app id "${appId}": 3-40 lowercase letters, digits and dashes, starting with a letter`);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`);
  cpSync(templateDir(), dir, { recursive: true });
  const name = options.name ?? appId.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => `${dash === '' ? '' : ' '}${c.toUpperCase()}`);
  const baseUrl = options.baseUrl ?? `https://${appId}.example.workers.dev`;
  for (const file of walk(dir)) {
    if (!TEXT.test(basename(file))) continue;
    const content = readFileSync(file, 'utf8');
    const next = content.replaceAll('__APP_ID__', appId).replaceAll('__APP_NAME__', name).replaceAll('__BASE_URL__', baseUrl);
    if (next !== content) writeFileSync(file, next);
  }
  renameSync(join(dir, '_gitignore'), join(dir, '.gitignore'));
  const keys = await generateKeys(dir);
  const secret = secretValue(keys);
  writeFileSync(join(dir, '.dev.vars'), `APP_KEYS='${secret}'\n`, { mode: 0o600 });
  return { dir, appId, secret };
}

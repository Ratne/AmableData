/**
 * Builds the screens of every hosted app and copies each app's public files
 * to public/<app id>/, where the host serves them as static assets.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = join(dirname(fileURLToPath(import.meta.url)), '..');
const apps = JSON.parse(readFileSync(join(host, 'apps.json'), 'utf8'));
const out = join(host, 'public');
rmSync(out, { recursive: true, force: true });

for (const id of apps) {
  const dir = join(host, '..', id);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.scripts?.['build:screens'] !== undefined) {
    execFileSync('pnpm', ['run', 'build:screens'], { cwd: dir, stdio: 'inherit' });
  }
  const files = join(dir, 'public');
  mkdirSync(join(out, id), { recursive: true });
  if (!existsSync(files)) continue;
  for (const name of readdirSync(files)) {
    if (name.startsWith('.')) continue;
    cpSync(join(files, name), join(out, id, name), { recursive: true });
  }
}
console.log(`public/: ${apps.join(', ')}`);

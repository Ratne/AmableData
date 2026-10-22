#!/usr/bin/env node
/**
 * Releases an official Marketplace app: builds its single-module bundle,
 * computes the SHA-256 and writes the catalog copy of the manifest (source
 * manifest + `deployment.bundle_url` / `bundle_sha256`) and its icon into a
 * checkout of the catalog repo (amable-apps). With `--publish` the bundle is
 * attached to the GitHub release `app-<id>-v<version>` of this repository.
 *
 * The bundle is deployed by each CRM into the workspace's OWN Cloudflare
 * account: nothing is ever deployed to the maintainer's account.
 *
 *   node scripts/release-app.mjs <id> [--catalog ../amable-apps] [--publish]
 *
 * A published version is immutable: changing the code needs a new `version`
 * in the app's manifest.json.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleApp } from './bundle-app.mjs';

const REPO = 'Ratne/AmableData';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const publish = args.includes('--publish');
const catalog = resolve(flag('--catalog') ?? join(root, '..', 'amable-apps'));

if (id === undefined) {
  console.error('usage: node scripts/release-app.mjs <id> [--catalog ../amable-apps] [--publish]');
  process.exit(1);
}
const dir = join(root, 'examples', 'apps', id);
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
if (manifest.deployment?.kind !== 'cloudflare_worker') {
  console.error(`${id}: manifest.json has no "deployment" block (apps hosted by their developer are not released here)`);
  process.exit(1);
}

execFileSync('pnpm', ['run', '--if-present', 'build:screens'], { cwd: dir, stdio: 'inherit' });
const { bundle, sha256, bytes } = await bundleApp(dir);
const tag = `app-${id}-v${manifest.version}`;
const bundleUrl = `https://github.com/${REPO}/releases/download/${tag}/worker.mjs`;

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const released = (() => {
  try {
    return JSON.parse(gh('release', 'view', tag, '--repo', REPO, '--json', 'assets')).assets.some((a) => a.name === 'worker.mjs');
  } catch {
    return false;
  }
})();

if (released) {
  const published = execFileSync('curl', ['-fsSL', bundleUrl]);
  const { createHash } = await import('node:crypto');
  const publishedSha = createHash('sha256').update(published).digest('hex');
  if (publishedSha !== sha256) {
    console.error(`${tag} is already published with another bundle (${publishedSha}): bump "version" in examples/apps/${id}/manifest.json`);
    process.exit(1);
  }
  console.log(`${tag} already published with this bundle`);
} else if (publish) {
  gh('release', 'create', tag, bundle, '--repo', REPO, '--title', `${manifest.name} ${manifest.version}`,
    '--notes', `Bundle of the ${manifest.name} Marketplace app, deployed by each CRM into the workspace's own Cloudflare account.\n\nsha256: ${sha256}`,
    '--latest=false');
  console.log(`published ${tag}`);
} else {
  console.log(`not published yet: run again with --publish to create the release ${tag}`);
}

/** JSON.stringify with arrays of primitives on one line, as the catalog manifests are written. */
function formatJson(value, indent = '') {
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) return JSON.stringify(value).replace(/,/g, ', ');
    return `[\n${value.map((v) => next + formatJson(v, next)).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${formatJson(v, next)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

const deployment = { ...manifest.deployment, bundle_url: bundleUrl, bundle_sha256: sha256 };
if (existsSync(catalog)) {
  const target = join(catalog, 'apps', id);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'manifest.json'), `${formatJson({ ...manifest, deployment })}\n`);
  if (existsSync(join(dir, 'public', 'icon.png'))) copyFileSync(join(dir, 'public', 'icon.png'), join(target, 'icon.png'));
  console.log(`catalog manifest written to ${relative(process.cwd(), target)}`);
} else {
  console.log(`catalog checkout not found at ${catalog}: paste this block into apps/${id}/manifest.json`);
}
console.log(`${relative(process.cwd(), bundle)}  ${bytes} bytes`);
console.log(JSON.stringify({ deployment }, null, 2));

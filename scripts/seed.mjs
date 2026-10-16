#!/usr/bin/env node
/**
 * Local seed: creates the installation row, a placeholder admin user, the "demo"
 * tenant and placeholder rows inside its TenantDb Durable Object, by calling the
 * dev-only POST /api/dev/seed route of apps/core.
 *
 * If no wrangler dev is listening on 8787 it boots one, seeds the persisted local
 * state (.wrangler/state) and shuts it down again.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = process.env.SEED_BASE_URL ?? 'http://localhost:8787';

async function isUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function ensureWebDistExists() {
  // wrangler requires the assets directory to exist; a placeholder is enough for seeding.
  const dist = path.join(repoRoot, 'apps/web/dist');
  if (!existsSync(dist)) {
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      path.join(dist, 'index.html'),
      '<!doctype html><title>amabledata</title><p>Run `pnpm build:web` for the real SPA.</p>',
    );
  }
}

function startCoreDev() {
  ensureWebDistExists();
  console.log('No dev server on 8787 — booting wrangler dev for apps/core…');
  const child = spawn('pnpm', ['--filter', '@amable/app-core', 'run', 'dev'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
  return child;
}

function stop(child) {
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

async function waitUntilUp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

let child = null;
try {
  if (!(await isUp())) {
    child = startCoreDev();
    if (!(await waitUntilUp(90_000))) {
      throw new Error('wrangler dev did not become healthy within 90s');
    }
  }

  const response = await fetch(`${BASE_URL}/api/dev/seed`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`seed failed with ${response.status} — is ENVIRONMENT=dev set for apps/core?`);
  }
  const result = await response.json();
  console.log('Seed completed:');
  console.log(JSON.stringify(result, null, 2));

  // CRM demo data (~200 contacts, companies, tags, custom fields, a pipeline); idempotent.
  const crm = await fetch(`${BASE_URL}/api/dev/seed-crm?tenant=demo`, { method: 'POST' });
  if (!crm.ok) {
    throw new Error(`CRM seed failed with ${crm.status}: ${await crm.text()}`);
  }
  console.log('CRM seed:');
  console.log(JSON.stringify(await crm.json(), null, 2));

  // Two published demo automations in the Engine DO; idempotent.
  const automations = await fetch(`${BASE_URL}/api/dev/seed-automations?tenant=demo`, {
    method: 'POST',
  });
  if (!automations.ok) {
    throw new Error(`automation seed failed with ${automations.status}: ${await automations.text()}`);
  }
  console.log('Automation seed:');
  console.log(JSON.stringify(await automations.json(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  stop(child);
}

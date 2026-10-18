#!/usr/bin/env node
/**
 * Self-hosted installation on your own Cloudflare account (no control plane).
 *
 *   node scripts/self-host-setup.mjs --app-origin https://crm.example.com [options]
 *
 * 1. checks `wrangler whoami`;
 * 2. creates (or finds) the D1 database, the R2 bucket and the queues;
 * 3. renders deploy/self-host/*.wrangler.jsonc into apps/{core,edge}/wrangler.self-host.jsonc
 *    with the real ids (ENVIRONMENT=production);
 * 4. with --deploy: builds and deploys edge (bootstrap), core, then edge again
 *    with its service binding to core, and sets the secrets that are not set yet
 *    (PASSWORD_PEPPER, AUTH_ENCRYPTION_KEY, EMAIL_TOKEN_SECRET, EDGE_GATEWAY_SECRET)
 *    to fresh random values — existing secrets are never overwritten (a new
 *    pepper would lock every user out), except EDGE_GATEWAY_SECRET when only one
 *    of the two workers has it (e.g. core deployed with the button): both get a
 *    new shared value, since Cloudflare never reveals the existing one;
 * 5. with --owner-email: once the app answered /api/health (migrations applied),
 *    creates the first workspace and an owner invitation in D1 and prints the
 *    invitation link (account creation + mandatory 2FA happen in the browser).
 *    Rerunning it before anyone signed up replaces the link (the old one stops
 *    working); refused once the installation has users.
 *
 * Options:
 *   --app-origin <url>    public origin of the app (default: the workers.dev URL you pass later)
 *   --edge-origin <url>   public origin of the edge worker (tracking subdomain)
 *   --core-origin <url>   origin the edge reaches the core on before the service binding exists
 *   --deploy              build and deploy after provisioning
 *   --owner-email <email> first owner (invitation link printed at the end)
 *   --workspace <name>    first workspace name (default "My workspace"), slug from it
 *   --dry-run             print every wrangler command instead of running it (no network)
 *
 * Migrations run automatically when the workers boot; updating later is
 * `git pull && node scripts/self-host-setup.mjs --deploy` (idempotent).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const D1_NAME = 'amable-installation';
export const R2_BUCKET = 'amable-files';
export const QUEUES = ['email-send', 'events-rollup', 'webhooks-out', 'form-submissions', 'analytics'];
export const SECRETS = {
  core: ['PASSWORD_PEPPER', 'AUTH_ENCRYPTION_KEY', 'EMAIL_TOKEN_SECRET', 'EDGE_GATEWAY_SECRET'],
  edge: ['EDGE_GATEWAY_SECRET'],
};
const CORE_CONFIG = 'apps/core/wrangler.self-host.jsonc';
const EDGE_CONFIG = 'apps/edge/wrangler.self-host.jsonc';
const EDGE_BOOTSTRAP_CONFIG = 'apps/edge/wrangler.self-host.bootstrap.jsonc';

export function parseArgs(argv) {
  const options = {
    appOrigin: null,
    edgeOrigin: null,
    coreOrigin: null,
    deploy: false,
    dryRun: false,
    ownerEmail: null,
    workspace: 'My workspace',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    const origin = () => value().replace(/\/$/, '');
    if (arg === '--app-origin') options.appOrigin = origin();
    else if (arg === '--edge-origin') options.edgeOrigin = origin();
    else if (arg === '--core-origin') options.coreOrigin = origin();
    else if (arg === '--owner-email') options.ownerEmail = value().trim().toLowerCase();
    else if (arg === '--workspace') options.workspace = value().trim();
    else if (arg === '--deploy') options.deploy = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown option ${arg}`);
  }
  for (const [name, origin] of Object.entries({ appOrigin: options.appOrigin, edgeOrigin: options.edgeOrigin, coreOrigin: options.coreOrigin })) {
    if (origin !== null && !/^https:\/\/[^\s/]+$/.test(origin)) throw new Error(`${name} must be an https origin without a path`);
  }
  if (options.ownerEmail !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(options.ownerEmail)) {
    throw new Error('--owner-email must be an email address');
  }
  if (options.ownerEmail !== null && options.appOrigin === null) throw new Error('--owner-email needs --app-origin');
  if (options.workspace === '' || options.workspace.length > 120) throw new Error('--workspace must be 1-120 characters');
  return options;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID (time-sortable id, same format as the app's ids). */
export function ulid(now = Date.now(), random = randomBytes(16)) {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i += 1) rand += CROCKFORD[random[i] % 32];
  return time + rand;
}

export function slugify(name) {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : 'workspace';
}

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * First workspace + owner invitation (the app's own invite flow then creates the
 * account with a verified email and mandatory 2FA). Both inserts only happen on an
 * installation without users, so rerunning the script can never add an owner later.
 */
export function bootstrapOwnerSql({ tenantId, slug, name, inviteId, email, tokenHash, now, expiresAt }) {
  const noUsers = `NOT EXISTS (SELECT 1 FROM users)`;
  const firstTenant = `(SELECT id FROM tenants ORDER BY created_at, id LIMIT 1)`;
  return [
    `INSERT INTO tenants (id, slug, name, created_at) SELECT ${sqlString(tenantId)}, ${sqlString(slug)}, ${sqlString(name)}, ${now} WHERE ${noUsers} AND NOT EXISTS (SELECT 1 FROM tenants);`,
    // A rerun before anyone signed up (link lost or expired) replaces the bootstrap invitation.
    `DELETE FROM invites WHERE role = 'owner' AND invited_by IS NULL AND ${noUsers};`,
    `INSERT INTO invites (id, tenant_id, email, role, token_hash, invited_by, locale, created_at, expires_at) ` +
      `SELECT ${sqlString(inviteId)}, ${firstTenant}, ${sqlString(email)}, 'owner', ${sqlString(tokenHash)}, NULL, 'en', ${now}, ${expiresAt} ` +
      `WHERE ${noUsers} AND EXISTS (SELECT 1 FROM tenants);`,
  ].join('\n');
}

/** First UUID following a `database_id` / `uuid` key in wrangler output (JSON, TOML or table). */
export function parseD1Id(output) {
  const match = /(?:database_id|uuid)["'\s:=]+["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(output);
  return match?.[1] ?? null;
}

/** D1 id of `name` in `wrangler d1 list --json` output. */
export function findD1Id(listJson, name) {
  try {
    const list = JSON.parse(listJson);
    const found = Array.isArray(list) ? list.find((db) => db?.name === name) : undefined;
    return typeof found?.uuid === 'string' ? found.uuid : null;
  } catch {
    return null;
  }
}

export function renderTemplate(template, values) {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split(`__${key}__`).join(value);
  const left = /__[A-Z0-9_]+__/.exec(out);
  if (left !== null) throw new Error(`unrendered placeholder ${left[0]}`);
  return out;
}

/** Edge config without the core service binding (first deploy, before amable-core exists). */
export function withoutCoreService(config) {
  const lines = config.split('\n');
  const marker = lines.findIndex((line) => line.includes('@core-service'));
  if (marker === -1) return config;
  return [...lines.slice(0, marker), ...lines.slice(marker + 2)].join('\n');
}

export function secretNamesFromList(output) {
  try {
    const list = JSON.parse(output);
    return new Set(Array.isArray(list) ? list.map((s) => s?.name).filter((n) => typeof n === 'string') : []);
  } catch {
    return new Set();
  }
}

function createRunner(dryRun) {
  return (args, { input, allowFailure = false } = {}) => {
    const printable = `wrangler ${args.join(' ')}`;
    if (dryRun) {
      console.log(`[dry-run] ${printable}${input === undefined ? '' : ' <secret on stdin>'}`);
      return { ok: true, stdout: '', stderr: '' };
    }
    console.log(`$ ${printable}`);
    const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
      cwd: root,
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'],
    });
    const ok = result.status === 0;
    if (!ok && !allowFailure) {
      process.stderr.write(result.stderr ?? '');
      throw new Error(`${printable} failed`);
    }
    return { ok, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

function provision(wrangler, dryRun) {
  let d1Id = null;
  const created = wrangler(['d1', 'create', D1_NAME], { allowFailure: true });
  d1Id = parseD1Id(created.stdout);
  if (d1Id === null) d1Id = findD1Id(wrangler(['d1', 'list', '--json']).stdout, D1_NAME);
  if (d1Id === null) {
    if (!dryRun) throw new Error(`could not create or find the D1 database ${D1_NAME}`);
    d1Id = '00000000-0000-0000-0000-000000000000';
  }
  wrangler(['r2', 'bucket', 'create', R2_BUCKET], { allowFailure: true });
  for (const queue of QUEUES) wrangler(['queues', 'create', queue], { allowFailure: true });
  return d1Id;
}

/**
 * Secrets to write per worker, given the names already set on each. A secret
 * both workers need must hold the same value on both: when only one has it,
 * both are rewritten with a new value.
 */
export function secretPlan(existing) {
  const plan = { core: [], edge: [] };
  for (const worker of ['core', 'edge']) {
    for (const name of SECRETS[worker]) {
      const sharedWith = worker === 'core' ? 'edge' : 'core';
      const shared = SECRETS[sharedWith].includes(name);
      const missing = !existing[worker].has(name);
      if (missing || (shared && !existing[sharedWith].has(name))) plan[worker].push(name);
    }
  }
  return plan;
}

function setSecrets(wrangler) {
  const list = (config) =>
    secretNamesFromList(wrangler(['secret', 'list', '--format', 'json', '--config', config], { allowFailure: true }).stdout);
  const existing = { core: list(CORE_CONFIG), edge: list(EDGE_CONFIG) };
  const plan = secretPlan(existing);
  const values = {};
  for (const [worker, config] of [['core', CORE_CONFIG], ['edge', EDGE_CONFIG]]) {
    for (const name of SECRETS[worker]) {
      if (!plan[worker].includes(name)) {
        console.log(`  ${worker} ${name}: already set, kept`);
        continue;
      }
      if (existing[worker].has(name)) console.log(`  ${worker} ${name}: missing on the other worker, both rotated`);
      values[name] ??= randomBytes(32).toString('base64');
      wrangler(['secret', 'put', name, '--config', config], { input: values[name] });
    }
  }
}

/** `git describe` output → APP_VERSION (`2026.10.1`, or `2026.10.1-3-gabc1234` between releases). */
export function releaseVersion(describe) {
  const value = describe.trim();
  return /^\d+\.\d+\.\d+(-\d+-g[0-9a-f]+)?$/.test(value) ? value : null;
}

/** Version of the checkout; null outside git or before the first release tag (no update check). */
function checkoutVersion() {
  const result = spawnSync('git', ['describe', '--tags', '--match', '[0-9]*.[0-9]*.[0-9]*'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? releaseVersion(result.stdout ?? '') : null;
}

function run(command, args, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] ${command} ${args.join(' ')}`);
    return;
  }
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const wrangler = createRunner(options.dryRun);
  if (!wrangler(['whoami'], { allowFailure: true }).ok) {
    throw new Error('not logged in: run `pnpm exec wrangler login` first');
  }

  console.log('\n1/4 Provisioning D1, R2 and queues');
  const d1Id = provision(wrangler, options.dryRun);

  console.log('\n2/4 Writing production wrangler configs');
  const appOrigin = options.appOrigin ?? 'https://amable-core.example.workers.dev';
  const edgeOrigin = options.edgeOrigin ?? 'https://amable-edge.example.workers.dev';
  const core = renderTemplate(readFileSync(join(root, 'deploy/self-host/core.wrangler.jsonc'), 'utf8'), {
    D1_DATABASE_ID: d1Id,
    APP_ORIGIN: appOrigin,
    EDGE_ORIGIN: edgeOrigin,
  });
  const edge = renderTemplate(readFileSync(join(root, 'deploy/self-host/edge.wrangler.jsonc'), 'utf8'), {
    CORE_ORIGIN: options.coreOrigin ?? appOrigin,
  });
  if (options.dryRun) {
    console.log(`[dry-run] would write ${CORE_CONFIG}, ${EDGE_CONFIG} and ${EDGE_BOOTSTRAP_CONFIG}`);
  } else {
    writeFileSync(join(root, CORE_CONFIG), core);
    writeFileSync(join(root, EDGE_CONFIG), edge);
    writeFileSync(join(root, EDGE_BOOTSTRAP_CONFIG), withoutCoreService(edge));
    console.log(`  ${CORE_CONFIG}\n  ${EDGE_CONFIG}`);
  }
  if (options.appOrigin === null) {
    console.log('  (no --app-origin: placeholder origins written — rerun with your real URLs before going live)');
  }

  if (!options.deploy) {
    console.log('\n3/4 Skipped deploy and secrets. Next: node scripts/self-host-setup.mjs --deploy (same options)');
    return;
  }
  console.log('\n3/4 Build, deploy and secrets');
  const version = checkoutVersion();
  console.log(`  version: ${version ?? 'unknown (no release tag: the "new version available" notice stays off)'}`);
  const versionVar = version === null ? [] : ['--var', `APP_VERSION:${version}`];
  run('pnpm', ['run', 'build:web'], options.dryRun);
  wrangler(['deploy', '--config', EDGE_BOOTSTRAP_CONFIG, ...versionVar]);
  wrangler(['deploy', '--config', CORE_CONFIG, ...versionVar]);
  wrangler(['deploy', '--config', EDGE_CONFIG, ...versionVar]);
  setSecrets(wrangler);

  if (options.ownerEmail === null) {
    console.log('\n4/4 No --owner-email: rerun with --owner-email you@example.com to create the first owner.');
    return;
  }
  console.log('\n4/4 First owner');
  await waitForHealth(appOrigin, options.dryRun);
  const now = Date.now();
  const token = randomBytes(32).toString('base64url');
  const sql = bootstrapOwnerSql({
    tenantId: ulid(now),
    slug: slugify(options.workspace),
    name: options.workspace,
    inviteId: ulid(now),
    email: options.ownerEmail,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    now,
    expiresAt: now + 7 * 86_400_000,
  });
  wrangler(['d1', 'execute', D1_NAME, '--remote', '--config', CORE_CONFIG, '--command', sql]);
  console.log(`\nDone. Open this link within 7 days to create the owner account (shown once):\n  ${appOrigin}/invite#token=${token}`);
  console.log('Any earlier first-owner link stops working. If the installation already had users, nothing was created and this link does not work.');
}

/** The first request applies the installation migrations (tables must exist before the bootstrap). */
async function waitForHealth(appOrigin, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] GET ${appOrigin}/api/health`);
    return;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const res = await fetch(`${appOrigin}/api/health`);
      if (res.ok) return;
    } catch {
      // not reachable yet (fresh workers.dev hostnames take a few seconds)
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`${appOrigin}/api/health did not answer: check the deploy, then rerun with --owner-email`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`self-host-setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

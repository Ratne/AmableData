import type { HealthResponse } from '@amable/api-types';
import { ConsoleSystemEmailProvider } from '@amable/core';
import { installationSchema } from '@amable/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { seedDevCredentials } from './auth/dev-seed';
import { accountRoutes } from './auth/routes/account';
import { publicAuthRoutes } from './auth/routes/public';
import { tenantAdminRoutes } from './auth/routes/tenant-admin';
import { backupRoutes } from './backup/routes';
import {
  apiCors,
  apiSecurityHeaders,
  authServices,
  csrfProtection,
  handleError,
  optionalAuth,
  requireAuth,
  requireTenant,
  type AppEnv,
} from './middleware';
import { mountAutomationApi } from './automation/api/routes';
import { analyticsKick, mountAnalyticsApi } from './analytics/routes';
import { mountCrmApi } from './crm/api/router';
import { mountPublishingApi } from './public/mount';
import { mountEmailApi } from './email/mount';
import { mountReportsApi } from './reports/routes';
import { mountDevelopersApi } from './developers/mount';
import { ensureInstallationMigrated } from './migrate';
import { mountPlatformApi } from './platform/mount';

const { auditLog, installationMeta, memberships, tenants, users } = installationSchema;

export const app = new Hono<AppEnv>().basePath('/api');

app.onError(handleError);
app.use('*', apiSecurityHeaders());
// CORS only on the API-key surface (/api/v2); session routes stay closed.
app.use('*', apiCors());

// Boot-time migrations: the first request after a deploy applies every pending
// installation migration; afterwards this middleware costs nothing (memoized).
app.use('*', async (c, next) => {
  c.set('schemaVersion', await ensureInstallationMigrated(c.env.DB));
  await next();
});

app.get('/health', (c) => {
  const body: HealthResponse = { ok: true, schemaVersion: c.get('schemaVersion') };
  return c.json(body);
});

// --- Access & security (apps/core/src/auth, apps/core/src/middleware) ------------------------
app.use('*', authServices());
// /api/dev/* only exists with ENVIRONMENT=dev (local seed script).
// /api/platform/v1/* carries no cookie: every request is Ed25519-signed by the control plane.
app.use('*', csrfProtection({ exempt: ['/api/dev/', '/api/platform/v1/'] }));
app.use('/invites/accept', optionalAuth());
app.route('/', publicAuthRoutes);
app.route('/', accountRoutes);
// Every tenant-scoped route — auth, CRM and later modules — lives under /t/:slug and
// passes through the central guards: session or API key, then membership + role.
app.use('/t/:slug/*', requireAuth({ apiKey: true }), requireTenant());
app.route('/t/:slug', tenantAdminRoutes);
// Tenant backups (owner + step-up) under /api/t/:slug/backups.
app.route('/t/:slug/backups', backupRoutes);
// --- end access & security --------------------------------------------------------------------

// Automation engine: outbox kick around every v2 tenant request (+ dev seed route).
mountAutomationApi(app);
// Web analytics: CRM → analytics sync after mutating v2 requests (before the CRM routes).
app.use('/v2/t/:slug/*', analyticsKick());
// CRM REST v2 under /api/v2/t/:slug (same central guards) + /api/v2/openapi.json.
mountCrmApi(app);
// Email marketing + broadcasts REST v2 under /api/v2/t/:slug + /api/v2/openapi/email.json.
mountEmailApi(app);
// Web analytics REST v2 under /api/v2/t/:slug/analytics + /api/v2/openapi/analytics.json.
mountAnalyticsApi(app);
// Forms, calendars & bookings, landing pages REST v2 under /api/v2/t/:slug + /api/v2/openapi/publishing.json.
mountPublishingApi(app);
// Report engine REST v2 under /api/v2/t/:slug (reports, customReports, dashboards) + /api/v2/openapi/reports.json.
mountReportsApi(app);
// Outgoing webhooks, sending/tracking/site domains, merged OpenAPI (/api/v2/openapi/all.json).
mountDevelopersApi(app);
// Platform link (managed offering): signed control plane calls, support, ideas, assisted access.
mountPlatformApi(app);

/**
 * Dev-only seed route — exists only when ENVIRONMENT=dev (never in production).
 * Creates the installation row, a placeholder admin user, the "demo" tenant with
 * an owner membership, writes placeholder rows into the tenant's TenantDb DO and
 * logs a fake system email to the console (local email provider).
 */
app.post('/dev/seed', async (c) => {
  if (c.env.ENVIRONMENT !== 'dev') {
    return c.notFound();
  }

  const db = drizzle(c.env.DB);
  const now = Date.now();

  // Installation row.
  await db
    .insert(installationMeta)
    .values({ key: 'installed_at', value: String(now) })
    .onConflictDoNothing();

  // Admin user placeholder (idempotent on email).
  const adminEmail = 'admin@example.com';
  await db
    .insert(users)
    .values({
      id: ulid(),
      email: adminEmail,
      name: 'Demo Admin',
      locale: 'en',
      theme: 'system',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const admin = await db.select().from(users).where(eq(users.email, adminEmail)).get();
  if (admin === undefined) throw new Error('seed: admin user missing after insert');

  // Demo tenant (idempotent on slug).
  let tenant = await db.select().from(tenants).where(eq(tenants.slug, 'demo')).get();
  if (tenant === undefined) {
    tenant = { id: ulid(), slug: 'demo', name: 'Demo Tenant', createdAt: now };
    await db.insert(tenants).values(tenant);
  }

  // Owner membership (idempotent on composite PK).
  await db
    .insert(memberships)
    .values({
      userId: admin.id,
      tenantId: tenant.id,
      role: 'owner',
      invitedBy: null,
      createdAt: now,
    })
    .onConflictDoNothing();

  // Audit trail of the seeding itself.
  await db.insert(auditLog).values({
    id: ulid(),
    tenantId: tenant.id,
    actorUserId: admin.id,
    action: 'dev.seed',
    target: tenant.slug,
    details: null,
    createdAt: now,
  });

  // Placeholder rows inside the tenant's own Durable Object (migrates on first access).
  const stub = c.env.TENANT_DB.get(c.env.TENANT_DB.idFromName(tenant.id));
  await stub.devSeed({
    'seed:welcome': 'hello from the local seed',
    'seed:tenant_slug': tenant.slug,
    'seed:seeded_at': String(now),
  });
  const tenantRows = await stub.listMeta();
  const tenantSchemaVersion = await stub.getSchemaVersion();

  // Local system email provider: logs to the wrangler dev console, never sends.
  await new ConsoleSystemEmailProvider().send({
    to: admin.email,
    subject: 'Welcome to your local amabledata installation',
    html: '<p>Seed completed.</p>',
    text: 'Seed completed.',
    locale: admin.locale,
  });

  // Known local credentials (password + TOTP secret), printed to the console.
  const devCredentials = await seedDevCredentials(c, admin.id);

  return c.json({
    ok: true,
    installationSchemaVersion: c.get('schemaVersion'),
    admin: { id: admin.id, email: admin.email, ...devCredentials },
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    tenantDb: { schemaVersion: tenantSchemaVersion, metaRows: tenantRows },
  });
});

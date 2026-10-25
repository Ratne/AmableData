import { updateArchiveRetentionSchema } from '@amable/api-types';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { archiveSettings, saveArchiveRetention } from '../archive/settings';
import { getTenant, requireSession, requireStepUp } from '../middleware/access';
import { audit } from '../middleware/audit';
import type { AppEnv } from '../middleware/context';
import { jsonError } from '../middleware/errors';
import { parseJson } from '../middleware/validate';
import {
  BACKUP_MANUAL_MIN_INTERVAL_MS,
  BACKUP_RETENTION_MANUAL,
  BACKUP_RETENTION_SCHEDULED,
  isBackupId,
  tenantBackupPrefix,
} from './format';
import {
  BackupError,
  backupDeps,
  createTenantBackup,
  getTenantBackup,
  listBackups,
  restoreTenantBackup,
} from './service';

/**
 * Tenant backups, mounted at /api/t/:slug/backups (requireAuth + requireTenant
 * come from app.ts). Owner only; create, download and restore need a fresh step-up.
 */
export const backupRoutes = new Hono<AppEnv>();

const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (getTenant(c).role !== 'owner') return jsonError(c, 403, 'forbidden', { missing: ['owner'] });
  await next();
};

const BACKUP_ERROR_STATUS: Record<string, 404 | 409 | 422> = {
  backup_not_found: 404,
  backup_wrong_tenant: 422,
  backup_schema_mismatch: 409,
  backup_invalid: 422,
};

backupRoutes.use('*', requireSession(), requireOwner);

backupRoutes.get('/', async (c) => {
  const { tenant } = getTenant(c);
  const backups = await listBackups(backupDeps(c.env), tenantBackupPrefix(tenant.id));
  return c.json({
    backups: backups.map(({ id, kind, createdAt, size }) => ({ id, kind, createdAt, size })),
    retention: { scheduled: BACKUP_RETENTION_SCHEDULED, manual: BACKUP_RETENTION_MANUAL },
  });
});

// Data & archiving: retention windows of the event archive, archive totals, database sizes.
backupRoutes.get('/archive', async (c) => c.json(await archiveSettings(c.env, getTenant(c).tenant.id)));

backupRoutes.put('/archive', requireStepUp(), async (c) => {
  const input = await parseJson(c, updateArchiveRetentionSchema);
  const retention = await saveArchiveRetention(c.env, getTenant(c).tenant.id, input);
  await audit(c, 'tenant.archive_retention_updated', { details: retention });
  return c.json(await archiveSettings(c.env, getTenant(c).tenant.id));
});

backupRoutes.post('/', requireStepUp(), async (c) => {
  const { tenant } = getTenant(c);
  const deps = backupDeps(c.env);
  const latestManual = (await listBackups(deps, tenantBackupPrefix(tenant.id))).find(
    (b) => b.kind === 'manual',
  );
  if (
    latestManual !== undefined &&
    deps.now() - Date.parse(latestManual.createdAt) < BACKUP_MANUAL_MIN_INTERVAL_MS
  ) {
    return jsonError(c, 429, 'backup_rate_limited');
  }
  const backup = await createTenantBackup(deps, tenant, 'manual');
  await audit(c, 'tenant.backup_created', { target: backup.id, details: { size: backup.size } });
  return c.json(
    { backup: { id: backup.id, kind: backup.kind, createdAt: backup.createdAt, size: backup.size } },
    201,
  );
});

backupRoutes.get('/:id/download', requireStepUp(), async (c) => {
  const { tenant } = getTenant(c);
  const id = c.req.param('id');
  if (!isBackupId(id)) return jsonError(c, 404, 'backup_not_found');
  const object = await getTenantBackup(backupDeps(c.env), tenant.id, id);
  if (object === null) return jsonError(c, 404, 'backup_not_found');
  await audit(c, 'tenant.backup_downloaded', { target: id });
  return new Response(object.body, {
    headers: {
      'content-type': 'application/gzip',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="amable-backup-${tenant.slug}-${id}.jsonl.gz"`,
      'cache-control': 'no-store',
    },
  });
});

backupRoutes.post('/:id/restore', requireStepUp(), async (c) => {
  const { tenant } = getTenant(c);
  const id = c.req.param('id');
  const body = await parseJson(c, z.strictObject({ confirm: z.string() }));
  if (body.confirm !== tenant.slug) return jsonError(c, 422, 'confirmation_mismatch');
  if (!isBackupId(id)) return jsonError(c, 404, 'backup_not_found');
  try {
    const summary = await restoreTenantBackup(backupDeps(c.env), tenant, id);
    await audit(c, 'tenant.backup_restored', {
      target: id,
      details: {
        tenantDbRows: summary.rows.tenant_db,
        mailDbRows: summary.rows.mail_db,
        engineRows: summary.rows.engine,
        safetyBackupId: summary.safetyBackupId,
      },
    });
    return c.json({ ok: true, ...summary });
  } catch (error) {
    if (error instanceof BackupError) {
      await audit(c, 'tenant.backup_restore_rejected', { target: id, details: { code: error.code } });
      return jsonError(c, BACKUP_ERROR_STATUS[error.code] ?? 422, error.code);
    }
    throw error;
  }
});

import type { ArchiveSettings, UpdateArchiveRetentionInput } from '@amable/api-types';
import type { MessageKey } from '@amable/i18n';
import { ApiError } from '../../lib/api';
import { stepUpFetch } from '../../lib/step-up';
import { downloadResponse } from '../../lib/download';
import { request, responseError } from '../../lib/tenant-api';

export type BackupKind = 'scheduled' | 'manual';

export interface BackupItem {
  id: string;
  kind: BackupKind;
  createdAt: string;
  size: number;
}

export interface BackupList {
  backups: BackupItem[];
  retention: { scheduled: number; manual: number };
}

export interface DatabaseSizes {
  databases: Array<{ name: 'tenant_db' | 'mail_db' | 'engine'; bytes: number | null }>;
  limit: number;
  warning: number;
}

export type ArchiveOverview = ArchiveSettings & { storage: DatabaseSizes };

export const backupKeys = {
  list: (slug: string) => ['backups', slug] as const,
  archive: (slug: string) => ['backups', slug, 'archive'] as const,
};

const base = (slug: string) => `/api/t/${encodeURIComponent(slug)}/backups`;

export const backupsApi = {
  list: (slug: string) => request<BackupList>(base(slug)),
  create: (slug: string) =>
    request<{ backup: BackupItem }>(base(slug), { method: 'POST', json: {}, idempotent: false }),
  restore: (slug: string, id: string, confirm: string) =>
    request<{ ok: true }>(`${base(slug)}/${encodeURIComponent(id)}/restore`, { method: 'POST', json: { confirm }, idempotent: false }),
  archive: (slug: string) => request<ArchiveOverview>(`${base(slug)}/archive`),
  saveArchive: (slug: string, input: UpdateArchiveRetentionInput) =>
    request<ArchiveOverview>(`${base(slug)}/archive`, { method: 'PUT', json: input }),
  /** Streams the file into a blob and saves it (the GET needs the session and a fresh step-up). */
  async download(slug: string, id: string): Promise<void> {
    const response = await stepUpFetch(`${base(slug)}/${encodeURIComponent(id)}/download`, {
      credentials: 'same-origin',
    });
    if (!response.ok) throw await responseError(response);
    await downloadResponse(response, `${id}.jsonl.gz`);
  },
};

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  backup_rate_limited: 'backups.error.backup_rate_limited',
  backup_schema_mismatch: 'backups.error.backup_schema_mismatch',
  backup_invalid: 'backups.error.backup_invalid',
  backup_wrong_tenant: 'backups.error.backup_wrong_tenant',
  backup_not_found: 'backups.error.backup_not_found',
  confirmation_mismatch: 'backups.error.confirmation_mismatch',
  forbidden: 'backups.ownerOnly',
};

export function backupErrorKey(error: unknown): MessageKey {
  return (error instanceof ApiError ? ERROR_KEYS[error.code] : undefined) ?? 'backups.error.generic';
}

export { isStepUpRequired } from '../../lib/step-up';

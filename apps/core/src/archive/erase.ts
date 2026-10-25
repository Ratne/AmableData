import { createR2JsonlGzipWriter, readJsonlGzip } from '../backup/jsonl-gzip';
import { archivePrefix, contactPartition, type ArchiveCatalogEntry } from './model';
import { archiveCall, type ArchiveDeps } from './scheduler';

/**
 * Right to erasure on the archive: the live erasure deletes the contact's
 * timeline (`crm_activities`), so its archived activities go too. Every object
 * that may hold them (the contact's partition, plus the company and
 * opportunity partitions, where an activity referencing them is copied) is
 * rewritten in place without the contact's rows.
 */
export async function eraseContactFromArchive(
  deps: Pick<ArchiveDeps, 'bucket' | 'stub'>,
  tenantId: string,
  contactId: string,
): Promise<{ objects: number; rows: number }> {
  let objects = 0;
  let rows = 0;
  for (const partition of [contactPartition(contactId), 'company', 'opportunity']) {
    const entries = await archiveCall<ArchiveCatalogEntry[]>(deps, tenantId, 'tenant_db', 'catalog', {
      stream: 'crm_activities',
      partition,
    });
    for (const entry of entries) {
      if (!entry.object_key.startsWith(archivePrefix(tenantId))) continue;
      const removed = await rewriteWithout(deps.bucket, entry, contactId);
      if (removed === null) continue;
      await archiveCall(deps, tenantId, 'tenant_db', 'record', {
        ...entry,
        rows: entry.rows - removed.rows,
        bytes: removed.bytes,
      });
      objects += 1;
      rows += removed.rows;
    }
  }
  return { objects, rows };
}

/** Rewrites one object without the contact's rows; null when it had none. */
async function rewriteWithout(
  bucket: R2Bucket,
  entry: ArchiveCatalogEntry,
  contactId: string,
): Promise<{ rows: number; bytes: number } | null> {
  const source = await bucket.get(entry.object_key);
  if (source === null) return null;
  const kept: unknown[] = [];
  let removed = 0;
  for await (const row of readJsonlGzip(source.body)) {
    if (typeof row === 'object' && row !== null && (row as Record<string, unknown>)['contact_id'] === contactId) removed += 1;
    else kept.push(row);
  }
  if (removed === 0) return null;
  const writer = createR2JsonlGzipWriter(bucket, entry.object_key, { customMetadata: source.customMetadata ?? {} });
  try {
    for (const row of kept) await writer.write(row);
  } catch (error) {
    await writer.abort();
    throw error;
  }
  return { rows: removed, bytes: await writer.close() };
}

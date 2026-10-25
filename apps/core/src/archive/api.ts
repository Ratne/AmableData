import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  archivedTimelineQuerySchema,
  archivedTimelineSchema,
  idParamSchema,
  type Activity,
} from '@amable/api-types';
import type { Permission } from '@amable/core';
import type { Context } from 'hono';
import { callCrm, crmRoute, json } from '../crm/api/core';
import { callMail } from '../email/http';
import { csvStream } from '../reports/csv';
import { audit, type AppEnv } from '../middleware';
import { contactPartition } from './model';
import { archiveCatalog, archivedActivity, byMonth, readArchiveObject } from './read';

type Ctx = Context<AppEnv>;

/** Months read per request of an archived timeline (each is one object for a contact). */
const TIMELINE_MONTHS_PER_PAGE = 3;
/** Catalog entries fetched per request: a month cut by this limit is left for the next page. */
const TIMELINE_CATALOG_LIMIT = 200;
const TIMELINE_MAX_EVENTS = 1000;

const SUBJECTS = {
  contact: { path: '/contacts/{id}/timeline/archive', permission: 'contacts:read', column: 'contact_id' },
  company: { path: '/companies/{id}/timeline/archive', permission: 'contacts:read', column: 'company_id' },
  opportunity: { path: '/opportunities/{id}/timeline/archive', permission: 'opportunities:read', column: 'opportunity_id' },
} as const satisfies Record<string, { path: string; permission: Permission; column: string }>;

type Subject = keyof typeof SUBJECTS;

/**
 * Older months of a timeline from the archive, newest first, a few months per
 * page. The live timeline (`/timeline`) holds everything newer than the
 * retention window; the UI calls this once it reaches the end of it.
 */
async function archivedTimeline(c: Ctx, subject: Subject, id: string, before: string | undefined) {
  // Same existence and permission check as the live timeline.
  await callCrm(c, 'timeline', { subject, id, limit: 1 });
  const partition = subject === 'contact' ? contactPartition(id) : subject;
  const entries = await archiveCatalog(c, 'crm_activities', partition, {
    ...(before === undefined ? {} : { before }),
    limit: TIMELINE_CATALOG_LIMIT,
  });
  let months = byMonth(entries);
  const truncated = entries.length >= TIMELINE_CATALOG_LIMIT;
  if (truncated && months.length > 1) months = months.slice(0, -1);
  const page = months.slice(0, TIMELINE_MONTHS_PER_PAGE);
  const column = SUBJECTS[subject].column;
  const data: Activity[] = [];
  for (const month of page) {
    const rows: Activity[] = [];
    for (const entry of month.parts) {
      for await (const row of readArchiveObject(c, entry)) {
        if (row[column] === id) rows.push(archivedActivity(row));
      }
    }
    rows.sort((a, b) => (a.id < b.id ? 1 : -1));
    data.push(...rows);
    if (data.length >= TIMELINE_MAX_EVENTS) break;
  }
  const lastMonth = page.at(-1)?.month ?? null;
  const more = months.length > page.length || truncated;
  return { data: data.slice(0, TIMELINE_MAX_EVENTS), next_before: more ? lastMonth : null };
}

/** Archived timeline routes of contacts, companies and opportunities (CRM router). */
export function registerArchiveTimelineRoutes(app: OpenAPIHono<AppEnv>): void {
  for (const subject of Object.keys(SUBJECTS) as Subject[]) {
    const spec = SUBJECTS[subject];
    app.openapi(
      crmRoute(spec.permission, {
        method: 'get',
        path: spec.path,
        tags: ['Archive'],
        summary: `Archived timeline of a ${subject} (months past the retention window, newest first)`,
        request: { params: idParamSchema, query: archivedTimelineQuerySchema },
        responses: { 200: json(archivedTimelineSchema, 'Archived activities, newest first') },
      }),
      async (c) => c.json(await archivedTimeline(c, subject, c.req.valid('param').id, c.req.valid('query').before), 200),
    );
  }
}

const MESSAGE_COLUMNS = [
  'id',
  'contact_id',
  'email',
  'status',
  'status_reason',
  'sent_at',
  'delivered_at',
  'opened_at',
  'clicked_at',
  'bounced_at',
  'complained_at',
  'unsubscribed_at',
  'open_count',
  'click_count',
] as const;

const TIME_COLUMNS = new Set(['sent_at', 'delivered_at', 'opened_at', 'clicked_at', 'bounced_at', 'complained_at', 'unsubscribed_at']);

function messageCells(row: Record<string, unknown>): Array<string | number | null> {
  return MESSAGE_COLUMNS.map((column) => {
    const value = row[column];
    if (value === null || value === undefined) return null;
    if (TIME_COLUMNS.has(column)) return new Date(Number(value)).toISOString();
    return typeof value === 'number' ? value : String(value);
  });
}

/** Broadcast messages moved to the archive, as CSV (email router). */
export function registerArchiveBroadcastRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/broadcasts/{id}/archive.csv',
      tags: ['Archive'],
      summary: 'Export the archived messages of a broadcast as CSV (one line per recipient)',
      request: { params: idParamSchema },
      responses: { 200: { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } } },
    }, { anyOf: ['contacts:read'] }),
    async (c) => {
      const { id } = c.req.valid('param');
      await callMail(c, 'broadcasts.get', { id });
      const entries = byMonth(await archiveCatalog(c, 'mail_messages', id)).reverse();
      await audit(c, 'broadcasts.archive_exported', { target: id, details: { objects: entries.length } });
      async function* pages(): AsyncGenerator<Array<Array<string | number | null>>> {
        for (const month of entries) {
          for (const entry of month.parts) {
            let batch: Array<Array<string | number | null>> = [];
            for await (const row of readArchiveObject(c, entry)) {
              batch.push(messageCells(row));
              if (batch.length >= 500) {
                yield batch;
                batch = [];
              }
            }
            if (batch.length > 0) yield batch;
          }
        }
      }
      return c.body(csvStream(MESSAGE_COLUMNS, pages()), 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="broadcast-${id}-archive.csv"`,
        'cache-control': 'no-store',
      });
    },
  );
}

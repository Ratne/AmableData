import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  archivedMonthsSchema,
  archivedSubmissionsParamSchema,
  archivedSubmissionsQuerySchema,
  archivedSubmissionsSchema,
  contactSubmissionDetailSchema,
  contactSubmissionParamSchema,
  contactSubmissionSchema,
  deletedResponseSchema,
  formIdParamSchema,
  formSubmissionSchema,
  idParamSchema,
  listContactSubmissionsQuerySchema,
  listSubmissionsQuerySchema,
  pageOf,
  submissionParamSchema,
} from '@amable/api-types';
import { archiveCatalog, archiveMonths, readArchiveObject } from '../../archive/read';
import { callCrm, crmRoute, json } from '../../crm/api/core';
import { audit, getTenant, type AppEnv } from '../../middleware';
import { processSubmission } from '../process';
import type { DeliveryRow, SubmissionRow } from '../submissions';
import {
  submissionsTag,
  serializeSubmission,
  requireContactsRead,
  serializeContactSubmission,
  serializeContactSubmissionDetail,
} from './shared';

export function registerSubmissionsRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('forms:submissions_read', {
      method: 'get',
      path: '/forms/{formId}/submissions',
      tags: submissionsTag,
      summary: 'List submissions with their decrypted values (newest first)',
      request: { params: formIdParamSchema, query: listSubmissionsQuerySchema },
      responses: { 200: json(pageOf(formSubmissionSchema), 'Submissions') },
    }),
    async (c) => {
      const page = await callCrm(c, 'forms.listSubmissions', {
        formId: c.req.valid('param').formId,
        ...c.req.valid('query'),
      });
      const data = await Promise.all(
        page.rows.map((r) => serializeSubmission(c, r.submission, r.deliveries)),
      );
      return c.json({ data, next_cursor: page.next_cursor }, 200);
    },
  );
  router.openapi(
    crmRoute('forms:submissions_read', {
      method: 'get',
      path: '/forms/{formId}/submissions/{submissionId}',
      tags: submissionsTag,
      summary: 'Get a decrypted submission with its delivery log',
      request: { params: submissionParamSchema },
      responses: { 200: json(formSubmissionSchema, 'The submission') },
    }),
    async (c) => {
      const { formId, submissionId } = c.req.valid('param');
      const found = await callCrm(c, 'forms.getSubmission', { formId, id: submissionId });
      return c.json(await serializeSubmission(c, found.submission, found.deliveries), 200);
    },
  );
  router.openapi(
    crmRoute('forms:submissions_read', {
      method: 'get',
      path: '/forms/{formId}/archivedSubmissions',
      tags: submissionsTag,
      summary:
        'Months of submissions moved to the archive (past the retention window), newest first',
      request: { params: formIdParamSchema },
      responses: {
        200: json(archivedMonthsSchema, 'Archived months with their submission counts'),
      },
    }),
    async (c) =>
      c.json(
        { data: await archiveMonths(c, 'form_submissions', c.req.valid('param').formId) },
        200,
      ),
  );
  router.openapi(
    crmRoute('forms:submissions_read', {
      method: 'get',
      path: '/forms/{formId}/archivedSubmissions/{month}',
      tags: submissionsTag,
      summary: 'Decrypted submissions of one archived month, oldest first (offset-paginated)',
      request: { params: archivedSubmissionsParamSchema, query: archivedSubmissionsQuerySchema },
      responses: { 200: json(archivedSubmissionsSchema, 'A page of archived submissions') },
    }),
    async (c) => {
      const { formId, month } = c.req.valid('param');
      const { offset, limit } = c.req.valid('query');
      const entries = await archiveCatalog(c, 'form_submissions', formId, { month });
      const rows: Record<string, unknown>[] = [];
      let seen = 0;
      let more = false;
      scan: for (const entry of entries.sort((a, b) => a.part - b.part)) {
        if (seen + entry.rows <= offset) {
          seen += entry.rows;
          continue;
        }
        for await (const row of readArchiveObject(c, entry)) {
          seen += 1;
          if (seen <= offset) continue;
          if (rows.length === limit) {
            more = true;
            break scan;
          }
          rows.push(row);
        }
      }
      const data = await Promise.all(
        rows.map((row) =>
          serializeSubmission(
            c,
            row as unknown as SubmissionRow,
            Array.isArray(row['deliveries']) ? (row['deliveries'] as DeliveryRow[]) : [],
          ),
        ),
      );
      return c.json({ data, next_offset: more ? offset + rows.length : null }, 200);
    },
  );
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/contacts/{id}/submissions',
      tags: submissionsTag,
      summary: "A contact's form submissions across every form (metadata only, newest first)",
      description:
        'Form name, page, status and dates; values stay encrypted (read one with `GET /contacts/{id}/submissions/{submissionId}`). Cursor-paginated. Also requires `contacts:read`.',
      request: { params: idParamSchema, query: listContactSubmissionsQuerySchema },
      responses: {
        200: json(pageOf(contactSubmissionSchema), 'A page of submissions, newest first'),
      },
    }),
    async (c) => {
      requireContactsRead(c);
      const page = await callCrm(c, 'forms.contactSubmissions', {
        id: c.req.valid('param').id,
        ...c.req.valid('query'),
      });
      return c.json(
        { data: page.rows.map(serializeContactSubmission), next_cursor: page.next_cursor },
        200,
      );
    },
  );
  router.openapi(
    crmRoute('forms:submissions_read', {
      method: 'get',
      path: '/contacts/{id}/submissions/{submissionId}',
      tags: submissionsTag,
      summary: 'One decrypted submission of a contact',
      description:
        'Values in form field order, rendered as text. Sensitive values (fields flagged sensitive, or mapped to a sensitive custom field) are masked unless the caller has `contacts:read_sensitive`. Also requires `contacts:read`.',
      request: { params: contactSubmissionParamSchema },
      responses: { 200: json(contactSubmissionDetailSchema, 'The submission') },
    }),
    async (c) => {
      requireContactsRead(c);
      const found = await callCrm(c, 'forms.contactSubmission', c.req.valid('param'));
      return c.json(await serializeContactSubmissionDetail(c, found), 200);
    },
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'delete',
      path: '/forms/{formId}/submissions/{submissionId}',
      tags: submissionsTag,
      summary: 'Erase a submission (encrypted values are wiped; the CRM contact is kept)',
      request: { params: submissionParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { formId, submissionId } = c.req.valid('param');
      const result = await callCrm(c, 'forms.deleteSubmission', { formId, id: submissionId });
      await audit(c, 'forms.submission_deleted', {
        target: submissionId,
        details: { form_id: formId },
      });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'post',
      path: '/forms/{formId}/submissions/{submissionId}/reprocess',
      tags: submissionsTag,
      summary:
        'Process again: apply to the CRM if it failed, retry deliveries that did not succeed',
      request: { params: submissionParamSchema },
      responses: { 200: json(formSubmissionSchema, 'The submission') },
    }),
    async (c) => {
      const { formId, submissionId } = c.req.valid('param');
      await callCrm(c, 'forms.getSubmission', { formId, id: submissionId });
      await processSubmission(c.env, getTenant(c).tenant.id, submissionId, {
        attempt: 1,
        final: true,
      });
      await audit(c, 'forms.submission_reprocessed', {
        target: submissionId,
        details: { form_id: formId },
      });
      const found = await callCrm(c, 'forms.getSubmission', { formId, id: submissionId });
      return c.json(await serializeSubmission(c, found.submission, found.deliveries), 200);
    },
  );
}

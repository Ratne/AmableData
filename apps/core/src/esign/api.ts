import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createEsignRequestSchema,
  createEsignTemplateSchema,
  deletedResponseSchema,
  errorResponseSchema,
  ESIGN_PAGE_IMAGE_MAX_BYTES,
  ESIGN_PDF_MAX_BYTES,
  esignDocumentQuerySchema,
  esignPageParamSchema,
  esignRequestDetailSchema,
  esignRequestParamSchema,
  esignRequestSchema,
  esignSignerLinkSchema,
  esignSignerParamSchema,
  esignTemplateParamSchema,
  esignTemplateSchema,
  listEsignRequestsQuerySchema,
  listEsignTemplatesQuerySchema,
  pageOf,
  remindEsignRequestSchema,
  updateEsignTemplateSchema,
  uploadEsignPageImageQuerySchema,
  uploadEsignPdfQuerySchema,
  voidEsignRequestSchema,
  type EsignEvent,
} from '@amable/api-types';
import { sha256Hex } from '@amable/auth';
import type { Context } from 'hono';
import { ulid } from 'ulid';
import { archiveCatalog, readArchiveObject } from '../archive/read';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { toIso } from '../crm/util';
import { audit, clientCountry, clientIp, getAuth, getTenant, type AppEnv } from '../middleware';
import { cleanFilename } from '../pages/media';
import type { ClientFacts, TenantFacts } from './model';
import { inspectPdf, isPdf } from './pdf-inspect';
import { signerToken, signingUrl } from './tokens';

type Ctx = Context<AppEnv>;

const templatesTag = ['E-signature templates'];
const requestsTag = ['E-signature requests'];
const errorJson = (description: string) => json(errorResponseSchema, description);
const binaryBody = (type: string) => ({
  required: true,
  content: { [type]: { schema: z.string().openapi({ format: 'binary' }) } },
});

/** Requests whose audit events the archive may have moved to R2 (see apps/core/src/archive/streams.ts). */
const ENDED_STATUSES = new Set(['completed', 'declined', 'voided', 'expired']);

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Audit trail of an ended request read back from the archive, in id order. */
async function archivedEsignEvents(c: Ctx, requestId: string): Promise<EsignEvent[]> {
  const events: EsignEvent[] = [];
  for (const entry of (await archiveCatalog(c, 'esign_events', requestId)).sort((a, b) => a.part - b.part)) {
    for await (const row of readArchiveObject(c, entry)) {
      events.push({
        id: String(row['id']),
        signer_id: textOrNull(row['signer_id']),
        type: String(row['type']) as EsignEvent['type'],
        actor: { type: row['actor_type'] as EsignEvent['actor']['type'], id: textOrNull(row['actor_id']) },
        ip: textOrNull(row['ip']),
        user_agent: textOrNull(row['user_agent']),
        country: textOrNull(row['country']),
        meta: typeof row['meta'] === 'object' && row['meta'] !== null ? (row['meta'] as Record<string, unknown>) : {},
        occurred_at: toIso(Number(row['occurred_at'])),
      });
    }
  }
  return events.sort((a, b) => (a.id < b.id ? -1 : 1));
}

const PAGE_IMAGE_TYPES = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' } as const;

function tenantFacts(c: Ctx): TenantFacts {
  const { tenant } = getTenant(c);
  return { id: tenant.id, slug: tenant.slug, name: tenant.name };
}

/** Who called, for the audit trail of the request. */
export function staffClient(c: Ctx): ClientFacts {
  return {
    ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? null,
    country: clientCountry(c),
    meta: { accept_language: c.req.header('accept-language') ?? null },
  };
}

function pageImageType(bytes: Uint8Array): keyof typeof PAGE_IMAGE_TYPES | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  return null;
}

async function readBody(c: Ctx, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > max) return null;
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  return bytes.byteLength > max ? null : bytes;
}

function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]|"/g, '_');
}

async function serveFile(
  c: Ctx,
  file: { key: string; content_type: string; filename: string },
  options: { download?: boolean; cache?: string } = {},
): Promise<Response> {
  const object = await c.env.FILES.get(file.key);
  if (object === null) return c.json({ error: 'not_found', message: 'file missing' }, 404);
  const disposition = options.download === true ? 'attachment' : 'inline';
  return new Response(object.body, {
    headers: {
      'content-type': file.content_type,
      'content-length': String(object.size),
      'x-content-type-options': 'nosniff',
      'content-disposition': `${disposition}; filename="${asciiName(file.filename)}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'cache-control': options.cache ?? 'private, no-store',
    },
  });
}

/** Electronic signatures REST v2 routes (relative to `/api/v2/t/{slug}`). */
export function registerEsignRoutes(router: OpenAPIHono<AppEnv>): void {
  // ------------------------------------------------------------ templates
  router.openapi(
    crmRoute('esign:read', {
      method: 'get',
      path: '/esignTemplates',
      tags: templatesTag,
      summary: 'List document templates',
      request: { query: listEsignTemplatesQuerySchema },
      responses: { 200: json(pageOf(esignTemplateSchema), 'Templates') },
    }),
    async (c) => c.json(await callCrm(c, 'esign.templates.list', c.req.valid('query')), 200),
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'post',
      path: '/esignTemplates',
      tags: templatesTag,
      summary: 'Create a template (then upload its PDF and place the fields)',
      request: { body: jsonBody(createEsignTemplateSchema) },
      responses: { 201: json(esignTemplateSchema, 'The template') },
    }),
    async (c) => {
      const template = await callCrm(c, 'esign.templates.create', {
        data: c.req.valid('json'),
        tenant: tenantFacts(c),
      });
      await audit(c, 'esign.template_created', { target: template.id });
      return c.json(template, 201);
    },
  );
  router.openapi(
    crmRoute('esign:read', {
      method: 'get',
      path: '/esignTemplates/{templateId}',
      tags: templatesTag,
      summary: 'Get a template',
      request: { params: esignTemplateParamSchema },
      responses: { 200: json(esignTemplateSchema, 'The template') },
    }),
    async (c) =>
      c.json(await callCrm(c, 'esign.templates.get', { id: c.req.valid('param').templateId }), 200),
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'patch',
      path: '/esignTemplates/{templateId}',
      tags: templatesTag,
      summary:
        'Update name, parties, signing order, fields, settings or status (`active` needs the document and a field per party)',
      request: { params: esignTemplateParamSchema, body: jsonBody(updateEsignTemplateSchema) },
      responses: { 200: json(esignTemplateSchema, 'The template') },
    }),
    async (c) => {
      const { templateId } = c.req.valid('param');
      const template = await callCrm(c, 'esign.templates.update', {
        id: templateId,
        data: c.req.valid('json'),
        tenant: tenantFacts(c),
      });
      await audit(c, 'esign.template_updated', { target: templateId });
      return c.json(template, 200);
    },
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'delete',
      path: '/esignTemplates/{templateId}',
      tags: templatesTag,
      summary: 'Delete a template (requests already sent are kept)',
      request: { params: esignTemplateParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { templateId } = c.req.valid('param');
      const result = await callCrm(c, 'esign.templates.delete', { id: templateId });
      await audit(c, 'esign.template_deleted', { target: templateId });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'put',
      path: '/esignTemplates/{templateId}/document',
      tags: templatesTag,
      summary:
        'Upload the PDF (raw body, max 20 MB, 50 pages, not encrypted); page images must be uploaded again',
      request: {
        params: esignTemplateParamSchema,
        query: uploadEsignPdfQuerySchema,
        body: binaryBody('application/pdf'),
      },
      responses: {
        200: json(esignTemplateSchema, 'The template'),
        413: errorJson('Larger than 20 MB'),
        415: errorJson('Not a PDF'),
        422: errorJson('Encrypted, empty, unreadable or more than 50 pages'),
      },
    }),
    async (c) => {
      const { templateId } = c.req.valid('param');
      await callCrm(c, 'esign.templates.get', { id: templateId });
      const bytes = await readBody(c, ESIGN_PDF_MAX_BYTES);
      if (bytes === null) return c.json({ error: 'payload_too_large', message: 'max 20 MB' }, 413);
      if (!isPdf(bytes))
        return c.json({ error: 'unsupported_media_type', message: 'only PDF documents' }, 415);
      const inspection = await inspectPdf(bytes);
      if (!inspection.ok) {
        const messages = {
          encrypted: 'password-protected PDFs cannot be signed',
          invalid: 'the PDF could not be read',
          too_many_pages: 'at most 50 pages',
          empty: 'the PDF has no pages',
        } as const;
        return c.json(
          {
            error: 'validation_failed',
            message: messages[inspection.reason],
            details: [{ path: 'body', message: inspection.reason }],
          },
          422,
        );
      }
      const key = `tenants/${getTenant(c).tenant.id}/esign/templates/${templateId}/${ulid()}/source.pdf`;
      const sha256 = await sha256Hex(bytes);
      await c.env.FILES.put(key, bytes, {
        httpMetadata: { contentType: 'application/pdf' },
        sha256,
      });
      try {
        const filename = cleanFilename(c.req.valid('query').filename ?? 'document.pdf');
        const template = await callCrm(c, 'esign.templates.setSource', {
          id: templateId,
          r2_key: key,
          filename: filename === 'image' ? 'document.pdf' : filename,
          size: bytes.byteLength,
          sha256,
          pages: inspection.pages,
        });
        await audit(c, 'esign.template_document_uploaded', {
          target: templateId,
          details: { sha256, pages: inspection.pages.length },
        });
        return c.json(template, 200);
      } catch (error) {
        await c.env.FILES.delete(key).catch(() => undefined);
        throw error;
      }
    },
  );
  router.openapi(
    crmRoute('esign:read', {
      method: 'get',
      path: '/esignTemplates/{templateId}/document',
      tags: templatesTag,
      summary: 'The template PDF',
      request: { params: esignTemplateParamSchema },
      responses: { 200: { description: 'PDF bytes' } },
    }),
    async (c) =>
      serveFile(
        c,
        await callCrm(c, 'esign.templates.file', { id: c.req.valid('param').templateId }),
      ) as never,
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'put',
      path: '/esignTemplates/{templateId}/pages/{page}/image',
      tags: templatesTag,
      summary:
        'Upload the rendered image of one page (WebP, PNG or JPEG, max 4 MB) shown to signers',
      request: {
        params: esignPageParamSchema,
        query: uploadEsignPageImageQuerySchema,
        body: binaryBody('image/webp'),
      },
      responses: {
        200: json(esignTemplateSchema, 'The template'),
        409: errorJson('The document changed since the page was rendered'),
        413: errorJson('Larger than 4 MB'),
        415: errorJson('Not a WebP, PNG or JPEG image'),
      },
    }),
    async (c) => {
      const { templateId, page } = c.req.valid('param');
      const { source_sha256 } = c.req.valid('query');
      const bytes = await readBody(c, ESIGN_PAGE_IMAGE_MAX_BYTES);
      if (bytes === null) return c.json({ error: 'payload_too_large', message: 'max 4 MB' }, 413);
      const type = pageImageType(bytes);
      if (type === null)
        return c.json(
          { error: 'unsupported_media_type', message: 'only WebP, PNG and JPEG images' },
          415,
        );
      const key = `tenants/${getTenant(c).tenant.id}/esign/templates/${templateId}/${source_sha256.slice(0, 16)}/page-${String(page)}-${ulid()}.${PAGE_IMAGE_TYPES[type]}`;
      await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
      try {
        const template = await callCrm(c, 'esign.templates.setPageImage', {
          id: templateId,
          page,
          image_key: key,
          image_type: type,
          source_sha256,
        });
        return c.json(template, 200);
      } catch (error) {
        await c.env.FILES.delete(key).catch(() => undefined);
        throw error;
      }
    },
  );
  router.openapi(
    crmRoute('esign:read', {
      method: 'get',
      path: '/esignTemplates/{templateId}/pages/{page}/image',
      tags: templatesTag,
      summary: 'Rendered image of one page',
      request: { params: esignPageParamSchema },
      responses: { 200: { description: 'Image bytes' } },
    }),
    async (c) => {
      const { templateId, page } = c.req.valid('param');
      return serveFile(c, await callCrm(c, 'esign.templates.file', { id: templateId, page }), {
        cache: 'private, max-age=86400',
      }) as never;
    },
  );

  // ------------------------------------------------------------- requests
  router.openapi(
    crmRoute('esign:read', {
      method: 'get',
      path: '/esignRequests',
      tags: requestsTag,
      summary: 'List signature requests',
      request: { query: listEsignRequestsQuerySchema },
      responses: { 200: json(pageOf(esignRequestSchema), 'Requests') },
    }),
    async (c) => c.json(await callCrm(c, 'esign.requests.list', c.req.valid('query')), 200),
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'post',
      path: '/esignRequests',
      tags: requestsTag,
      summary:
        'Send an active template for signature: one signer per party (contact or email); invitations are queued and go out moments later from the workspace timer, not inside this call',
      request: { body: jsonBody(createEsignRequestSchema) },
      responses: { 201: json(esignRequestSchema, 'The request') },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const request = await callCrm(c, 'esign.requests.create', {
        ...body,
        origin: getAuth(c).kind === 'session' ? 'manual' : 'api',
        client: staffClient(c),
        tenant: tenantFacts(c),
      });
      await audit(c, 'esign.request_sent', {
        target: request.id,
        details: { template_id: body.template_id },
      });
      return c.json(request, 201);
    },
  );
  router.openapi(
    crmRoute('esign:read', {
      method: 'get',
      path: '/esignRequests/{requestId}',
      tags: requestsTag,
      summary:
        'A request with its signers, fields and full audit trail (IP, browser, times, hashes)',
      request: { params: esignRequestParamSchema },
      responses: { 200: json(esignRequestDetailSchema, 'The request') },
    }),
    async (c) => {
      const detail = await callCrm(c, 'esign.requests.detail', { id: c.req.valid('param').requestId });
      if (detail.events.length > 0 || !ENDED_STATUSES.has(detail.status)) return c.json(detail, 200);
      return c.json({ ...detail, events: await archivedEsignEvents(c, detail.id) }, 200);
    },
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'post',
      path: '/esignRequests/{requestId}/void',
      tags: requestsTag,
      summary: 'Cancel a request still being signed (links stop working)',
      request: { params: esignRequestParamSchema, body: jsonBody(voidEsignRequestSchema) },
      responses: { 200: json(esignRequestSchema, 'The request') },
    }),
    async (c) => {
      const { requestId } = c.req.valid('param');
      const request = await callCrm(c, 'esign.requests.void', {
        id: requestId,
        reason: c.req.valid('json').reason,
        client: staffClient(c),
      });
      await audit(c, 'esign.request_voided', { target: requestId });
      return c.json(request, 200);
    },
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'post',
      path: '/esignRequests/{requestId}/remind',
      tags: requestsTag,
      summary: 'Email a reminder now to the signers whose turn it is (or one of them)',
      request: { params: esignRequestParamSchema, body: jsonBody(remindEsignRequestSchema) },
      responses: { 200: json(esignRequestSchema, 'The request') },
    }),
    async (c) => {
      const { requestId } = c.req.valid('param');
      const request = await callCrm(c, 'esign.requests.remind', {
        id: requestId,
        signer_id: c.req.valid('json').signer_id,
        client: staffClient(c),
      });
      await audit(c, 'esign.request_reminded', { target: requestId });
      return c.json(request, 200);
    },
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'post',
      path: '/esignRequests/{requestId}/finalize',
      tags: requestsTag,
      summary: 'Retry sealing the signed PDF after the automatic attempts failed',
      request: { params: esignRequestParamSchema },
      responses: { 200: json(esignRequestSchema, 'The request') },
    }),
    async (c) => {
      const { requestId } = c.req.valid('param');
      await callCrm(c, 'esign.requests.retryFinalize', { id: requestId });
      await audit(c, 'esign.request_finalize_retried', { target: requestId });
      return c.json(await callCrm(c, 'esign.requests.get', { id: requestId }), 200);
    },
  );
  router.openapi(
    crmRoute('esign:read', {
      method: 'get',
      path: '/esignRequests/{requestId}/document',
      tags: requestsTag,
      summary:
        'The signed PDF with its audit pages (`kind=completed`, default) or the original sent for signature',
      request: { params: esignRequestParamSchema, query: esignDocumentQuerySchema },
      responses: { 200: { description: 'PDF bytes' }, 404: errorJson('Not sealed yet') },
    }),
    async (c) => {
      const { requestId } = c.req.valid('param');
      const { kind, download } = c.req.valid('query');
      const file = await callCrm(c, 'esign.requests.file', {
        id: requestId,
        kind,
        client: staffClient(c),
      });
      return serveFile(c, file, { download: download === 'true' }) as never;
    },
  );
  router.openapi(
    crmRoute('esign:write', {
      method: 'post',
      path: '/esignRequests/{requestId}/signers/{signerId}/link',
      tags: requestsTag,
      summary: 'Signing link of one signer, to share it another way (recorded in the audit trail)',
      request: { params: esignSignerParamSchema },
      responses: { 200: json(esignSignerLinkSchema, 'The link') },
    }),
    async (c) => {
      const { requestId, signerId } = c.req.valid('param');
      const facts = await callCrm(c, 'esign.requests.signerLink', {
        requestId,
        signerId,
        client: staffClient(c),
      });
      const { token, hash } = await signerToken(c.env, facts.tokenNonce, facts.tokenHash);
      if (hash !== facts.tokenHash)
        await callCrm(c, 'esign.signers.setTokenHash', { signerId, tokenHash: hash, force: true });
      await audit(c, 'esign.signer_link_copied', {
        target: requestId,
        details: { signer_id: signerId },
      });
      return c.json({ url: signingUrl(c.env, getTenant(c).tenant.slug, token) }, 200);
    },
  );
}

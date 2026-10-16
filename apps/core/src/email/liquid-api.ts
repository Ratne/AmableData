import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  liquidPreviewInputSchema,
  liquidPreviewSchema,
  liquidSchemaSchema,
} from '@amable/api-types';
import type { Context } from 'hono';
import { enforceLimit } from '../auth/helpers';
import { RATE_RULES } from '../auth/rate-limit';
import type { MailSendContact } from '../crm/mail-reads';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { getAuth, getTenant, HttpError, type AppEnv } from '../middleware';
import { callMail } from './http';
import { liquidContextSchema, previewContextFor, renderLiquidPreview } from './liquid';
import { userDirectory } from './runtime';

async function schemaFor(c: Context<AppEnv>) {
  const [fields, snippets] = await Promise.all([
    callCrm(c, 'customFields.list', { entity: 'contact' }),
    callMail(c, 'snippets.list', {}),
  ]);
  return {
    schema: liquidContextSchema({
      customFields: fields,
      snippets: snippets.data,
      canReadSensitive: getTenant(c).can('contacts:read_sensitive'),
    }),
    snippets: snippets.data,
  };
}

/**
 * What every preview renders with, built for the caller: the contact read
 * with the caller's actor (sensitive custom fields masked without
 * `contacts:read_sensitive`), its owner among the tenant members, the
 * snippets and the tenant timezone the send pipeline uses for dates.
 */
async function previewInputs(c: Context<AppEnv>, contactId: string | null) {
  const tenant = getTenant(c);
  let data: MailSendContact | null = null;
  if (contactId !== null) {
    const [found] = await callCrm(c, 'mail.contactsForSend', { ids: [contactId] });
    if (found === undefined) throw new HttpError(404, 'not_found');
    data = found;
  }
  const ownerId = data?.contact.owner_id ?? null;
  const [{ schema, snippets }, owners, { timezone }] = await Promise.all([
    schemaFor(c),
    ownerId === null ? Promise.resolve([]) : userDirectory(c.env, tenant.tenant.id).users([ownerId]),
    callMail(c, 'settings.timezone', {}),
  ]);
  const { user } = getAuth(c);
  return {
    schema,
    timezone,
    contextFor: (variables: readonly string[] | 'all') =>
      previewContextFor({
        data,
        owner: owners[0] ?? null,
        caller: { id: user.id, email: user.email, name: user.name },
        snippets,
        variables,
        timezone,
      }),
  };
}

/** `GET /email/previewContext`: the whole render context of a contact (every snippet), for the email preview. */
export async function emailPreviewContext(
  c: Context<AppEnv>,
  contactId: string,
): Promise<{ context: Record<string, unknown>; timezone: string }> {
  const inputs = await previewInputs(c, contactId);
  return { context: await inputs.contextFor('all'), timezone: inputs.timezone };
}

/** Liquid helper routes (context schema + live preview), relative to /api/v2/t/{slug}. */
export function registerLiquidRoutes(app: OpenAPIHono<AppEnv>): void {
  const tags = ['Dynamic Content snippets'];
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/liquid/schema',
      tags,
      summary: 'Variables, filters and tags available to email and snippet Liquid',
      description:
        'Generated from the real recipient render context: standard contact fields, contact custom fields with their types, company, owner, snippets, `unsubscribe_url` and `now`.',
      responses: { 200: json(liquidSchemaSchema, 'The render context schema') },
    }),
    async (c) => c.json((await schemaFor(c)).schema, 200),
  );
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'post',
      path: '/liquid/preview',
      tags,
      summary: 'Render Liquid for a real contact (or sample data), as the send pipeline would',
      description:
        'Also requires `contacts:read`. Uses the send-time sandbox and context builder; sensitive custom fields are masked for callers without `contacts:read_sensitive`. Nothing is stored or sent. Rate limited per user.',
      request: { body: jsonBody(liquidPreviewInputSchema) },
      responses: { 200: json(liquidPreviewSchema, 'Output, positioned errors and variables') },
    }),
    async (c) => {
      const tenant = getTenant(c);
      if (!tenant.can('contacts:read')) throw new HttpError(403, 'forbidden', { missing: ['contacts:read'] });
      const { user } = getAuth(c);
      await enforceLimit(c.get('services').limiter, RATE_RULES.liquidPreview, `${tenant.tenant.id}:${user.id}`);
      const input = c.req.valid('json');
      const contactId = input.contact_id ?? null;
      const inputs = await previewInputs(c, contactId);
      const result = await renderLiquidPreview({
        template: input.template,
        format: input.format,
        schemaPaths: inputs.schema.fields.map((f) => f.path),
        contactId,
        timezone: inputs.timezone,
        contextFor: inputs.contextFor,
      });
      return c.json(result, 200);
    },
  );
}

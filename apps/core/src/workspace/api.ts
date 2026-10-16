import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  errorResponseSchema,
  generalSettingsSchema,
  updateGeneralSettingsSchema,
  workspaceProfileSchema,
  WORKSPACE_LOGO_MAX_BYTES,
  type GeneralSettings,
  type UpdateGeneralSettingsInput,
  type WorkspaceProfile,
} from '@amable/api-types';
import type { Context } from 'hono';
import { ulid } from 'ulid';
import { findTenantBySlug } from '../auth/store';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { callMail } from '../email/http';
import { isValidTimeZone } from '../email/settings';
import { audit, defer, getTenant, type AppEnv } from '../middleware';
import { mediaExtension, sniffImageType } from '../pages/media';
import type { StoredWorkspace, WorkspacePatch } from './settings';

const tags = ['Settings'];

interface Identity {
  readonly name: string;
  readonly slug: string;
}

function logoUrl(slug: string, key: string | null): string | null {
  if (key === null) return null;
  const version = key.slice(key.lastIndexOf('/') + 1, key.lastIndexOf('.'));
  return `/api/v2/t/${encodeURIComponent(slug)}/workspace/logo?v=${encodeURIComponent(version)}`;
}

async function loadProfile(
  c: Context<AppEnv>,
  identity: Identity,
): Promise<{ profile: WorkspaceProfile; stored: StoredWorkspace }> {
  const [stored, { timezone }, commerce] = await Promise.all([
    callCrm(c, 'workspace.settings.get', {}),
    callMail(c, 'settings.timezone', {}),
    callCrm(c, 'commerce.settings.get', {}),
  ]);
  return {
    stored,
    profile: {
      name: identity.name,
      slug: identity.slug,
      logo_url: logoUrl(identity.slug, stored.logo_key),
      primary_color: stored.primary_color,
      timezone,
      language: stored.language,
      country_code: stored.country_code,
      currency: commerce.default_currency,
    },
  };
}

async function loadGeneral(c: Context<AppEnv>, identity: Identity): Promise<GeneralSettings> {
  const [{ profile, stored }, aliases] = await Promise.all([
    loadProfile(c, identity),
    c.env.DB.prepare(`SELECT slug FROM tenant_slug_aliases WHERE tenant_id = ? ORDER BY created_at`)
      .bind(getTenant(c).tenant.id)
      .all<{ slug: string }>(),
  ]);
  return {
    ...profile,
    previous_slugs: aliases.results.map((r) => r.slug),
    company: stored.company,
  };
}

const currentIdentity = (c: Context<AppEnv>): Identity => {
  const { tenant } = getTenant(c);
  return { name: tenant.name, slug: tenant.slug };
};

async function changesSlug(c: Context<AppEnv>): Promise<boolean> {
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== 'object' || body === null || !('slug' in body)) return false;
  return body.slug !== getTenant(c).tenant.slug;
}

const fail = (error: string, message: string, path?: string) => ({
  error,
  message,
  ...(path === undefined ? {} : { details: [{ path, message }] }),
});

/** Settings > General, relative to `/api/v2/t/{slug}` (registered on the CRM router). */
export function registerWorkspaceRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/workspace',
      tags,
      summary: 'Workspace profile (name, white label, regional defaults)',
      description:
        'Readable by every member: the app shell and the defaults of new records use it.',
      responses: { 200: json(workspaceProfileSchema, 'Profile') },
    }),
    async (c) => c.json((await loadProfile(c, currentIdentity(c))).profile, 200),
  );

  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/workspace/logo',
      tags,
      summary: 'The uploaded workspace logo',
      responses: {
        200: { description: 'Image bytes' },
        404: json(errorResponseSchema, 'No logo uploaded'),
      },
    }),
    async (c) => {
      const { logo_key } = await callCrm(c, 'workspace.settings.get', {});
      const object = logo_key === null ? null : await c.env.FILES.get(logo_key);
      if (object === null)
        return c.json({ error: 'not_found' as const, message: 'no logo uploaded' }, 404);
      return new Response(object.body, {
        headers: {
          'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
          'x-content-type-options': 'nosniff',
        },
      });
    },
  );

  app.openapi(
    crmRoute('settings:manage', {
      method: 'get',
      path: '/settings/general',
      tags,
      summary: 'General settings (identity, white label, regional defaults, company profile)',
      responses: { 200: json(generalSettingsSchema, 'Settings') },
    }),
    async (c) => c.json(await loadGeneral(c, currentIdentity(c)), 200),
  );

  app.openapi(
    crmRoute(
      'settings:manage',
      {
        method: 'patch',
        path: '/settings/general',
        tags,
        summary: 'Update the general settings',
        description:
          'A new `slug` needs step-up and must be free; the previous one stays reserved to this workspace and keeps resolving (public links, API). `timezone` is the one of email sends, `currency` the e-commerce default.',
        request: { body: jsonBody(updateGeneralSettingsSchema) },
        responses: {
          200: json(generalSettingsSchema, 'Settings'),
          409: json(errorResponseSchema, 'Slug already used by another workspace'),
          422: json(errorResponseSchema, 'Unknown timezone'),
        },
      },
      { stepUp: changesSlug },
    ),
    async (c) => {
      const body: UpdateGeneralSettingsInput = c.req.valid('json');
      const { tenant } = getTenant(c);
      if (body.timezone !== undefined && !isValidTimeZone(body.timezone)) {
        return c.json(
          fail('validation_failed', `timezone: unknown timezone ${body.timezone}`, 'timezone'),
          422,
        );
      }
      const slug = body.slug ?? tenant.slug;
      if (slug !== tenant.slug) {
        const owner = await findTenantBySlug(c.env.DB, slug);
        if (owner !== null && owner.id !== tenant.id) {
          return c.json(fail('slug_taken', 'slug: already used by another workspace', 'slug'), 409);
        }
      }
      const name = body.name ?? tenant.name;

      const now = c.get('services').now();
      const statements: D1PreparedStatement[] = [];
      if (slug !== tenant.slug) {
        statements.push(
          c.env.DB.prepare(`DELETE FROM tenant_slug_aliases WHERE slug = ? AND tenant_id = ?`).bind(
            slug,
            tenant.id,
          ),
          c.env.DB.prepare(
            `INSERT OR REPLACE INTO tenant_slug_aliases (slug, tenant_id, created_at) VALUES (?, ?, ?)`,
          ).bind(tenant.slug, tenant.id, now),
        );
      }
      if (slug !== tenant.slug || name !== tenant.name) {
        statements.push(
          c.env.DB.prepare(`UPDATE tenants SET slug = ?, name = ? WHERE id = ?`).bind(
            slug,
            name,
            tenant.id,
          ),
        );
      }
      if (statements.length > 0) await c.env.DB.batch(statements);

      if (body.timezone !== undefined)
        await callMail(c, 'settings.update', { timezone: body.timezone });
      if (body.currency !== undefined)
        await callCrm(c, 'commerce.settings.update', { default_currency: body.currency });
      const patch: WorkspacePatch = {
        ...(body.primary_color === undefined
          ? {}
          : { primary_color: body.primary_color?.toLowerCase() ?? null }),
        ...(body.language === undefined ? {} : { language: body.language }),
        ...(body.country_code === undefined ? {} : { country_code: body.country_code }),
        ...(body.company === undefined ? {} : { company: body.company }),
      };
      if (Object.keys(patch).length > 0) await callCrm(c, 'workspace.settings.update', patch);

      if (slug !== tenant.slug) {
        await audit(c, 'tenant.slug_changed', {
          target: slug,
          details: { from: tenant.slug, to: slug },
        });
      }
      await audit(c, 'settings.general_updated', {
        details: { fields: Object.keys(body).join(',') },
      });
      return c.json(await loadGeneral(c, { name, slug }), 200);
    },
  );

  app.openapi(
    crmRoute('settings:manage', {
      method: 'put',
      path: '/settings/general/logo',
      tags,
      summary: 'Upload the workspace logo (raw body, max 1 MB; PNG, JPEG, GIF, WebP, AVIF)',
      request: {
        body: {
          required: true,
          content: {
            'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
          },
        },
      },
      responses: {
        200: json(generalSettingsSchema, 'Settings with the new logo'),
        413: json(errorResponseSchema, 'Larger than 1 MB'),
        415: json(errorResponseSchema, 'Not a supported image'),
      },
    }),
    async (c) => {
      const tooLarge = () => c.json(fail('payload_too_large', 'max 1 MB'), 413);
      if (Number(c.req.header('content-length') ?? '0') > WORKSPACE_LOGO_MAX_BYTES)
        return tooLarge();
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > WORKSPACE_LOGO_MAX_BYTES) return tooLarge();
      const type = sniffImageType(bytes);
      if (type === null) {
        return c.json(
          fail('unsupported_media_type', 'only PNG, JPEG, GIF, WebP and AVIF images'),
          415,
        );
      }
      const { tenant } = getTenant(c);
      const key = `tenants/${tenant.id}/branding/${ulid()}.${mediaExtension(type)}`;
      await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
      const previous = (await callCrm(c, 'workspace.settings.get', {})).logo_key;
      try {
        await callCrm(c, 'workspace.settings.update', { logo_key: key });
      } catch (error) {
        await c.env.FILES.delete(key).catch(() => undefined);
        throw error;
      }
      if (previous !== null) await defer(c, c.env.FILES.delete(previous));
      await audit(c, 'settings.logo_uploaded', { target: key });
      return c.json(await loadGeneral(c, currentIdentity(c)), 200);
    },
  );

  app.openapi(
    crmRoute('settings:manage', {
      method: 'delete',
      path: '/settings/general/logo',
      tags,
      summary: 'Remove the workspace logo (the product logo is shown again)',
      responses: { 200: json(generalSettingsSchema, 'Settings') },
    }),
    async (c) => {
      const previous = (await callCrm(c, 'workspace.settings.get', {})).logo_key;
      if (previous !== null) {
        await callCrm(c, 'workspace.settings.update', { logo_key: null });
        await defer(c, c.env.FILES.delete(previous));
        await audit(c, 'settings.logo_removed', {});
      }
      return c.json(await loadGeneral(c, currentIdentity(c)), 200);
    },
  );
}

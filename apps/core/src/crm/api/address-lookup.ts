import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  addressLookupSettingsSchema,
  addressSuggestionsQuerySchema,
  addressSuggestionsResponseSchema,
  errorResponseSchema,
  type AddressSuggestion,
} from '@amable/api-types';
import type { Context } from 'hono';
import { callApp } from '../../apps/call';
import { tenantInstalls, type AppInstall } from '../../apps/store';
import type { Env } from '../../env';
import { getTenant, type AppEnv } from '../../middleware';
import {
  AddressLookupUnavailable,
  addressLookupUrl,
  appSuggestions,
  lookupAddresses,
  type AddressLookupQuery,
} from '../address-lookup';
import { crmRoute, json } from './core';

const tags = ['Contacts'];

/** Autocomplete runs while the user types: a slow app falls back to the geocoder. */
export const ADDRESS_APP_TIMEOUT_MS = 3_000;

const unavailable = (message: string) => ({ error: 'address_lookup_unavailable', message }) as const;

/** The first installed app with `extensions.address_lookup` (oldest install wins). */
async function addressApp(c: Context<AppEnv>): Promise<AppInstall | null> {
  return addressAppOf(c.env, getTenant(c).tenant.id);
}

async function addressAppOf(env: Env, tenantId: string): Promise<AppInstall | null> {
  const installs = await tenantInstalls(env.DB, tenantId);
  return (
    installs.find(
      (i) => (i.status === 'active' || i.status === 'paused') && i.manifest.extensions.address_lookup !== undefined,
    ) ?? null
  );
}

async function askApp(env: Env, install: AppInstall, query: AddressLookupQuery): Promise<AddressSuggestion[] | null> {
  const def = install.manifest.extensions.address_lookup;
  if (def === undefined || install.status !== 'active') return null;
  const result = await callApp(
    env,
    install,
    def.endpoint,
    { q: query.q, lang: query.lang ?? null, country: query.country ?? null },
    { kind: 'hook', timeoutMs: ADDRESS_APP_TIMEOUT_MS, maxBytes: 256 * 1024 },
  );
  if (!result.ok) {
    console.warn('address app failed', install.appId, result.error ?? result.status);
    return null;
  }
  return appSuggestions(result.body, query.country);
}

/**
 * Same sources as the contact editor, for public forms (checkout buyer
 * address): the installed app, then the geocoder. Empty when neither answers.
 */
export async function suggestAddresses(env: Env, tenantId: string, query: AddressLookupQuery): Promise<AddressSuggestion[]> {
  const install = await addressAppOf(env, tenantId);
  if (install !== null) {
    const data = await askApp(env, install, query);
    if (data !== null) return data;
  }
  const base = addressLookupUrl(env.ADDRESS_LOOKUP_URL);
  if (base === null) return [];
  try {
    return await lookupAddresses(base, query);
  } catch (error) {
    if (!(error instanceof AddressLookupUnavailable)) throw error;
    return [];
  }
}

export function registerAddressLookupRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('contacts:write', {
      method: 'get',
      path: '/addressSuggestions',
      tags,
      summary: 'Suggest postal addresses',
      description:
        'Free-text address search for the contact editor, restricted to `country` when given. Uses the installed address app (`extensions.address_lookup`, e.g. Mapbox) when there is one, falling back to the installation geocoder (OpenStreetMap data) if the app fails. `enabled: false` when neither is available; 503 `address_lookup_unavailable` when nothing answers (enter the address by hand).',
      request: { query: addressSuggestionsQuerySchema },
      responses: {
        200: json(addressSuggestionsResponseSchema, 'Up to 5 suggestions'),
        503: json(errorResponseSchema, 'The geocoder did not answer'),
      },
    }),
    async (c) => {
      const query = c.req.valid('query');
      const base = addressLookupUrl(c.env.ADDRESS_LOOKUP_URL);
      const install = await addressApp(c);
      if (install !== null) {
        const data = await askApp(c.env, install, query);
        if (data !== null) {
          const attribution = install.manifest.extensions.address_lookup?.attribution ?? install.manifest.name;
          return c.json({ enabled: true, provider: 'app' as const, attribution, data }, 200);
        }
        if (base === null && install.status === 'active') {
          return c.json(unavailable(`${install.manifest.name} is not answering; enter the address by hand`), 503);
        }
      }
      if (base === null) {
        return c.json({ enabled: false, provider: null, attribution: null, data: [] as AddressSuggestion[] }, 200);
      }
      try {
        const data = await lookupAddresses(base, query);
        return c.json({ enabled: true, provider: 'photon' as const, attribution: '© OpenStreetMap', data }, 200);
      } catch (error) {
        if (!(error instanceof AddressLookupUnavailable)) throw error;
        console.warn('address lookup unavailable', error.message);
        return c.json(unavailable('address lookup is not answering; enter the address by hand'), 503);
      }
    },
  );

  app.openapi(
    crmRoute('integrations:manage', {
      method: 'get',
      path: '/settings/addressLookup',
      tags: ['Settings'],
      summary: 'Address autocomplete source',
      description:
        'The installation geocoder (OpenStreetMap), unless an installed app provides address search: install one from the Marketplace (e.g. Mapbox) to change it.',
      responses: { 200: json(addressLookupSettingsSchema, 'Source of address suggestions') },
    }),
    async (c) => {
      const install = await addressApp(c);
      return c.json(
        {
          default_available: addressLookupUrl(c.env.ADDRESS_LOOKUP_URL) !== null,
          app:
            install === null
              ? null
              : {
                  app_id: install.appId,
                  name: install.manifest.name,
                  icon_url: install.manifest.icon_url,
                  paused: install.status === 'paused',
                },
        },
        200,
      );
    },
  );
}

import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  addressLookupSettingsSchema,
  addressSuggestionsQuerySchema,
  addressSuggestionsResponseSchema,
  errorResponseSchema,
  updateAddressLookupSettingsSchema,
  type AddressLookupSettings,
  type AddressSuggestion,
} from '@amable/api-types';
import type { Context } from 'hono';
import { getTenant, type AppEnv } from '../../middleware';
import { secretHint } from '../../forms/crypto';
import {
  AddressLookupUnauthorized,
  AddressLookupUnavailable,
  addressLookupUrl,
  lookupAddresses,
  lookupMapbox,
  verifyMapboxToken,
} from '../address-lookup';
import type { StoredAddressLookup } from '../address-settings';
import { callCrm, crmRoute, json, jsonBody } from './core';

const tags = ['Contacts'];

function mapboxAd(tenantId: string): string {
  return `address-lookup:${tenantId}:mapbox`;
}

function publicSettings(c: Context<AppEnv>, stored: StoredAddressLookup): AddressLookupSettings {
  return {
    provider: stored.provider,
    default_available: addressLookupUrl(c.env.ADDRESS_LOOKUP_URL) !== null,
    mapbox: {
      configured: stored.mapbox_token_ciphertext !== null,
      token_hint: stored.mapbox_token_hint,
      permanent: stored.mapbox_permanent,
    },
  };
}

async function touchesToken(c: Context<AppEnv>): Promise<boolean> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body !== 'object' || body === null || 'mapbox_token' in body;
}

const unavailable = (message: string) => ({ error: 'address_lookup_unavailable', message }) as const;

export function registerAddressLookupRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('contacts:write', {
      method: 'get',
      path: '/addressSuggestions',
      tags,
      summary: 'Suggest postal addresses',
      description:
        "Free-text address search for the contact editor, restricted to `country` when given. Uses the tenant's Mapbox token when configured (falling back to the installation geocoder if Mapbox fails), else the installation geocoder (OpenStreetMap data). `enabled: false` when neither is available; 503 `address_lookup_unavailable` when the geocoder does not answer (enter the address by hand).",
      request: { query: addressSuggestionsQuerySchema },
      responses: {
        200: json(addressSuggestionsResponseSchema, 'Up to 5 suggestions'),
        503: json(errorResponseSchema, 'The geocoder did not answer'),
      },
    }),
    async (c) => {
      const query = c.req.valid('query');
      const base = addressLookupUrl(c.env.ADDRESS_LOOKUP_URL);
      const stored = await callCrm(c, 'addressLookup.settings.get', {});
      if (stored.provider === 'mapbox' && stored.mapbox_token_ciphertext !== null) {
        try {
          const token = await c
            .get('services')
            .secretBox.decrypt(stored.mapbox_token_ciphertext, mapboxAd(getTenant(c).tenant.id));
          const data = await lookupMapbox(token, query, { permanent: stored.mapbox_permanent });
          return c.json({ enabled: true, provider: 'mapbox' as const, data }, 200);
        } catch (error) {
          console.warn('mapbox address lookup failed', error instanceof Error ? error.message : error);
          if (base === null) return c.json(unavailable('Mapbox is not answering; enter the address by hand'), 503);
        }
      }
      if (base === null) return c.json({ enabled: false, provider: null, data: [] as AddressSuggestion[] }, 200);
      try {
        return c.json({ enabled: true, provider: 'photon' as const, data: await lookupAddresses(base, query) }, 200);
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
      summary: 'Address autocomplete provider',
      responses: { 200: json(addressLookupSettingsSchema, 'Settings (the Mapbox token is never returned)') },
    }),
    async (c) => c.json(publicSettings(c, await callCrm(c, 'addressLookup.settings.get', {})), 200),
  );

  app.openapi(
    crmRoute(
      'integrations:manage',
      {
        method: 'patch',
        path: '/settings/addressLookup',
        tags: ['Settings'],
        summary: 'Update the address autocomplete provider',
        description:
          'A new `mapbox_token` is checked against Mapbox before it is stored (encrypted). Choosing `mapbox` needs a saved token.',
        request: { body: jsonBody(updateAddressLookupSettingsSchema) },
        responses: {
          200: json(addressLookupSettingsSchema, 'Settings'),
          422: json(errorResponseSchema, 'Token rejected by Mapbox, or `mapbox` chosen without a token'),
          503: json(errorResponseSchema, 'Mapbox could not be reached to check the token'),
        },
      },
      { stepUp: touchesToken },
    ),
    async (c) => {
      const body = c.req.valid('json');
      const tenantId = getTenant(c).tenant.id;
      const patch: Parameters<typeof callCrm<'addressLookup.settings.update'>>[2] = {};
      if (body.mapbox_token === null) {
        patch.mapbox_token_ciphertext = null;
        patch.mapbox_token_hint = null;
        patch.provider = 'default';
      } else if (body.mapbox_token !== undefined) {
        try {
          await verifyMapboxToken(body.mapbox_token);
        } catch (error) {
          if (error instanceof AddressLookupUnauthorized) {
            return c.json(
              {
                error: 'validation_failed' as const,
                message: 'mapbox_token: Mapbox rejected this token',
                details: [{ path: 'mapbox_token', message: 'Mapbox rejected this token' }],
              },
              422,
            );
          }
          if (error instanceof AddressLookupUnavailable) {
            return c.json(unavailable('Mapbox could not be reached to check the token; try again'), 503);
          }
          throw error;
        }
        patch.mapbox_token_ciphertext = await c.get('services').secretBox.encrypt(body.mapbox_token, mapboxAd(tenantId));
        patch.mapbox_token_hint = secretHint(body.mapbox_token);
      }
      if (body.mapbox_permanent !== undefined) patch.mapbox_permanent = body.mapbox_permanent;
      if (body.provider !== undefined && body.mapbox_token !== null) {
        const current = await callCrm(c, 'addressLookup.settings.get', {});
        const hasToken = patch.mapbox_token_ciphertext != null || current.mapbox_token_ciphertext !== null;
        if (body.provider === 'mapbox' && !hasToken) {
          return c.json(
            {
              error: 'validation_failed' as const,
              message: 'provider: save a Mapbox token first',
              details: [{ path: 'provider', message: 'save a Mapbox token first' }],
            },
            422,
          );
        }
        patch.provider = body.provider;
      }
      return c.json(publicSettings(c, await callCrm(c, 'addressLookup.settings.update', patch)), 200);
    },
  );
}

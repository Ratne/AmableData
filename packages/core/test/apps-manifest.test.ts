import { describe, expect, it } from 'vitest';
import {
  DEPLOYED_APP_ORIGIN,
  appCustomFieldKey,
  appDatabaseName,
  appWorkerName,
  isDeployableManifest,
  parseAppManifest,
  resolveDeployedManifest,
  signCatalogIndex,
  validateAppInput,
  verifySignedCatalog,
  type AppManifestInput,
} from '../src/apps';

function manifest(overrides: Partial<AppManifestInput> = {}): AppManifestInput {
  return {
    schema_version: 1,
    id: 'emailable',
    name: 'Emailable',
    tagline: { en: 'Verify emails as they arrive' },
    description: { en: 'Flags invalid and disposable email addresses on contacts and forms.' },
    developer: { name: 'Amable', url: 'https://amabledata.com', email: 'apps@amabledata.com' },
    categories: ['data_quality'],
    icon_url: 'https://apps.example.com/icon.png',
    homepage: 'https://apps.example.com',
    support_url: 'https://apps.example.com/support',
    privacy_url: 'https://apps.example.com/privacy',
    base_url: 'https://apps.example.com',
    jwks_url: 'https://apps.example.com/.well-known/jwks.json',
    redirect_uris: ['https://apps.example.com/install'],
    api_version: '2026-10',
    scopes: ['contacts:read', 'contacts:write'],
    webhooks: { endpoint: '/webhooks', events: ['contact.created'] },
    privacy: { handles_personal_data: true, erasure_endpoint: '/privacy/erasure', data_request_endpoint: '/privacy/data' },
    custom_fields: [{ key: 'email_status', label: { en: 'Email status' }, type: 'TEXT', entity: 'contact' }],
    extensions: { contact_validate: { fields: ['email'], endpoint: '/hooks/validate', cache_ttl_seconds: 3600 } },
    ...overrides,
  };
}

function issuesOf(input: AppManifestInput): string[] {
  const result = parseAppManifest(input);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe('app manifest', () => {
  it('accepts a complete manifest and fills defaults', () => {
    const result = parseAppManifest(manifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.pricing).toEqual({ model: 'free' });
      expect(result.manifest.extensions.contact_validate?.cache_ttl_seconds).toBe(3600);
    }
  });

  it('takes an optional semver release', () => {
    expect(parseAppManifest(manifest({ version: '1.0.1' })).ok).toBe(true);
    expect(parseAppManifest(manifest({ version: 'v1.0' })).ok).toBe(false);
  });

  it('rejects administrative scopes and events the scopes do not cover', () => {
    expect(issuesOf(manifest({ scopes: ['contacts:read', 'users:manage'] })).join()).toMatch(/scopes/);
    expect(issuesOf(manifest({ webhooks: { endpoint: '/webhooks', events: ['order.paid'] } })).join()).toMatch(
      /order.paid/,
    );
  });

  it('requires GDPR endpoints whenever personal data is in scope', () => {
    const missing = issuesOf(manifest({ privacy: { handles_personal_data: true } }));
    expect(missing.some((i) => i.startsWith('privacy.erasure_endpoint'))).toBe(true);
    const undeclared = issuesOf(manifest({ privacy: { handles_personal_data: false } }));
    expect(undeclared.some((i) => i.startsWith('privacy.handles_personal_data'))).toBe(true);
  });

  it('keeps every hook on base_url', () => {
    const escaped = issuesOf(
      manifest({ extensions: { contact_validate: { fields: ['email'], endpoint: '//evil.example/x' } } }),
    );
    expect(escaped.length).toBeGreaterThan(0);
    expect(issuesOf(manifest({ base_url: 'https://apps.example.com/' })).length).toBeGreaterThan(0);
  });

  it('allows localhost only with a consistent scheme', () => {
    const dev = manifest({
      base_url: 'http://localhost:8788',
      jwks_url: 'http://localhost:8788/jwks.json',
      redirect_uris: ['http://localhost:8788/install'],
    });
    expect(issuesOf(dev)).toEqual([]);
    expect(issuesOf({ ...dev, jwks_url: 'https://apps.example.com/jwks.json' }).join()).toMatch(/scheme/);
  });

  it('asks reply-window channels for templates and limits dynamic options to free strings', () => {
    const channel = { key: 'whatsapp', name: { en: 'WhatsApp' }, kind: 'whatsapp' as const, send_endpoint: '/send', address_field: 'phone' as const };
    const scopes: AppManifestInput['scopes'] = ['contacts:read', 'contacts:write', 'conversations:write'];
    expect(issuesOf(manifest({ scopes, extensions: { channels: [{ ...channel, reply_window_hours: 24 }] } }))).toEqual([
      expect.stringContaining('templates_endpoint'),
    ]);
    expect(issuesOf(manifest({ scopes, extensions: { channels: [{ ...channel, reply_window_hours: 24, templates_endpoint: '/templates' }] } }))).toEqual([]);

    const action = (property: Record<string, unknown>) =>
      manifest({
        scopes,
        extensions: {
          automation_actions: [
            { key: 'send_template', name: { en: 'Send' }, endpoint: '/send', input_schema: { type: 'object', properties: { template: property } } },
          ],
        },
      } as Partial<AppManifestInput>);
    expect(issuesOf(action({ type: 'string', title: { en: 'Template' }, options_endpoint: '/options' }))).toEqual([]);
    expect(issuesOf(action({ type: 'string', title: { en: 'Template' }, enum: ['a'], options_endpoint: '/options' }))).toEqual([
      expect.stringContaining('options_endpoint'),
    ]);
    expect(issuesOf(action({ type: 'number', title: { en: 'Template' }, options_endpoint: '/options' }))).toEqual([
      expect.stringContaining('options_endpoint'),
    ]);
  });

  it('requires the scopes behind each extension', () => {
    const noWrite = issuesOf(manifest({ scopes: ['contacts:read'] }));
    expect(noWrite.some((i) => i.startsWith('custom_fields'))).toBe(true);
  });

  it('places app pages in a sidebar group', () => {
    const ui = (entry: Record<string, unknown>) =>
      manifest({ extensions: { ui: [{ key: 'main', path: '/ui', title: { en: 'Main' }, ...entry }] } } as Partial<AppManifestInput>);
    expect(issuesOf(ui({ slot: 'app.page', nav_group: 'marketing' }))).toEqual([]);
    expect(issuesOf(ui({ slot: 'app.page', nav_group: 'settings' })).join()).toMatch(/nav_group/);
    expect(issuesOf(ui({ slot: 'app.settings', nav_group: 'marketing' })).join()).toMatch(/only for app.page/);
  });

  it('namespaces owned custom fields', () => {
    expect(appCustomFieldKey('my-app', 'status')).toBe('app_my_app_status');
  });
});

describe('action input', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      template: { type: 'string' as const, title: { en: 'Template' }, enum: ['welcome', 'reminder'] },
      body: { type: 'string' as const, title: { en: 'Body' }, merge_tags: true, max_length: 10 },
      delay: { type: 'integer' as const, title: { en: 'Delay' }, minimum: 0, maximum: 60 },
    },
    required: ['template'],
  };

  it('reports missing, unknown and malformed values', () => {
    expect(validateAppInput(schema, { template: 'welcome', delay: 5 })).toEqual([]);
    expect(validateAppInput(schema, { delay: 1.5, extra: 1 }).map((i) => `${i.key}:${i.code}`).sort()).toEqual([
      'delay:type',
      'extra:unknown',
      'template:required',
    ]);
    expect(validateAppInput(schema, { template: 'nope' })).toEqual([{ key: 'template', code: 'enum' }]);
  });

  it('accepts merge tags in place of the final value', () => {
    expect(validateAppInput(schema, { template: 'welcome', body: 'Hi {{contact.first_name}}' })).toEqual([]);
    expect(validateAppInput(schema, { template: 'welcome', body: 'far too long text' })).toEqual([
      { key: 'body', code: 'too_long' },
    ]);
  });
});

describe('deployed apps', () => {
  const origin = DEPLOYED_APP_ORIGIN;
  const deployment = {
    kind: 'cloudflare_worker' as const,
    bundle_url: 'https://github.com/Ratne/AmableData/releases/download/app-timely-1.0.0/worker.mjs',
    bundle_sha256: 'a'.repeat(64),
    compatibility_date: '2026-10-01',
    d1: [{ binding: 'DB' }],
    cron: ['* * * * *'],
  };
  const template = (overrides: Partial<AppManifestInput> = {}) =>
    manifest({
      base_url: origin,
      jwks_url: `${origin}/.well-known/jwks.json`,
      redirect_uris: [`${origin}/install`],
      deployment,
      ...overrides,
    });

  it('accepts a catalog template and resolves it on the Worker origin', () => {
    const result = parseAppManifest(template());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isDeployableManifest(result.manifest)).toBe(true);
    const resolved = resolveDeployedManifest(result.manifest, 'https://amable-app-emailable.acme.workers.dev/ignored');
    expect(resolved.base_url).toBe('https://amable-app-emailable.acme.workers.dev');
    expect(resolved.jwks_url).toBe('https://amable-app-emailable.acme.workers.dev/.well-known/jwks.json');
    expect(resolved.redirect_uris).toEqual(['https://amable-app-emailable.acme.workers.dev/install']);
    expect(resolved.scopes).toEqual(result.manifest.scopes);
    expect(parseAppManifest(resolved).ok).toBe(true);
  });

  it('keeps the placeholder origin for deployed apps only, and the icon off it', () => {
    expect(issuesOf(template({ deployment: undefined })).join()).toMatch(/only for apps with a deployment/);
    expect(issuesOf(template({ jwks_url: 'https://apps.example.com/jwks.json' })).join()).toMatch(/jwks_url: must be under/);
    expect(issuesOf(manifest({ redirect_uris: [`${origin}/install`] })).join()).toMatch(/only for deployed apps/);
    expect(issuesOf(template({ icon_url: `${origin}/icon.png` })).join()).toMatch(/icon/);
    expect(issuesOf(template({ deployment: { ...deployment, bundle_sha256: 'XYZ' } })).join()).toMatch(/SHA-256/);
  });

  it('deploys only released bundles', () => {
    const source = parseAppManifest(template({ deployment: { kind: 'cloudflare_worker', compatibility_date: '2026-10-01' } }));
    expect(source.ok).toBe(true);
    if (source.ok) expect(isDeployableManifest(source.manifest)).toBe(false);
  });

  it('names the resources after the app', () => {
    expect(appWorkerName('timely')).toBe('amable-app-timely');
    expect(appDatabaseName('timely', 'DB')).toBe('amable-app-timely-db');
  });
});

describe('signed catalog', () => {
  async function keyPair() {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString('base64');
    return {
      privateKey: b64((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer),
      publicKey: b64((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    };
  }

  it('verifies the signature and skips entries this release cannot read', async () => {
    const { privateKey, publicKey } = await keyPair();
    const index = {
      format: 1,
      generated_at: '2026-10-17T00:00:00Z',
      apps: [{ manifest: manifest() }, { manifest: { ...manifest(), id: 'future', schema_version: 2 } }],
    };
    const signed = await signCatalogIndex(index, privateKey, 'k1');
    const result = await verifySignedCatalog(signed, { k1: publicKey });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.index.apps.map((a) => a.manifest.id)).toEqual(['emailable']);
      expect(result.invalid.map((i) => i.id)).toEqual(['future']);
    }
  });

  it('rejects tampered payloads and unknown keys', async () => {
    const { privateKey, publicKey } = await keyPair();
    const signed = await signCatalogIndex({ format: 1, generated_at: 'x', apps: [] }, privateKey, 'k1');
    expect(await verifySignedCatalog({ ...signed, payload: signed.payload.replace('"apps":[]', '"apps":[{}]') }, { k1: publicKey })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await verifySignedCatalog(signed, { other: publicKey })).toEqual({ ok: false, reason: 'unknown_key' });
  });
});

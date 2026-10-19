import { EmailProviderError, FakeEmailMarketingProvider } from '@amable/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../src/auth/services';
import { overrideDomainDeps } from '../src/domains/runtime';
import { DomainService, normalizeHostname, siteRoutes, type DomainDeps } from '../src/domains/service';
import { CloudflareZoneAutomation, FakeZoneAutomation, zoneCandidates } from '../src/domains/zone';
import { addMember, createHarness, login, seedTenant, seedUser, stepUp, type Harness } from './helpers/harness';

let h: Harness;
let provider: FakeEmailMarketingProvider;
let seq = 0;

function deps(overrides: Partial<DomainDeps> = {}): DomainDeps {
  return {
    db: h.env.DB,
    provider,
    zone: new FakeZoneAutomation(h.env.DB),
    probeEdge: () => Promise.resolve(false),
    edgeHostname: 'edge.example.net',
    edgeScript: 'amable-edge',
    now: () => h.clock.now,
    newId: () => `dom_${String(++seq)}`,
    ...overrides,
  };
}

beforeEach(async () => {
  h = await createHarness();
  await seedTenant(h, 'acme');
  provider = new FakeEmailMarketingProvider();
});

afterEach(() => {
  overrideDomainDeps(null);
  overrideAuthServices(null);
});

describe('hostnames and routes', () => {
  it('normalizes hostnames and lists zone candidates', () => {
    expect(normalizeHostname('https://Mail.Example.com/path')).toBe('mail.example.com');
    expect(normalizeHostname('localhost')).toBeNull();
    expect(normalizeHostname('10.0.0.1')).toBeNull();
    expect(zoneCandidates('a.b.example.co')).toEqual(['a.b.example.co', 'b.example.co', 'example.co']);
    expect(siteRoutes('www.example.com', ['/offers'])).toEqual([
      'www.example.com/offers',
      'www.example.com/offers/*',
      'www.example.com/health',
      'www.example.com/m/*',
      'www.example.com/b/*',
    ]);
  });
});

describe('domain wizard', () => {
  it('sending domain: provider records, DNS on the zone, verification unblocks sending', async () => {
    const service = new DomainService(deps());
    const domain = await service.add('t_acme', { kind: 'sending', hostname: 'mail.example.com' });
    expect(domain.status).toBe('pending');
    expect(domain.records[0]).toMatchObject({ type: 'TXT', name: 'mail.example.com' });
    const meta = await h.env.DB.prepare(`SELECT value FROM installation_meta WHERE key = 'postshiba_tenant:t_acme'`).first<{ value: string }>();
    expect(meta?.value).toBe('fake-tenant-acme');

    const applied = await service.applyDns('t_acme', domain.id);
    expect(applied.zone_id).toBe('example.com');
    const zone = await h.env.DB.prepare(`SELECT value FROM installation_meta WHERE key = 'dev_zone:example.com'`).first<{ value: string }>();
    expect(JSON.parse(zone?.value ?? '{}')).toMatchObject({ records: [{ type: 'TXT', name: 'mail.example.com' }] });

    expect((await service.verify('t_acme', domain.id)).status).toBe('pending');
    provider.domains.set('mail.example.com', { domain: 'mail.example.com', status: 'verified', records: [] });
    const verified = await service.verify('t_acme', domain.id);
    expect(verified).toMatchObject({ status: 'verified', last_error: null });
    expect(verified.verified_at).not.toBeNull();
  });

  it('tracking and site domains verify through the edge probe after the zone changes', async () => {
    const service = new DomainService(deps());
    const tracking = await service.add('t_acme', { kind: 'tracking', hostname: 'links.example.com' });
    expect(tracking.records).toEqual([{ type: 'CNAME', name: 'links.example.com', value: 'edge.example.net' }]);
    expect((await service.verify('t_acme', tracking.id)).status).toBe('pending');
    await service.applyDns('t_acme', tracking.id);
    expect((await service.verify('t_acme', tracking.id)).status).toBe('verified');

    const site = await service.add('t_acme', { kind: 'app', hostname: 'www.example.com', paths: ['offers/', '/Book'] });
    expect(site.paths).toEqual(['/offers', '/book']);
    expect(site.records).toEqual([]);
    await service.applyDns('t_acme', site.id);
    expect((await service.verify('t_acme', site.id)).status).toBe('verified');

    await expect(service.add('t_acme', { kind: 'app', hostname: 'www.example.com' })).rejects.toMatchObject({ code: 'hostname_taken' });
    await expect(service.add('t_acme', { kind: 'app', hostname: 'x.example.com', paths: ['/m'] })).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('sending domain removal deletes it at the provider; provider failures become API errors', async () => {
    const service = new DomainService(deps());
    const domain = await service.add('t_acme', { kind: 'sending', hostname: 'mail.example.com' });
    await service.remove('t_acme', domain.id);
    expect(provider.domains.has('mail.example.com')).toBe(false);

    provider.addDomain = () => Promise.reject(new EmailProviderError('busy', true, 503));
    await expect(service.add('t_acme', { kind: 'sending', hostname: 'news.example.com' })).rejects.toMatchObject({ status: 503, code: 'email_provider_unavailable' });
    provider.addDomain = () => Promise.reject(new EmailProviderError('taken', false, 409, null, 'hostname_taken'));
    await expect(service.add('t_acme', { kind: 'sending', hostname: 'news.example.com' })).rejects.toMatchObject({ status: 409, code: 'hostname_taken' });
    const rows = await h.env.DB.prepare(`SELECT hostname FROM domains WHERE tenant_id = 't_acme'`).all();
    expect(rows.results).toEqual([]);
  });

  it('never writes a second DMARC policy on the zone', async () => {
    const zone = new FakeZoneAutomation(h.env.DB);
    const dmarc = { type: 'TXT' as const, name: '_dmarc.example.com', value: 'v=DMARC1; p=none;', unlessPrefix: 'v=DMARC1' };
    await zone.upsertRecords('example.com', [{ type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=reject;' }]);
    expect(await zone.upsertRecords('example.com', [dmarc])).toBe(0);
    expect(await zone.upsertRecords('example.com', [{ ...dmarc, name: '_dmarc.mail.example.com' }])).toBe(1);
  });

  it('manual mode refuses DNS automation and probes the hostname', async () => {
    const probed: string[] = [];
    const service = new DomainService(deps({ zone: null, probeEdge: (host) => { probed.push(host); return Promise.resolve(true); } }));
    const tracking = await service.add('t_acme', { kind: 'tracking', hostname: 'links.example.com' });
    await expect(service.applyDns('t_acme', tracking.id)).rejects.toMatchObject({ code: 'automation_unavailable' });
    expect((await service.verify('t_acme', tracking.id)).status).toBe('verified');
    expect(probed).toEqual(['links.example.com']);
  });
});

describe('Cloudflare zone automation (fake HTTP)', () => {
  it('finds the zone, creates missing records and Workers Routes, attaches custom domains', async () => {
    const calls: string[] = [];
    const reply = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    const zone = new CloudflareZoneAutomation('token', (input, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${input.replace('https://api.cloudflare.com/client/v4', '')}`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
      if (input.includes('/zones?name=www.example.com')) return Promise.resolve(reply([]));
      if (input.includes('/zones?name=example.com')) return Promise.resolve(reply([{ id: 'z1', name: 'example.com', account: { id: 'acc' } }]));
      if (input.includes('/dns_records?type=TXT&name=_dmarc')) return Promise.resolve(reply([{ id: 'r2', content: '"v=DMARC1; p=reject"' }]));
      if (input.includes('/dns_records?type=TXT')) return Promise.resolve(reply([{ id: 'r1', content: 'v=spf1 old' }]));
      if (input.includes('/dns_records?type=CNAME')) return Promise.resolve(reply([]));
      if (input.endsWith('/workers/routes') && method === 'GET') return Promise.resolve(reply([{ pattern: 'www.example.com/health' }]));
      return Promise.resolve(reply({}));
    });
    expect(await zone.findZone('www.example.com')).toEqual({ id: 'z1', name: 'example.com' });
    expect(
      await zone.upsertRecords('z1', [
        { type: 'TXT', name: 'mail.example.com', value: 'v=spf1 include:x ~all' },
        { type: 'CNAME', name: 'k._domainkey.mail.example.com', value: 'k.dkim.example.net' },
        { type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=none;', unlessPrefix: 'v=DMARC1' },
      ]),
    ).toBe(2);
    expect(await zone.addWorkerRoutes('z1', ['www.example.com/offers*', 'www.example.com/health'], 'amable-edge')).toBe(1);
    await zone.attachWorkerDomain('z1', 'links.example.com', 'amable-edge');
    expect(calls).toContain('POST /zones/z1/dns_records');
    expect(calls).toContain('POST /zones/z1/workers/routes');
    expect(calls).toContain('PUT /accounts/acc/workers/domains');
  });
});

describe('domain REST API', () => {
  it('requires domains:manage; sending status is readable by marketers', async () => {
    overrideDomainDeps(() => deps());
    const owner = await seedUser(h, { email: 'owner@acme.test' });
    const marketer = await seedUser(h, { email: 'mk@acme.test' });
    await addMember(h, owner.id, 't_acme', 'owner');
    await addMember(h, marketer.id, 't_acme', 'marketer');
    const o = await login(h, owner.email);
    const m = await login(h, marketer.email);
    expect((await m.get('/api/v2/t/acme/domains')).status).toBe(403);
    const status = await m.get('/api/v2/t/acme/domains/sending-status');
    expect(status.body).toMatchObject({ state: 'unverified', can_send: false });

    const input = { kind: 'sending', hostname: 'mail.acme.test' };
    expect((await o.post('/api/v2/t/acme/domains', input)).body.error).toBe('step_up_required');
    await stepUp(h, o);
    const created = await o.post('/api/v2/t/acme/domains', input);
    expect(created.status).toBe(201);
    provider.domains.set('mail.acme.test', { domain: 'mail.acme.test', status: 'verified', records: [] });
    const verified = await o.post(`/api/v2/t/acme/domains/${created.body.id as string}/verify`);
    expect(verified.body.status).toBe('verified');
    const after = await m.get('/api/v2/t/acme/domains/sending-status');
    expect(after.body).toMatchObject({ state: 'verified', can_send: true, verified_domains: ['mail.acme.test'] });
    const list = await o.get('/api/v2/t/acme/domains');
    expect(list.body).toMatchObject({ automation: 'fake' });
  });
});

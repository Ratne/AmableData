import { CloudflareSystemEmailProvider, type SendEmailBindingLike } from '@amable/core';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { oauthKind, providerMatrix, systemEmailKind, systemEmailProvider } from '../../src/providers/select';
import { license } from '../platform/link/helpers';

function env(values: Partial<Record<keyof Env, unknown>>): Env {
  return values as unknown as Env;
}

function fakeBinding(): SendEmailBindingLike & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve({ messageId: 'cf-1' });
    },
  };
}

describe('provider selection (self-hosted defaults need no control plane)', () => {
  it('picks the system email transport from the configuration', () => {
    const binding = fakeBinding();
    expect(systemEmailKind(env({ ENVIRONMENT: 'dev' }))).toBe('console');
    expect(systemEmailKind(env({ ENVIRONMENT: 'production' }))).toBe('unconfigured');
    expect(
      systemEmailKind(env({ ENVIRONMENT: 'production', SYSTEM_EMAIL: binding, SYSTEM_EMAIL_FROM: 'no-reply@crm.example.com' })),
    ).toBe('cloudflare');
    // A binding without a sender is not usable.
    expect(systemEmailKind(env({ ENVIRONMENT: 'production', SYSTEM_EMAIL: binding }))).toBe('unconfigured');
    // Console prints OTP codes: never outside dev, even when asked for.
    expect(systemEmailKind(env({ ENVIRONMENT: 'production', SYSTEM_EMAIL_PROVIDER: 'console' }))).toBe('unconfigured');
    expect(systemEmailKind(env({ ENVIRONMENT: 'dev', SYSTEM_EMAIL_PROVIDER: 'notify' }))).toBe('notify');
  });

  it('sends system emails through the own send_email binding', async () => {
    const binding = fakeBinding();
    const provider = systemEmailProvider(
      env({
        ENVIRONMENT: 'production',
        SYSTEM_EMAIL: binding,
        SYSTEM_EMAIL_FROM: 'no-reply@crm.example.com',
        SYSTEM_EMAIL_FROM_NAME: 'Example CRM',
      }),
    );
    expect(provider).toBeInstanceOf(CloudflareSystemEmailProvider);
    await provider.send({ to: 'ada@example.com', subject: 'Your code', html: '<p>1</p>', text: '1', locale: 'en' });
    expect(binding.sent).toEqual([
      {
        from: { email: 'no-reply@crm.example.com', name: 'Example CRM' },
        to: 'ada@example.com',
        subject: 'Your code',
        html: '<p>1</p>',
        text: '1',
      },
    ]);
  });

  it('fails loudly when nothing is configured', async () => {
    const provider = systemEmailProvider(env({ ENVIRONMENT: 'production' }));
    await expect(
      provider.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't', locale: 'en' }),
    ).rejects.toThrow(/binding named SYSTEM_EMAIL plus SYSTEM_EMAIL_FROM/);
  });

  it('prefers an own Google OAuth app over the central broker', () => {
    expect(oauthKind(env({ ENVIRONMENT: 'production' }))).toBe('unavailable');
    expect(oauthKind(env({ ENVIRONMENT: 'dev' }))).toBe('dev');
    expect(
      oauthKind(env({ ENVIRONMENT: 'production', GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' })),
    ).toBe('google_own_app');
    expect(oauthKind(env({ ENVIRONMENT: 'production', GOOGLE_OAUTH_CLIENT_ID: 'id' }))).toBe('unavailable');
  });

  it('describes a bare self-hosted production install without any platform dependency', () => {
    expect(providerMatrix(env({ ENVIRONMENT: 'production' }))).toEqual({
      offering: 'self_hosted',
      emailMarketing: 'postshiba',
      systemEmail: 'unconfigured',
      quotaGuard: 'allow_all',
      errorReporter: 'local',
      dnsAutomation: 'manual',
      oauth: 'unavailable',
      payments: 'recorded_only',
    });
    expect(
      providerMatrix(
        env({ ENVIRONMENT: 'production', ERROR_REPORTING: 'control_plane', CLOUDFLARE_DNS_API_TOKEN: 'tok' }),
      ),
    ).toMatchObject({ errorReporter: 'local', dnsAutomation: 'cloudflare_api' });
    expect(
      providerMatrix(env({ ENVIRONMENT: 'production', ERROR_REPORTING: 'https://errors.example.com/ingest' })).errorReporter,
    ).toBe('url');
  });

  it('switches to the platform services with a license key', () => {
    const managed = license(env({ ENVIRONMENT: 'production', ERROR_REPORTING: 'control_plane' }));
    expect(providerMatrix(managed)).toMatchObject({
      offering: 'managed',
      systemEmail: 'notify',
      quotaGuard: 'platform_wallet',
      errorReporter: 'control_plane',
      oauth: 'control_plane',
    });
    // An own binding / own OAuth app still wins on a licensed (linked) self-hosted install.
    const linked = license(
      env({
        ENVIRONMENT: 'production',
        SYSTEM_EMAIL: fakeBinding(),
        SYSTEM_EMAIL_FROM: 'no-reply@crm.example.com',
        GOOGLE_OAUTH_CLIENT_ID: 'id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      }),
    );
    expect(providerMatrix(linked)).toMatchObject({ systemEmail: 'cloudflare', oauth: 'google_own_app' });
  });
});

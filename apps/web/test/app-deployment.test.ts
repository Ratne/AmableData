import { t } from '@amable/i18n';
import type { MessageKey } from '@amable/i18n';
import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_TOKEN_URL, DEPLOY_ERRORS } from '../src/features/apps/deployment';

describe('apps deployed into the user Cloudflare account', () => {
  it('opens the Cloudflare token editor with Workers Scripts and D1 edit', () => {
    const url = new URL(CLOUDFLARE_TOKEN_URL);
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/profile/api-tokens');
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys') ?? '[]')).toEqual([
      { key: 'workers_scripts', type: 'edit' },
      { key: 'd1', type: 'edit' },
    ]);
  });

  it('has a readable message for every deployment error, in both languages', () => {
    for (const code of DEPLOY_ERRORS) {
      const key = `apps.deploy.error.${code}` as MessageKey;
      expect(t('en', key)).not.toBe(key);
      expect(t('it', key)).not.toBe(key);
    }
  });
});

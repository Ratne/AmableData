import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { formsEdgeRoutes, payloadFromForm } from '../src/forms/routes';

const env = { ENVIRONMENT: 'dev' } as Env;

describe('edge form routes', () => {
  it('turns a plain HTML form post into a submit payload', () => {
    const params = new URLSearchParams('first_name=Ada&topics=a&topics=b&company_website=&cf-turnstile-response=tok');
    expect(payloadFromForm(params, 'https://www.example.com/contact')).toEqual({
      values: { first_name: 'Ada', topics: ['a', 'b'] },
      hp: '',
      turnstile_token: 'tok',
      meta: { page_url: 'https://www.example.com/contact' },
    });
  });

  it('serves the widget and rejects malformed form references without calling core', async () => {
    const script = await formsEdgeRoutes.request('/forms.js', {}, env);
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(script.headers.get('access-control-allow-origin')).toBe('*');
    const bad = await formsEdgeRoutes.request('/f/acme/bad%20id/config', {}, env);
    expect(bad.status).toBe(404);
  });

  it('answers 503 when the core binding is missing and 415 for other content types', async () => {
    const config = await formsEdgeRoutes.request('/f/acme/form_1/config', {}, env);
    expect(config.status).toBe(503);
    expect(await config.json()).toMatchObject({ error: 'gateway_unavailable' });
    const text = await formsEdgeRoutes.request('/f/acme/form_1', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }, env);
    expect(text.status).toBe(415);
  });
});

import { createAppHandler, kvInstallStore, type PrivateJwk } from '@amable/app-sdk';
import manifest from '../manifest.json';

/**
 * __APP_NAME__ — an AmableData app on Cloudflare Workers.
 *
 * `createAppHandler` already serves the JWKS, the manifest and the install
 * callback, verifies every signed call from the CRM and every screen token.
 * Write your logic in `calls` (hooks, actions, connectors), `onEvent`
 * (webhooks) and `screenApi` (the backend of your iframe screens).
 */

interface Env {
  /** JSON array of private JWKs, active first (amable-app keys secret). */
  APP_KEYS: string;
  INSTALLS: KVNamespace;
}

function page(title: string): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; color: #111; background: transparent; }
      body.dark { color: #eee; }
      label { display: grid; gap: 4px; margin-bottom: 12px; }
      input { font: inherit; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; }
      button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 0; background: #111; color: #fff; cursor: pointer; }
    </style>
  </head>
  <body>
    <form id="settings">
      <label>Greeting <input name="greeting" maxlength="100" /></label>
      <button type="submit">Save</button>
    </form>
    <script type="module" src="/screen.js"></script>
  </body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = createAppHandler({
      appId: manifest.id,
      baseUrl: manifest.base_url,
      keys: JSON.parse(env.APP_KEYS) as PrivateJwk[],
      store: kvInstallStore(env.INSTALLS),
      manifest,
      async onEvent(event, ctx) {
        console.log('event', event['type'], 'from', ctx.install.tenant.slug);
      },
      calls: {
        // contact.validate: answer within 1.5 s or the CRM goes ahead without you.
        '/hooks/validate': async (body) => {
          const email = String((body['values'] as { email?: string } | undefined)?.email ?? '');
          const valid = !email.endsWith('@example.invalid');
          return valid ? { valid } : { valid, reason: 'domain does not receive email', tags: ['Invalid email'] };
        },
        // The app keeps no personal data in this template: nothing to erase or export.
        '/privacy/erasure': async () => ({ ok: true }),
        '/privacy/data': async () => ({ data: [] }),
      },
      screens: {
        '/ui/settings': () => page('Settings'),
      },
      screenApi: {
        '/api/settings': async (req, _session, ctx) => {
          if (req.method === 'POST') {
            const input = (await req.json()) as { greeting?: unknown };
            await ctx.api.data.set('settings', { greeting: String(input.greeting ?? '').slice(0, 100) });
          }
          const stored = await ctx.api.data.get('settings').catch(() => ({ value: {} }));
          return Response.json(stored['value'] ?? {});
        },
      },
    });
    return app.fetch(request);
  },
};

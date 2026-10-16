import type { Env } from '../env';
import { authSealer, googleOAuthProvider } from './select';

/**
 * `GET /oauth/google/callback` — the fixed redirect URI of a bring-your-own
 * Google OAuth app. Only bounces the browser back to the page that started the
 * flow (stored with the one-time state); the code exchange happens when that
 * page calls the module's finish endpoint, behind the usual session guards.
 */
export async function handleGoogleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers });
  const provider = googleOAuthProvider(env, authSealer(env));
  if (provider === null) return new Response('Not Found', { status: 404, headers });
  const target = await provider.callbackRedirect(new URL(request.url).searchParams);
  if (target === null) {
    return new Response('This authorization link is invalid or has expired. Start the connection again.', {
      status: 400,
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(null, { status: 302, headers: { ...headers, location: target } });
}

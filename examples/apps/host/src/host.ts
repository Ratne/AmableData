import type { KeyValue } from '@amable/app-sdk';
import { createWorker as emailable } from '../../emailable/src/app';
import { createWorker as kapso } from '../../kapso/src/app';

/**
 * One Worker for every official app: `https://apps.amabledata.com/<app id>/…`.
 * Each app keeps its own manifest, signing keys and storage; the host only
 * picks the app from the first path segment (static files under
 * `public/<app id>/` are served before it).
 */

export interface Store extends KeyValue {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  INSTALLS: Store;
  EMAILABLE_APP_KEYS: string;
  KAPSO_APP_KEYS: string;
}

interface AppWorker {
  fetch(request: Request, env: { APP_KEYS: string; INSTALLS: Store }): Promise<Response>;
}

export interface HostedApp {
  readonly worker: AppWorker;
  readonly keys: (env: Env) => string;
}

export const APPS: Readonly<Record<string, HostedApp>> = {
  emailable: { worker: emailable(), keys: (env) => env.EMAILABLE_APP_KEYS },
  kapso: { worker: kapso(), keys: (env) => env.KAPSO_APP_KEYS },
};

/** The app's view of the shared namespace: its keys never meet another app's. */
export function prefixedStore(kv: Store, prefix: string): Store {
  return {
    get: (key) => kv.get(`${prefix}${key}`),
    put: (key, value, options) => kv.put(`${prefix}${key}`, value, options),
    delete: (key) => kv.delete(`${prefix}${key}`),
  };
}

export function createHost(apps: Readonly<Record<string, HostedApp>> = APPS) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const id = new URL(request.url).pathname.split('/')[1] ?? '';
      const app = Object.hasOwn(apps, id) ? apps[id] : undefined;
      if (app === undefined) {
        if (id === '' && request.method === 'GET') return Response.json({ apps: Object.keys(apps) });
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      return app.worker.fetch(request, { APP_KEYS: app.keys(env), INSTALLS: prefixedStore(env.INSTALLS, `${id}:`) });
    },
  };
}

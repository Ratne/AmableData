import type { MessageKey } from './catalogs/en';
import { interpolate, type Locale } from './locale';

/**
 * SPA entry: same helpers as the server entry, but catalogs load on demand,
 * one locale per chunk, so the browser downloads only the language in use.
 */

export * from './locale';
export type { MessageKey };

export type Catalog = Readonly<Record<MessageKey, string>>;

const loaded = new Map<Locale, Catalog>();
const pending = new Map<Locale, Promise<Catalog>>();

/** The catalog of `locale` if it has already been loaded. */
export function cachedCatalog(locale: Locale): Catalog | undefined {
  return loaded.get(locale);
}

export function loadCatalog(locale: Locale): Promise<Catalog> {
  const ready = loaded.get(locale);
  if (ready !== undefined) return Promise.resolve(ready);
  let promise = pending.get(locale);
  if (promise === undefined) {
    const load: Promise<Catalog> =
      locale === 'it'
        ? import('./catalogs/it').then((m) => m.it)
        : import('./catalogs/en').then((m) => m.en);
    promise = load.then(
      (catalog) => {
        loaded.set(locale, catalog);
        pending.delete(locale);
        return catalog;
      },
      (error: unknown) => {
        pending.delete(locale);
        throw error;
      },
    );
    pending.set(locale, promise);
  }
  return promise;
}

export function translate(
  catalog: Catalog,
  key: MessageKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  return interpolate(catalog[key], vars);
}

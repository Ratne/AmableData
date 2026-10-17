/** Search params of the consent page; app-initiated installs carry the OAuth request here. */
export interface AppDetailSearch {
  manifest_url?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
}

export interface AuthorizeSearch extends AppDetailSearch {
  app_id?: string;
  tenant?: string;
}

function pick<K extends string>(search: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = search[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

export function validateAppDetailSearch(search: Record<string, unknown>): AppDetailSearch {
  return pick(search, ['manifest_url', 'redirect_uri', 'state', 'code_challenge']);
}

export function validateAuthorizeSearch(search: Record<string, unknown>): AuthorizeSearch {
  return pick(search, ['manifest_url', 'redirect_uri', 'state', 'code_challenge', 'app_id', 'tenant']);
}

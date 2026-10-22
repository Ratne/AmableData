/**
 * The Cloudflare API calls that deploy a Marketplace app into the
 * installation's own account (self-hosted: the token the admin pasted, see
 * deployer.ts). Permissions: Workers Scripts Edit and D1 Edit.
 */

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const CF_API = 'https://api.cloudflare.com/client/v4';

let fetchOverride: FetchFn | null = null;

/** Test hook: routes the Cloudflare API calls and the bundle downloads to a fake (null restores `fetch`). */
export function overrideCloudflareFetch(next: FetchFn | null): void {
  fetchOverride = next;
}

export function deployFetch(): FetchFn {
  return fetchOverride ?? ((input, init) => fetch(input, init));
}

export class CloudflareApiError extends Error {
  override readonly name = 'CloudflareApiError';
  constructor(
    readonly status: number,
    readonly codes: readonly number[],
    message: string,
  ) {
    super(message);
  }

  /** The token was deleted, expired or lacks a permission. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403 || this.codes.includes(10000) || this.codes.includes(9109);
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

export interface CloudflareAccount {
  readonly id: string;
  readonly name: string;
}

export interface WorkerModule {
  readonly name: string;
  readonly code: Uint8Array;
}

export interface WorkerUpload {
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly bindings: ReadonlyArray<
    { type: 'd1'; name: string; id: string } | { type: 'plain_text'; name: string; text: string }
  >;
}

export class CloudflareAppsApi {
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly token: string,
    fetchFn?: FetchFn,
  ) {
    this.fetchFn = fetchFn ?? deployFetch();
  }

  private async call<T>(method: string, path: string, body?: BodyInit | object, okStatuses: number[] = []): Promise<T | null> {
    const isForm = body instanceof FormData;
    const response = await this.fetchFn(`${CF_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined || isForm ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
    });
    if (okStatuses.includes(response.status)) return null;
    const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || envelope === null || !envelope.success) {
      const errors = envelope?.errors ?? [];
      throw new CloudflareApiError(
        response.status,
        errors.map((e) => e.code),
        errors.map((e) => e.message).join('; ') || `Cloudflare API ${String(response.status)}`,
      );
    }
    return envelope.result;
  }

  async tokenActive(): Promise<boolean> {
    try {
      const result = await this.call<{ status: string }>('GET', '/user/tokens/verify');
      return result?.status === 'active';
    } catch (error) {
      if (error instanceof CloudflareApiError && error.unauthorized) return false;
      throw error;
    }
  }

  async accounts(): Promise<CloudflareAccount[]> {
    const result = (await this.call<Array<{ id: string; name: string }>>('GET', '/accounts?per_page=50')) ?? [];
    return result.map((a) => ({ id: a.id, name: a.name }));
  }

  /** The account's `<name>.workers.dev`, null when the account never chose one. */
  async workersSubdomain(accountId: string): Promise<string | null> {
    try {
      const result = await this.call<{ subdomain: string | null }>('GET', `/accounts/${accountId}/workers/subdomain`);
      return result?.subdomain ?? null;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createWorkersSubdomain(accountId: string, subdomain: string): Promise<string> {
    const result = await this.call<{ subdomain: string }>('PUT', `/accounts/${accountId}/workers/subdomain`, { subdomain });
    return result?.subdomain ?? subdomain;
  }

  async findDatabase(accountId: string, name: string): Promise<string | null> {
    const result =
      (await this.call<Array<{ uuid: string; name: string }>>('GET', `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`)) ?? [];
    return result.find((db) => db.name === name)?.uuid ?? null;
  }

  async createDatabase(accountId: string, name: string): Promise<string> {
    const result = await this.call<{ uuid: string }>('POST', `/accounts/${accountId}/d1/database`, { name });
    if (result === null) throw new CloudflareApiError(500, [], 'D1 database not created');
    return result.uuid;
  }

  async deleteDatabase(accountId: string, id: string): Promise<void> {
    await this.call('DELETE', `/accounts/${accountId}/d1/database/${id}`, undefined, [404]);
  }

  async uploadWorker(accountId: string, script: string, main: WorkerModule, upload: WorkerUpload): Promise<void> {
    const form = new FormData();
    form.append(
      'metadata',
      new Blob(
        [
          JSON.stringify({
            main_module: main.name,
            compatibility_date: upload.compatibilityDate,
            compatibility_flags: upload.compatibilityFlags,
            bindings: upload.bindings,
            observability: { enabled: true },
          }),
        ],
        { type: 'application/json' },
      ),
    );
    form.append(main.name, new Blob([main.code as Uint8Array<ArrayBuffer>], { type: 'application/javascript+module' }), main.name);
    await this.call('PUT', `/accounts/${accountId}/workers/scripts/${script}`, form);
  }

  async enableWorkersDev(accountId: string, script: string): Promise<void> {
    await this.call('POST', `/accounts/${accountId}/workers/scripts/${script}/subdomain`, { enabled: true, previews_enabled: false });
  }

  async setSchedules(accountId: string, script: string, crons: readonly string[]): Promise<void> {
    await this.call('PUT', `/accounts/${accountId}/workers/scripts/${script}/schedules`, crons.map((cron) => ({ cron })));
  }

  async deleteWorker(accountId: string, script: string): Promise<void> {
    await this.call('DELETE', `/accounts/${accountId}/workers/scripts/${script}?force=true`, undefined, [404]);
  }
}

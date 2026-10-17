/**
 * Emailable verification API: one email per call, `state` tells the outcome.
 * https://emailable.com/docs/api/#verify-an-email
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type EmailState = 'deliverable' | 'undeliverable' | 'risky' | 'unknown';

export interface Verification {
  readonly state: EmailState;
  readonly reason: string | null;
  readonly score: number | null;
  readonly disposable: boolean;
}

export const VERIFY_URL = 'https://api.emailable.com/v1/verify';
export const ACCOUNT_URL = 'https://api.emailable.com/v1/account';
/** Under the CRM's 1.5 s hook budget, leaving room for our own work. */
export const VERIFY_TIMEOUT_MS = 1_200;

export const TAG_INVALID = 'Invalid email';
export const TAG_RISKY = 'Risky email';
export const TAG_DISPOSABLE = 'Disposable email';

const STATES: readonly EmailState[] = ['deliverable', 'undeliverable', 'risky', 'unknown'];

/** `null` when Emailable did not answer in time or failed: the CRM then goes on without a verdict. */
export async function verifyEmail(
  apiKey: string,
  email: string,
  options: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<Verification | null> {
  const fetcher = options.fetch ?? fetch;
  const query = new URLSearchParams({ email, api_key: apiKey, timeout: '2' });
  try {
    const response = await fetcher(`${VERIFY_URL}?${query.toString()}`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? VERIFY_TIMEOUT_MS),
    });
    // 249: verification still running on Emailable's side.
    if (!response.ok || response.status === 249) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const state = STATES.find((s) => s === body['state']);
    if (state === undefined) return null;
    return {
      state,
      reason: typeof body['reason'] === 'string' ? body['reason'] : null,
      score: typeof body['score'] === 'number' ? body['score'] : null,
      disposable: body['disposable'] === true,
    };
  } catch {
    return null;
  }
}

/** Checks an API key before saving it. */
export async function checkApiKey(apiKey: string, fetcher: Fetch = fetch): Promise<{ ok: boolean; credits: number | null }> {
  try {
    const response = await fetcher(`${ACCOUNT_URL}?${new URLSearchParams({ api_key: apiKey }).toString()}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: false, credits: null };
    const body = (await response.json()) as Record<string, unknown>;
    return { ok: true, credits: typeof body['available_credits'] === 'number' ? body['available_credits'] : null };
  } catch {
    return { ok: false, credits: null };
  }
}

/** The answer of the CRM's contact.validate hook for one verification. */
export function hookAnswer(verification: Verification | null): Record<string, unknown> {
  if (verification === null) return { valid: null };
  const tags: string[] = [];
  if (verification.state === 'undeliverable') tags.push(TAG_INVALID);
  if (verification.state === 'risky') tags.push(TAG_RISKY);
  if (verification.disposable) tags.push(TAG_DISPOSABLE);
  return {
    valid: verification.state === 'undeliverable' ? false : verification.state === 'deliverable' ? true : null,
    reason: verification.state === 'undeliverable' ? 'This email address does not receive mail' : null,
    set_fields: { email_status: verification.state },
    tags,
    entity_data: { score: verification.score, reason: verification.reason, disposable: verification.disposable },
  };
}

/** Runs `work` over `items` with at most `limit` in flight; items not started before `deadline` get `fallback`. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  deadline: number,
  work: (item: T) => Promise<R>,
  fallback: (item: T) => R,
  now: () => number = Date.now,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index]!;
      out[index] = now() >= deadline ? fallback(item) : await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

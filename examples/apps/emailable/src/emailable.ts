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
  /** Emailable's fix for a misspelled address (`mario@gmial.com` → `mario@gmail.com`). */
  readonly didYouMean: string | null;
}

/** One call's outcome: `pending` is Emailable's 249 (ask again later, free for 5 minutes). */
export type VerifyResult =
  | { readonly kind: 'done'; readonly verification: Verification }
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly status: number; readonly message: string };

export const VERIFY_URL = 'https://api.emailable.com/v1/verify';
export const ACCOUNT_URL = 'https://api.emailable.com/v1/account';
/** Under the CRM's 1.5 s hook budget, leaving room for our own work. */
export const VERIFY_TIMEOUT_MS = 1_200;

export const TAG_INVALID = 'Invalid email';
export const TAG_RISKY = 'Risky email';
export const TAG_DISPOSABLE = 'Disposable email';

const STATES: readonly EmailState[] = ['deliverable', 'undeliverable', 'risky', 'unknown'];

const auth = (apiKey: string) => ({ authorization: `Bearer ${apiKey}` });

/**
 * Asks Emailable once. `waitSeconds` is how long Emailable may work before
 * answering 249 (2–10); `timeoutMs` is how long we wait for any answer.
 */
export async function requestVerification(
  apiKey: string,
  email: string,
  options: { fetch?: Fetch; timeoutMs?: number; waitSeconds?: number } = {},
): Promise<VerifyResult> {
  const fetcher = options.fetch ?? fetch;
  const query = new URLSearchParams({ email, timeout: String(options.waitSeconds ?? 2) });
  let response: Response;
  try {
    response = await fetcher(`${VERIFY_URL}?${query.toString()}`, {
      headers: auth(apiKey),
      signal: AbortSignal.timeout(options.timeoutMs ?? VERIFY_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed', status: 0, message: 'Emailable did not answer in time' };
  }
  if (response.status === 249) return { kind: 'pending' };
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null);
  if (!response.ok)
    return {
      kind: 'failed',
      status: response.status,
      message: text('message') ?? `HTTP ${String(response.status)}`,
    };
  const state = STATES.find((s) => s === body['state']);
  if (state === undefined)
    return { kind: 'failed', status: 502, message: 'unexpected answer from Emailable' };
  return {
    kind: 'done',
    verification: {
      state,
      reason: text('reason'),
      score: typeof body['score'] === 'number' ? body['score'] : null,
      disposable: body['disposable'] === true,
      didYouMean: text('did_you_mean'),
    },
  };
}

/** `null` when Emailable did not answer in time or failed: the CRM then goes on without a verdict. */
export async function verifyEmail(
  apiKey: string,
  email: string,
  options: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<Verification | null> {
  const result = await requestVerification(apiKey, email, options);
  return result.kind === 'done' ? result.verification : null;
}

/**
 * Checks an API key before saving it: `rejected` only when Emailable refuses
 * the key (401/403), `unavailable` when it could not answer.
 */
export async function checkApiKey(
  apiKey: string,
  fetcher: Fetch = fetch,
): Promise<{ status: 'ok' | 'rejected' | 'unavailable'; credits: number | null }> {
  try {
    const response = await fetcher(ACCOUNT_URL, {
      headers: auth(apiKey),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 || response.status === 403) return { status: 'rejected', credits: null };
    if (!response.ok) return { status: 'unavailable', credits: null };
    const body = (await response.json()) as Record<string, unknown>;
    return {
      status: 'ok',
      credits: typeof body['available_credits'] === 'number' ? body['available_credits'] : null,
    };
  } catch {
    return { status: 'unavailable', credits: null };
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
    valid:
      verification.state === 'undeliverable'
        ? false
        : verification.state === 'deliverable'
          ? true
          : null,
    reason:
      verification.state !== 'undeliverable'
        ? null
        : verification.didYouMean === null
          ? 'This email address does not receive mail'
          : `This email address does not receive mail. Did you mean ${verification.didYouMean}?`,
    set_fields: { email_status: verification.state },
    tags,
    entity_data: {
      score: verification.score,
      reason: verification.reason,
      disposable: verification.disposable,
      did_you_mean: verification.didYouMean,
    },
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

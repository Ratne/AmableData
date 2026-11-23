/**
 * Step-up for every API call of the app: a `403 step_up_required` answer is
 * held while the mounted prompt (`StepUpProvider`) asks for the second
 * factor, then the same request is sent again. Feature clients only have to
 * send their requests through `stepUpFetch`; the caller sees either the
 * retried response or, when the user cancels, the original 403.
 */

const STEP_UP_REQUIRED = 'step_up_required';

/** Resolves `true` once the second factor was verified, `false` if the user gave up. */
export type StepUpPrompt = () => Promise<boolean>;

let prompt: StepUpPrompt | null = null;
let inflight: Promise<boolean> | null = null;
/** Server time until which the last step-up is accepted (0 = none known). */
let validUntil = 0;
/** Margin for the request's travel time and a slightly late client clock. */
const VALIDITY_MARGIN_MS = 15_000;

/** Installs the prompt (one per app); returns the uninstaller. */
export function registerStepUpPrompt(next: StepUpPrompt): () => void {
  prompt = next;
  return () => {
    if (prompt === next) prompt = null;
  };
}

/** Records how long the server accepts the current step-up (`/api/me` or a verify answer). */
export function noteStepUp(until: number | null | undefined): void {
  validUntil = typeof until === 'number' && Number.isFinite(until) ? until : 0;
}

/**
 * Asks for the second factor before a sensitive action, unless a recent
 * step-up still holds, so the action is sent once instead of failing with a
 * 403 first. False when the user gave up. Without a mounted prompt the
 * request goes ahead and the server decides.
 */
export async function requestStepUp(): Promise<boolean> {
  if (Date.now() < validUntil - VALIDITY_MARGIN_MS) return true;
  const ask = prompt;
  if (ask === null) return true;
  return askOnce(ask);
}

/** True for the API error code, whatever client error class carries it. */
export function isStepUpRequired(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === STEP_UP_REQUIRED) return true;
  return 'error' in error && error.error === STEP_UP_REQUIRED;
}

async function answersStepUp(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return isStepUpRequired(body);
}

/** Bodies that can be sent twice (streams cannot). */
function replayable(init: RequestInit | undefined): boolean {
  const body = init?.body;
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

/** Concurrent requests share one prompt: the user verifies once. */
function askOnce(ask: StepUpPrompt): Promise<boolean> {
  inflight ??= ask()
    .catch(() => false)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function stepUpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  const ask = prompt;
  if (ask === null || !replayable(init) || !(await answersStepUp(response))) return response;
  if (!(await askOnce(ask))) return response;
  return fetch(input, init);
}

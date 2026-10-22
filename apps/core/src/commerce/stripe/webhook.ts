import type { StripePaymentIntent, StripeSetupIntent } from './client';

/** Maximum age of a signed webhook (replay window). */
export const WEBHOOK_TOLERANCE_MS = 300_000;

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export interface StripeCharge {
  id: string;
  object: 'charge';
  payment_intent: string | null;
  amount_refunded: number;
  currency: string;
  refunds?: { data: Array<{ id: string; amount: number; status: string; reason: string | null }> };
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signStripePayload(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${String(timestamp)}.${payload}`)));
}

/**
 * Checks the `Stripe-Signature` header (`t=…,v1=…[,v1=…]`): HMAC-SHA256 of
 * `t.payload` with the endpoint secret, within the replay window.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  now: number,
): Promise<boolean> {
  if (header === null) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === undefined || value === undefined) continue;
    if (key.trim() === 't') timestamp = Number(value);
    else if (key.trim() === 'v1') signatures.push(value.trim());
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now - timestamp * 1000) > WEBHOOK_TOLERANCE_MS) return false;
  const expected = await signStripePayload(secret, timestamp, payload);
  return signatures.some((s) => timingSafeEqual(s, expected));
}

export function parseStripeEvent(payload: string): StripeEvent | null {
  try {
    const parsed = JSON.parse(payload) as Partial<StripeEvent>;
    if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string') return null;
    if (typeof parsed.data !== 'object' || parsed.data === null) return null;
    return parsed as StripeEvent;
  } catch {
    return null;
  }
}

export const asPaymentIntent = (event: StripeEvent): StripePaymentIntent =>
  event.data.object as unknown as StripePaymentIntent;
export const asSetupIntent = (event: StripeEvent): StripeSetupIntent =>
  event.data.object as unknown as StripeSetupIntent;
export const asCharge = (event: StripeEvent): StripeCharge =>
  event.data.object as unknown as StripeCharge;

/**
 * Who is looking at a timer: a CRM contact (`c:<id>`) or an anonymous browser
 * (`v:<uuid>`). Pages learn the contact from a token the email link appends
 * (`tly`), signed per campaign so it cannot be forged or reused elsewhere.
 */

export const CONTACT_ID = /^[A-Za-z0-9_-]{4,64}$/;
export const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Subject = { readonly kind: 'contact'; readonly id: string } | { readonly kind: 'visitor'; readonly id: string };

export const subjectKey = (subject: Subject) => `${subject.kind === 'contact' ? 'c' : 'v'}:${subject.id}`;

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (key === undefined) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keys.set(secret, key);
  }
  return key;
}

function base64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signature(secret: string, publicId: string, contactId: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`timely:${publicId}:${contactId}`));
  return base64url(mac).slice(0, 22);
}

export async function contactToken(secret: string, publicId: string, contactId: string): Promise<string> {
  return `${contactId}.${await signature(secret, publicId, contactId)}`;
}

/** The contact id of a token signed with any of `secrets` for this campaign, null otherwise. */
export async function readContactToken(
  secrets: string | readonly string[],
  publicId: string,
  token: string | null,
): Promise<string | null> {
  if (token === null) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const contactId = token.slice(0, dot);
  if (!CONTACT_ID.test(contactId)) return null;
  const given = token.slice(dot + 1);
  for (const secret of typeof secrets === 'string' ? [secrets] : secrets) {
    const expected = await signature(secret, publicId, contactId);
    if (given.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
    if (diff === 0) return contactId;
  }
  return null;
}

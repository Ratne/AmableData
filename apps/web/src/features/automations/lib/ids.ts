/** Ids of nodes, steps, branches and edges: `[A-Za-z0-9_-]{1,64}`, stable across versions. */

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomSuffix(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length] ?? 'x';
  return out;
}

/** A fresh id with a readable prefix that is not in `taken`. */
export function uniqueId(prefix: string, taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `${prefix}_${randomSuffix()}`;
    if (!taken.has(id)) return id;
  }
}

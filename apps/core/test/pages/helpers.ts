import type { Env } from '../../src/env';

/** In-memory R2 bucket (put / get / delete) for media tests. */
export function fakeR2(): Env['FILES'] & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    objects,
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string) {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      objects.set(key, new Uint8Array(bytes));
      return { key };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      return { body: new Response(bytes).body, size: bytes.byteLength };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return bucket as unknown as Env['FILES'] & { objects: Map<string, Uint8Array> };
}

import Argon2 from '@phi-ag/argon2';
import argon2Wasm from '@phi-ag/argon2/argon2.wasm';
import { createArgon2idHasher, type PasswordHasher } from '@amable/auth';

/**
 * Argon2id engine for the Workers runtime. The precompiled WebAssembly module
 * is imported by the bundler (runtime compilation from bytes is forbidden in
 * Workers) and instantiated once per isolate.
 */
let engine: Argon2 | null = null;

export function createWorkerPasswordHasher(pepper: string): PasswordHasher {
  engine ??= new Argon2(new WebAssembly.Instance(argon2Wasm, {}));
  return createArgon2idHasher({ engine, pepper });
}

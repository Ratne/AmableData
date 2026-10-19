import type { EmailSendRequest } from '@amable/core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { SYSTEM_ACTOR, type CrmActor } from '../../src/crm/context';
import { runCrmOp } from '../../src/crm/ops';
import type { Env } from '../../src/env';
import { consumeEsignSeal } from '../../src/esign/queue';
import { ESIGN_SEAL_QUEUE, type EsignCall, type EsignSealMessage } from '../../src/esign/runner';
import { createTestTenant, type TestTenant } from '../crm/helpers';

/** 1×1 PNG: page previews and signature images in tests. */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
export const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

export async function samplePdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Service agreement — page ${String(i + 1)}`, { x: 60, y: 780, size: 14, font });
  }
  return doc.save();
}

/**
 * TENANT_DB stand-in whose ops share the tenant's test clock, so requests
 * created over HTTP and the timers run by `runEsignDue` agree on "now".
 */
export function clockedTenantDb(): { namespace: Env['TENANT_DB']; tenant(id: string): TestTenant } {
  const tenants = new Map<string, TestTenant>();
  const tenant = (id: string): TestTenant => {
    let found = tenants.get(id);
    if (found === undefined) {
      found = createTestTenant();
      tenants.set(id, found);
    }
    return found;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      const current = tenant(id);
      const now = () => {
        current.clock.now += 1;
        return current.clock.now;
      };
      return {
        crm: (op: string, actor: CrmActor, input: unknown) =>
          Promise.resolve(
            structuredClone(
              runCrmOp(
                { db: current.db, searchMode: current.mode, now },
                actor,
                op,
                structuredClone(input),
              ),
            ),
          ),
      };
    },
  };
  return { namespace: namespace as unknown as Env['TENANT_DB'], tenant };
}

/** The alarm's op runner (system actor, throws on errors). */
export function systemCall(tenant: TestTenant): EsignCall {
  return (op, input) => tenant.op(op, input, SYSTEM_ACTOR);
}

/** In-memory R2 with the subset of the API the signature module uses. */
export function memoryBucket(): Env['FILES'] & {
  objects: Map<string, { bytes: Uint8Array; type: string | undefined }>;
} {
  const objects = new Map<string, { bytes: Uint8Array; type: string | undefined }>();
  const toBytes = (value: ArrayBuffer | ArrayBufferView | string): Uint8Array =>
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value.slice(0))
        : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  const bucket = {
    objects,
    put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      objects.set(key, { bytes: toBytes(value), type: options?.httpMetadata?.contentType });
      return Promise.resolve({ key });
    },
    get(key: string) {
      const object = objects.get(key);
      if (object === undefined) return Promise.resolve(null);
      return Promise.resolve({
        key,
        size: object.bytes.byteLength,
        httpMetadata: { contentType: object.type },
        get body() {
          return new Response(object.bytes).body;
        },
        arrayBuffer: () => Promise.resolve(object.bytes.slice().buffer),
      });
    },
    delete(key: string) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
  return bucket as unknown as Env['FILES'] & { objects: typeof objects };
}

/** Engine namespace that only counts kicks. */
export function fakeEngine(): { namespace: Env['ENGINE']; kicks: string[] } {
  const kicks: string[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      kick: (tenantId: string) => {
        kicks.push(tenantId);
        return Promise.resolve();
      },
    }),
  };
  return { namespace: namespace as unknown as Env['ENGINE'], kicks };
}

export function emailText(message: EmailSendRequest): string {
  return `${message.content.subject}\n${JSON.stringify(message.content.body)}`;
}

/** Signing token of the link in an invitation / reminder. */
export function signingToken(message: EmailSendRequest): string {
  const match = /\/sign\/[a-z0-9-]+\/([A-Za-z0-9_-]{32,64})/.exec(emailText(message));
  if (match?.[1] === undefined) throw new Error('no signing link in the email');
  return match[1];
}

/** `esign-seal` stand-in: keeps the jobs until `drain` runs them through the real consumer. */
export function fakeSealQueue(env: Env): {
  queue: NonNullable<Env['ESIGN_SEAL']>;
  pending: EsignSealMessage[];
  drain(): Promise<void>;
} {
  const pending: EsignSealMessage[] = [];
  const queue = {
    send: (body: EsignSealMessage) => {
      pending.push(structuredClone(body));
      return Promise.resolve();
    },
  } as unknown as NonNullable<Env['ESIGN_SEAL']>;
  const drain = async () => {
    const jobs = pending.splice(0);
    const acked: string[] = [];
    await consumeEsignSeal(
      {
        queue: ESIGN_SEAL_QUEUE,
        messages: jobs.map((body, i) => ({
          id: String(i),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack: () => acked.push(String(i)),
          retry: () => undefined,
        })),
        ackAll: () => undefined,
        retryAll: () => undefined,
      } as unknown as MessageBatch<unknown>,
      env,
    );
    if (acked.length !== jobs.length) throw new Error('sealing job left unacknowledged');
  };
  return { queue, pending, drain };
}

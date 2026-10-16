/**
 * Streaming gzip JSONL to / from R2 without holding the whole file in memory.
 * R2 needs a known length for a single put, so output is buffered into fixed
 * size multipart parts (all parts but the last must have the same size).
 */

/** R2 minimum part size is 5 MiB. */
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const LINE_BATCH_CHARS = 64 * 1024;
const MAX_LINE_CHARS = 32 * 1024 * 1024;

export interface JsonlGzipWriter {
  write(line: unknown): Promise<void>;
  /** Flushes, completes the upload and returns the compressed size. */
  close(): Promise<number>;
  abort(): Promise<void>;
}

export function createR2JsonlGzipWriter(
  bucket: R2Bucket,
  key: string,
  options: { customMetadata?: Record<string, string>; partSize?: number } = {},
): JsonlGzipWriter {
  const partSize = options.partSize ?? DEFAULT_PART_SIZE;
  const putOptions = {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: options.customMetadata ?? {},
  };
  const gzip = new CompressionStream('gzip');
  const writer = gzip.writable.getWriter();
  const encoder = new TextEncoder();
  let pending = '';
  let chunks: Uint8Array[] = [];
  let buffered = 0;
  let total = 0;
  let upload: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];

  const takeBytes = (size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = chunks[0] as Uint8Array;
      const need = size - offset;
      if (chunk.length <= need) {
        out.set(chunk, offset);
        offset += chunk.length;
        chunks.shift();
      } else {
        out.set(chunk.subarray(0, need), offset);
        chunks[0] = chunk.subarray(need);
        offset += need;
      }
    }
    buffered -= size;
    return out;
  };

  const uploadPart = async (bytes: Uint8Array): Promise<void> => {
    upload ??= await bucket.createMultipartUpload(key, putOptions);
    parts.push(await upload.uploadPart(parts.length + 1, bytes));
  };

  const pump = (async () => {
    const reader = gzip.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        buffered += value.length;
        total += value.length;
        while (buffered >= partSize) await uploadPart(takeBytes(partSize));
      }
    } catch (error) {
      // Cancelling the readable side errors the writable side: pending writes reject instead of hanging.
      await reader.cancel(error).catch(() => undefined);
      throw error;
    }
  })();
  // Errors surface from close(); this only prevents an unhandled rejection.
  pump.catch(() => undefined);

  const flushText = async (): Promise<void> => {
    if (pending === '') return;
    const text = pending;
    pending = '';
    await writer.write(encoder.encode(text));
  };

  return {
    async write(line: unknown): Promise<void> {
      pending += `${JSON.stringify(line)}\n`;
      if (pending.length >= LINE_BATCH_CHARS) await flushText();
    },
    async close(): Promise<number> {
      await flushText();
      await writer.close();
      await pump;
      const rest = takeBytes(buffered);
      if (upload === null) {
        await bucket.put(key, rest, putOptions);
      } else {
        if (rest.length > 0) await uploadPart(rest);
        await (upload as R2MultipartUpload).complete(parts);
      }
      chunks = [];
      return total;
    },
    async abort(): Promise<void> {
      await writer.abort().catch(() => undefined);
      await pump.catch(() => undefined);
      if (upload !== null) await (upload as R2MultipartUpload).abort().catch(() => undefined);
      chunks = [];
    },
  };
}

/** Parsed lines of a gzip JSONL stream, one at a time. */
export async function* readJsonlGzip(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let carry = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (carry + value).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() !== '') yield JSON.parse(line) as unknown;
      }
      if (carry.length > MAX_LINE_CHARS) throw new Error('backup: line too long');
    }
    if (carry.trim() !== '') yield JSON.parse(carry) as unknown;
  } finally {
    reader.releaseLock();
  }
}

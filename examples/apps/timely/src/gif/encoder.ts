/**
 * GIF89a encoder for indexed frames. Each frame may cover only a sub-rectangle
 * of the canvas (what changed since the previous one), which keeps a
 * 60-second countdown small and cheap to build: only the seconds move.
 */

export interface GifFrame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Palette indices, row by row (`width * height`). */
  readonly pixels: Uint8Array;
  /** Hundredths of a second. */
  readonly delay: number;
}

class ByteWriter {
  private buffer = new Uint8Array(4096);
  length = 0;

  private grow(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  byte(value: number): void {
    this.grow(1);
    this.buffer[this.length++] = value & 0xff;
  }

  word(value: number): void {
    this.byte(value);
    this.byte(value >> 8);
  }

  bytes(values: ArrayLike<number>): void {
    this.grow(values.length);
    this.buffer.set(values, this.length);
    this.length += values.length;
  }

  ascii(text: string): void {
    for (let i = 0; i < text.length; i += 1) this.byte(text.charCodeAt(i));
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** Variable-width LZW of GIF, written as 255-byte sub-blocks. */
function lzw(out: ByteWriter, pixels: Uint8Array, minCodeSize: number): void {
  out.byte(minCodeSize);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let dict = new Map<number, number>();

  const block = new Uint8Array(255);
  let blockLength = 0;
  let bits = 0;
  let bitCount = 0;
  const emit = (code: number) => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block[blockLength++] = bits & 0xff;
      bits >>>= 8;
      bitCount -= 8;
      if (blockLength === 255) {
        out.byte(255);
        out.bytes(block);
        blockLength = 0;
      }
    }
  };

  emit(clear);
  let prefix = pixels[0] ?? 0;
  for (let i = 1; i < pixels.length; i += 1) {
    const pixel = pixels[i]!;
    const key = (prefix << 8) | pixel;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next);
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
      next += 1;
    } else {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = end + 1;
    }
    prefix = pixel;
  }
  emit(prefix);
  emit(end);
  if (bitCount > 0) {
    block[blockLength++] = bits & 0xff;
    if (blockLength === 255) {
      out.byte(255);
      out.bytes(block);
      blockLength = 0;
    }
  }
  if (blockLength > 0) {
    out.byte(blockLength);
    out.bytes(block.subarray(0, blockLength));
  }
  out.byte(0);
}

/**
 * `palette` is RGB triplets (up to 256 colors). Frames play once and stop on
 * the last one: a countdown must never loop back to a later time.
 */
export function encodeGif(width: number, height: number, palette: readonly number[], frames: readonly GifFrame[]): Uint8Array {
  const colors = Math.max(2, palette.length / 3);
  let depth = 1;
  while (1 << depth < colors) depth += 1;
  const tableSize = 1 << depth;

  const out = new ByteWriter();
  out.ascii('GIF89a');
  out.word(width);
  out.word(height);
  out.byte(0x80 | ((depth - 1) << 4) | (depth - 1));
  out.byte(0);
  out.byte(0);
  for (let i = 0; i < tableSize * 3; i += 1) out.byte(palette[i] ?? 0);

  for (const frame of frames) {
    out.bytes([0x21, 0xf9, 4, 1 << 2, frame.delay & 0xff, (frame.delay >> 8) & 0xff, 0, 0]);
    out.byte(0x2c);
    out.word(frame.left);
    out.word(frame.top);
    out.word(frame.width);
    out.word(frame.height);
    out.byte(0);
    lzw(out, frame.pixels, Math.max(2, depth));
  }
  out.byte(0x3b);
  return out.result();
}

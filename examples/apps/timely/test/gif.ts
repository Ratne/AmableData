/** A small GIF reader for the tests: checks the structure and decodes every frame's LZW data. */

export interface DecodedFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  delay: number;
  pixels: Uint8Array;
}

export interface DecodedGif {
  width: number;
  height: number;
  palette: number[];
  loops: boolean;
  frames: DecodedFrame[];
}

function lzwDecode(minCodeSize: number, data: Uint8Array, expected: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  let next = end + 1;
  const reset = () => {
    dict = Array.from({ length: clear }, (_, i) => [i]);
    dict[clear] = [];
    dict[end] = [];
    next = end + 1;
    codeSize = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let bitPos = 0;
  const read = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byte = data[(bitPos + i) >> 3] ?? 0;
      code |= ((byte >> ((bitPos + i) & 7)) & 1) << i;
    }
    bitPos += codeSize;
    return code;
  };
  let prev: number | null = null;
  while (bitPos < data.length * 8) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === end) break;
    if (prev === null) {
      out.push(...dict[code]!);
      prev = code;
      continue;
    }
    let entry: number[];
    if (code < next) {
      entry = dict[code]!;
      if (next < 4096) dict[next++] = [...dict[prev]!, entry[0]!];
    } else {
      entry = [...dict[prev]!, dict[prev]![0]!];
      if (next < 4096) dict[next++] = entry;
    }
    out.push(...entry);
    if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    prev = code;
  }
  if (out.length !== expected) throw new Error(`frame decodes to ${String(out.length)} pixels, expected ${String(expected)}`);
  return Uint8Array.from(out);
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const ascii = String.fromCharCode(...bytes.subarray(0, 6));
  if (ascii !== 'GIF89a') throw new Error(`bad signature ${ascii}`);
  const word = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  const width = word(6);
  const height = word(8);
  const packed = bytes[10]!;
  let pos = 13;
  const palette: number[] = [];
  if (packed & 0x80) {
    const size = 3 * (1 << ((packed & 7) + 1));
    palette.push(...bytes.subarray(pos, pos + size));
    pos += size;
  }
  const frames: DecodedFrame[] = [];
  let delay = 0;
  let loops = false;
  const subBlocks = () => {
    const chunks: number[] = [];
    for (;;) {
      const size = bytes[pos++]!;
      if (size === 0) break;
      chunks.push(...bytes.subarray(pos, pos + size));
      pos += size;
    }
    return Uint8Array.from(chunks);
  };
  while (pos < bytes.length) {
    const block = bytes[pos++]!;
    if (block === 0x3b) return { width, height, palette, loops, frames };
    if (block === 0x21) {
      const label = bytes[pos++]!;
      if (label === 0xf9) delay = word(pos + 2);
      if (label === 0xff) loops = true;
      subBlocks();
      continue;
    }
    if (block !== 0x2c) throw new Error(`unknown block 0x${block.toString(16)} at ${String(pos - 1)}`);
    const frame = { left: word(pos), top: word(pos + 2), width: word(pos + 4), height: word(pos + 6) };
    pos += 9;
    const minCodeSize = bytes[pos++]!;
    const pixels = lzwDecode(minCodeSize, subBlocks(), frame.width * frame.height);
    if (frame.left + frame.width > width || frame.top + frame.height > height) throw new Error('frame outside the canvas');
    frames.push({ ...frame, delay, pixels });
  }
  throw new Error('missing trailer');
}

import { MEDIA_CONTENT_TYPES } from '@amable/api-types';

export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

const EXTENSION: Record<MediaContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to));

/**
 * Real type of an uploaded image from its magic bytes (the declared
 * Content-Type and file name are never trusted). SVG is refused: it can carry
 * script and the public media URLs are same-origin with the pages.
 */
export function sniffImageType(bytes: Uint8Array): MediaContentType | null {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const boxSize = Math.min(bytes.length, ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0));
    for (let at = 8; at + 4 <= Math.max(12, boxSize); at += 4) {
      const brand = ascii(bytes, at, at + 4);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
  }
  return null;
}

export function mediaExtension(type: MediaContentType): string {
  return EXTENSION[type];
}

/** Display name kept for the library: no path, no control characters, bounded. */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>]/g, '').trim().slice(0, 200);
  return cleaned === '' ? 'image' : cleaned;
}

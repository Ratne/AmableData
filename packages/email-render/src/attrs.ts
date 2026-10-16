import type { TiptapMark, TiptapNode } from './schema';

/** Typed readers for loosely-typed Tiptap attributes. */

export function attrString(node: TiptapNode | TiptapMark, key: string, fallback = ''): string {
  const value = node.attrs?.[key];
  return typeof value === 'string' ? value : fallback;
}

export function attrNullableString(node: TiptapNode | TiptapMark, key: string): string | null {
  const value = node.attrs?.[key];
  return typeof value === 'string' ? value : null;
}

export function attrNumber(node: TiptapNode | TiptapMark, key: string, fallback: number): number {
  const value = node.attrs?.[key];
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function attrBoolean(node: TiptapNode | TiptapMark, key: string): boolean {
  return node.attrs?.[key] === true;
}

export function attrEnum<T extends string>(
  node: TiptapNode | TiptapMark,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = node.attrs?.[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i;

/** Only literal hex/rgb colors reach inline CSS. */
export function safeColor(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return COLOR_RE.test(trimmed) || RGB_RE.test(trimmed) ? trimmed : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

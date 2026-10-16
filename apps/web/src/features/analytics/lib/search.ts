/** The router JSON-parses search values: `?create=1` or `?code=123` arrive as numbers. */
export function searchString(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

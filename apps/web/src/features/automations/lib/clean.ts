/** Drops keys whose value is `undefined`, so stored JSON only has what the user set. */
export function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

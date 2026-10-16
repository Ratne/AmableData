import { useEffect, useState } from 'react';

/** `value` once it stopped changing for `delayMs`; compared by JSON so new-but-equal objects do not re-run queries. */
export function useStableDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  const serialized = JSON.stringify(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced((current) => (JSON.stringify(current) === serialized ? current : value));
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [serialized, delayMs]);
  return debounced;
}

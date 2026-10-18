import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

type Patch<T> = { [K in keyof T]?: T[K] | undefined };

/** Validated search of a report page plus a patcher (undefined removes a key, history replaced). */
export function useReportSearch<T extends object>(
  validate: (raw: Record<string, unknown>) => T,
): readonly [T, (patch: Patch<T>) => void] {
  const raw: Record<string, unknown> = useSearch({ strict: false });
  const search = useMemo(() => validate(raw), [raw, validate]);
  const navigate = useNavigate();
  const update = useCallback(
    (patch: Patch<T>) => {
      void navigate({
        to: '.',
        replace: true,
        search: (previous: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
          return next;
        },
      } as never);
    },
    [navigate],
  );
  return [search, update] as const;
}

/** Saves `text` as a file through a temporary object URL. */
export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

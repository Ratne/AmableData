import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { parseFolderSearch, type FolderSearch, type FolderSelection } from './lib/tree';

/** Selected folder and the include-subfolders switch, kept in `?folder=` / `?sub=` of the current route. */
export function useFolderSelection(): {
  selection: FolderSelection;
  includeSubfolders: boolean;
  select: (selection: FolderSelection) => void;
  setIncludeSubfolders: (value: boolean) => void;
} {
  const raw: Record<string, unknown> = useSearch({ strict: false });
  const search = useMemo(() => parseFolderSearch(raw), [raw]);
  const navigate = useNavigate();
  const apply = useCallback(
    (patch: Partial<Record<keyof FolderSearch, string | boolean | undefined>>) => {
      void navigate({
        to: '.',
        search: (previous: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
          return next;
        },
      } as never);
    },
    [navigate],
  );
  return {
    selection: search.folder ?? 'all',
    includeSubfolders: search.sub === true,
    select: (selection) => apply({ folder: selection === 'all' ? undefined : selection }),
    setIncludeSubfolders: (value) => apply({ sub: value ? true : undefined }),
  };
}

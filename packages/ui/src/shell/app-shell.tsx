import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from 'react';
import {
  DashboardShell,
  type DashboardShellNavItem,
  type DashboardShellNavSection,
  type DashboardShellStatusTone,
  type DashboardShellTab,
} from '../components/block/dashboard-shell';
import { cn } from '../lib/utils';

/**
 * App-wide layout: one ObsidianUI Dashboard Shell for the whole SPA. Pages do
 * not render the shell themselves; they describe their header with
 * `usePageChrome` (title, status pill, tabs) and render their own toolbar and
 * content with `PageToolbar`/`PageBody` inside the shell's scroll area.
 */

export interface PageChrome {
  readonly title: string;
  readonly status?: string;
  readonly statusTone?: DashboardShellStatusTone;
  readonly tabs?: readonly DashboardShellTab[];
  readonly tab?: string;
}

interface PageChromeState extends PageChrome {
  readonly onTabChange?: (value: string) => void;
}

const PageChromeContext = createContext<((chrome: PageChromeState | null) => void) | null>(null);

/**
 * Declares the current page's header. Only serialisable values are compared,
 * so passing fresh objects on every render does not loop; `onTabChange` is
 * read through a ref and may change freely.
 */
export function usePageChrome(
  chrome: PageChrome & { readonly onTabChange?: (value: string) => void },
): void {
  const setChrome = useContext(PageChromeContext);
  const onTabChange = useRef(chrome.onTabChange);
  onTabChange.current = chrome.onTabChange;
  const key = JSON.stringify([
    chrome.title,
    chrome.status,
    chrome.statusTone,
    chrome.tabs,
    chrome.tab,
  ]);

  useLayoutEffect(() => {
    if (setChrome === null) return;
    const [title, status, statusTone, tabs, tab] = JSON.parse(key) as [
      string,
      string | null,
      DashboardShellStatusTone | null,
      DashboardShellTab[] | null,
      string | null,
    ];
    setChrome({
      title,
      status: status ?? undefined,
      statusTone: statusTone ?? undefined,
      tabs: tabs ?? undefined,
      tab: tab ?? undefined,
      onTabChange: (value) => onTabChange.current?.(value),
    });
    // Layout cleanup runs before the next page's layout effect, so it never wipes the new header.
    return () => setChrome(null);
  }, [key, setChrome]);
}

export interface AppShellProps {
  readonly brand: {
    readonly name: string;
    readonly description?: string;
    readonly logo?: ReactNode;
  };
  readonly navigation: DashboardShellNavSection[];
  readonly secondaryNavigation?: DashboardShellNavItem[];
  readonly sidebarFooter?: ReactNode;
  /** Usually derived from the current route. */
  readonly activeItemId?: string;
  /** Right side of the header: tenant switcher, notifications, user menu. */
  readonly headerActions?: ReactNode;
  /** Router link component (e.g. TanStack Router `Link`); receives `href`. */
  readonly linkComponent?: ElementType;
  readonly navigationLabel?: string;
  /** Title used when the page has not declared one. */
  readonly fallbackTitle?: string;
  /** localStorage key for the resizable sidebar width. */
  readonly sidebarStorageKey?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

function readWidth(key: string): number {
  if (typeof localStorage === 'undefined') return 220;
  const stored = Number(localStorage.getItem(key));
  return Number.isFinite(stored) && stored >= 180 && stored <= 400 ? stored : 220;
}

export function AppShell({
  brand,
  navigation,
  secondaryNavigation,
  sidebarFooter,
  activeItemId,
  headerActions,
  linkComponent,
  navigationLabel,
  fallbackTitle = '',
  sidebarStorageKey = 'amable.sidebar-width',
  className,
  children,
}: AppShellProps) {
  const [chrome, setChrome] = useState<PageChromeState | null>(null);
  const [width, setWidth] = useState(() => readWidth(sidebarStorageKey));

  const onWidthChange = useCallback(
    (next: number) => {
      setWidth(next);
      localStorage.setItem(sidebarStorageKey, String(next));
    },
    [sidebarStorageKey],
  );

  const tabs = useMemo(() => (chrome?.tabs ? [...chrome.tabs] : undefined), [chrome?.tabs]);
  const onTabChange = chrome?.onTabChange;

  return (
    <PageChromeContext.Provider value={setChrome}>
      <DashboardShell
        className={cn('h-dvh', className)}
        brand={brand}
        navigation={navigation}
        secondaryNavigation={secondaryNavigation}
        sidebarFooter={sidebarFooter}
        activeItemId={activeItemId ?? ''}
        title={chrome?.title || fallbackTitle}
        status={chrome?.status}
        statusTone={chrome?.statusTone}
        tabs={tabs}
        tab={tabs ? chrome?.tab : undefined}
        onTabChange={onTabChange}
        headerActions={headerActions}
        linkComponent={linkComponent}
        navigationLabel={navigationLabel}
        sidebarWidth={width}
        onSidebarWidthChange={onWidthChange}
      >
        {children}
      </DashboardShell>
    </PageChromeContext.Provider>
  );
}

/** Filters on the left, actions on the right — same spacing as the shell's own toolbar. */
export function PageToolbar({
  filters,
  actions,
  className,
}: {
  filters?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  if (!filters && !actions) return null;
  return (
    <div
      className={cn('flex shrink-0 flex-wrap items-center justify-between gap-2 p-4', className)}
    >
      {filters ? <div className="flex min-w-0 flex-wrap items-center gap-2">{filters}</div> : null}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-4 pb-6', className)}>{children}</div>;
}

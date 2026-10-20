/**
 * @amable/ui — ObsidianUI blocks + shadcn-compatible components restyled with
 * the ObsidianUI palette, the app shell, the standard list table and the theme.
 *
 * Generic components are imported by path: `@amable/ui/ui/button`,
 * `@amable/ui/ui/dialog`, … and blocks with `@amable/ui/blocks/status-bars`.
 * Stylesheet: `@import "@amable/ui/theme.css";` after Tailwind.
 */

export { cn } from './lib/utils';
export { Toaster } from './components/ui/sonner';
export { toast } from 'sonner';

export {
  isThemePreference,
  readBootPrefs,
  THEME_PREFERENCES,
  writePrefsCookie,
  type BootPrefs,
  type InjectedBootConfig,
  type ResolvedTheme,
  type ThemePreference,
} from './theme/prefs';
export { ThemeProvider, useTheme, type ThemeProviderProps } from './theme/theme-provider';
export {
  PRODUCT_LOGO_URL,
  useTenantBranding,
  type TenantBranding,
} from './theme/branding';

export {
  AppShell,
  PageBody,
  PageToolbar,
  usePageChrome,
  type AppShellProps,
  type PageChrome,
} from './shell/app-shell';

export {
  ListTable,
  type ListTableBulkAction,
  type ListTableColumn,
  type ListTableDeletion,
  type ListTableLabels,
  type ListTableProps,
  type ListTableRowAction,
  type ListTableSort,
  type SortDirection,
} from './list-table/list-table';

export {
  DashboardButton,
  DashboardConfirmDialog,
  DashboardFilterMenu,
  DashboardMenu,
  DashboardMenuContent,
  DashboardMenuItem,
  DashboardMenuLabel,
  DashboardMenuRadioGroup,
  DashboardMenuRadioItem,
  DashboardMenuSeparator,
  DashboardMenuTrigger,
  DashboardPopover,
  DashboardPopoverContent,
  DashboardPopoverTrigger,
  type DashboardButtonProps,
  type DashboardConfirmDialogProps,
  type DashboardFilterMenuProps,
  type DashboardFilterOption,
  type DashboardShellNavItem,
  type DashboardShellNavSection,
  type DashboardShellProps,
  type DashboardShellStatusTone,
  type DashboardShellTab,
} from './components/block/dashboard-shell';

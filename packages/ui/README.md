# @amable/ui

ObsidianUI blocks (Dashboard Shell, Analytics Dashboard, Active Sessions, Status Bars, Flip Text)
and shadcn-compatible components from the ObsidianUI registry, adapted to React 18; the app
shell (`AppShell`, `usePageChrome`), the standard list table (`ListTable`), theme tokens
(`theme.css`, light/dark) and the per-tenant white-label hook (`useTenantBranding`).

- `import { AppShell, ListTable, ThemeProvider } from '@amable/ui'`
- `import { Dialog } from '@amable/ui/ui/dialog'`, `import { StatusBars } from '@amable/ui/blocks/status-bars'`
- CSS: `@import 'tailwindcss'; @import '@amable/ui/theme.css';` plus `@source` on this package.

Adding a registry component: run `npx shadcn@latest add "https://www.obsidianui.dev/r/<name>.json"`
inside this package, then `node scripts/relative-imports.mjs .` and fix React 18 / strict-TS issues.

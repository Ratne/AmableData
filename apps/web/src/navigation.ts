import type { Permission } from '@amable/core';
import type { MessageKey } from '@amable/i18n';
import {
  Activity,
  AtSign,
  BarChart3,
  BookOpen,
  Building2,
  CalendarCheck,
  CalendarDays,
  Code2,
  DatabaseBackup,
  Eye,
  FileText,
  Filter,
  FormInput,
  Gauge,
  Globe,
  KeyRound,
  Layers,
  LayoutDashboard,
  LayoutTemplate,
  Lightbulb,
  LifeBuoy,
  ListChecks,
  Mail,
  MailX,
  Package,
  PenLine,
  Percent,
  Plug,
  Receipt,
  Repeat,
  ScrollText,
  Search,
  Send,
  Settings,
  ShoppingCart,
  SlidersHorizontal,
  Store,
  Tag,
  Target,
  Users,
  Wallet,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

/**
 * Every module of the product, grouped as in the sidebar. Paths are relative
 * to `/t/$tenant`; pages without a real implementation render the placeholder.
 * `permission` hides the item when the active membership lacks it (the server
 * still enforces access on every route).
 */

export interface ModuleDef {
  readonly id: string;
  readonly path: string;
  readonly labelKey: MessageKey;
  readonly icon: LucideIcon;
  readonly permission?: Permission;
}

export interface NavGroupDef {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly modules: readonly ModuleDef[];
}

export const NAV_GROUPS: readonly NavGroupDef[] = [
  {
    id: 'crm',
    titleKey: 'nav.group.crm',
    modules: [
      { id: 'dashboard', path: 'dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
      {
        id: 'contacts',
        path: 'contacts',
        labelKey: 'nav.contacts',
        icon: Users,
        permission: 'contacts:read',
      },
      {
        id: 'companies',
        path: 'companies',
        labelKey: 'nav.companies',
        icon: Building2,
        permission: 'contacts:read',
      },
      {
        id: 'deals',
        path: 'deals',
        labelKey: 'nav.deals',
        icon: Target,
        permission: 'opportunities:read',
      },
      {
        id: 'tasks',
        path: 'tasks',
        labelKey: 'nav.tasks',
        icon: CalendarCheck,
        permission: 'tasks:read',
      },
      { id: 'tags', path: 'tags', labelKey: 'nav.tags', icon: Tag, permission: 'contacts:read' },
      {
        id: 'searches',
        path: 'searches',
        labelKey: 'nav.searches',
        icon: Search,
        permission: 'contacts:read',
      },
    ],
  },
  {
    id: 'marketing',
    titleKey: 'nav.group.marketing',
    modules: [
      {
        id: 'broadcasts',
        path: 'broadcasts',
        labelKey: 'nav.broadcasts',
        icon: Send,
        permission: 'broadcasts:read',
      },
      {
        id: 'automations',
        path: 'automations',
        labelKey: 'nav.automations',
        icon: Workflow,
        permission: 'automations:read',
      },
      {
        id: 'templates',
        path: 'templates',
        labelKey: 'nav.templates',
        icon: Mail,
        permission: 'broadcasts:read',
      },
      {
        id: 'suppressions',
        path: 'suppressions',
        labelKey: 'nav.suppressions',
        icon: MailX,
        permission: 'broadcasts:read',
      },
      {
        id: 'forms',
        path: 'forms',
        labelKey: 'nav.forms',
        icon: FormInput,
        permission: 'forms:read',
      },
      {
        id: 'landing-pages',
        path: 'landing-pages',
        labelKey: 'nav.landingPages',
        icon: LayoutTemplate,
        permission: 'pages:read',
      },
      {
        id: 'bookings',
        path: 'bookings',
        labelKey: 'nav.bookings',
        icon: CalendarDays,
        permission: 'booking:read',
      },
    ],
  },
  {
    id: 'ecommerce',
    titleKey: 'nav.group.ecommerce',
    modules: [
      {
        id: 'orders',
        path: 'orders',
        labelKey: 'nav.orders',
        icon: ShoppingCart,
        permission: 'orders:read',
      },
      {
        id: 'products',
        path: 'products',
        labelKey: 'nav.products',
        icon: Package,
        permission: 'products:read',
      },
      {
        id: 'subscriptions',
        path: 'subscriptions',
        labelKey: 'nav.subscriptions',
        icon: Repeat,
        permission: 'subscriptions:read',
      },
      {
        id: 'promotions',
        path: 'promotions',
        labelKey: 'nav.promotions',
        icon: Percent,
        permission: 'products:read',
      },
      {
        id: 'payments',
        path: 'payments',
        labelKey: 'nav.payments',
        icon: Receipt,
        permission: 'orders:read',
      },
      {
        id: 'invoices',
        path: 'invoices',
        labelKey: 'nav.invoices',
        icon: FileText,
        permission: 'orders:read',
      },
    ],
  },
  {
    id: 'analytics',
    titleKey: 'nav.group.analytics',
    modules: [
      {
        id: 'analytics',
        path: 'analytics',
        labelKey: 'nav.analytics',
        icon: Gauge,
        permission: 'analytics:read',
      },
      {
        id: 'realtime',
        path: 'analytics/realtime',
        labelKey: 'nav.realtime',
        icon: Activity,
        permission: 'analytics:read',
      },
      {
        id: 'insights',
        path: 'analytics/insights',
        labelKey: 'nav.insights',
        icon: Lightbulb,
        permission: 'analytics:read',
      },
      {
        id: 'visitors',
        path: 'analytics/visitors',
        labelKey: 'nav.visitors',
        icon: Eye,
        permission: 'analytics:read',
      },
      {
        id: 'funnels',
        path: 'analytics/funnels',
        labelKey: 'nav.funnels',
        icon: Filter,
        permission: 'analytics:read',
      },
    ],
  },
  {
    id: 'reports',
    titleKey: 'nav.group.reports',
    modules: [
      {
        id: 'reports',
        path: 'reports',
        labelKey: 'nav.reports',
        icon: BarChart3,
        permission: 'reports:read',
      },
      {
        id: 'report-dashboards',
        path: 'reports/dashboards',
        labelKey: 'nav.reportDashboards',
        icon: Layers,
        permission: 'reports:read',
      },
    ],
  },
  {
    id: 'settings',
    titleKey: 'nav.group.settings',
    modules: [
      {
        id: 'settings',
        path: 'settings',
        labelKey: 'nav.settingsGeneral',
        icon: Settings,
        permission: 'settings:manage',
      },
      {
        id: 'members',
        path: 'settings/members',
        labelKey: 'nav.members',
        icon: Users,
        permission: 'users:manage',
      },
      {
        id: 'domains',
        path: 'settings/domains',
        labelKey: 'nav.domains',
        icon: Globe,
        permission: 'domains:manage',
      },
      {
        id: 'custom-fields',
        path: 'settings/custom-fields',
        labelKey: 'nav.customFields',
        icon: SlidersHorizontal,
        permission: 'settings:manage',
      },
      {
        id: 'pipelines',
        path: 'settings/pipelines',
        labelKey: 'nav.pipelines',
        icon: ListChecks,
        permission: 'settings:manage',
      },
      {
        id: 'email-settings',
        path: 'settings/email',
        labelKey: 'nav.emailSettings',
        icon: AtSign,
        permission: 'broadcasts:read',
      },
      {
        id: 'commerce-settings',
        path: 'settings/commerce',
        labelKey: 'nav.commerceSettings',
        icon: Store,
        permission: 'settings:manage',
      },
      {
        id: 'integrations',
        path: 'settings/integrations',
        labelKey: 'nav.integrations',
        icon: Plug,
        permission: 'integrations:manage',
      },
      {
        id: 'api-keys',
        path: 'settings/api-keys',
        labelKey: 'nav.apiKeys',
        icon: KeyRound,
        permission: 'api_keys:manage',
      },
      {
        id: 'webhooks',
        path: 'settings/webhooks',
        labelKey: 'nav.webhooks',
        icon: Webhook,
        permission: 'webhooks:manage',
      },
      {
        id: 'api-docs',
        path: 'settings/api-docs',
        labelKey: 'nav.apiDocs',
        icon: BookOpen,
      },
      {
        id: 'audit-log',
        path: 'settings/audit-log',
        labelKey: 'nav.auditLog',
        icon: ScrollText,
        permission: 'audit:read',
      },
      {
        id: 'backups',
        path: 'settings/backups',
        labelKey: 'nav.backups',
        icon: DatabaseBackup,
        permission: 'tenant:transfer',
      },
      {
        id: 'billing',
        path: 'settings/billing',
        labelKey: 'nav.billing',
        icon: Wallet,
        permission: 'tenant:billing',
      },
    ],
  },
];

export const SECONDARY_MODULES: readonly ModuleDef[] = [
  { id: 'support', path: 'support', labelKey: 'nav.support', icon: LifeBuoy },
  { id: 'ideas', path: 'ideas', labelKey: 'nav.ideas', icon: BookOpen },
];

/** Only in `vite dev` builds. */
export const DEV_MODULES: readonly ModuleDef[] = [
  { id: 'dev-editor', path: 'dev/editor', labelKey: 'nav.devEditor', icon: PenLine },
  { id: 'dev-ui-kit', path: 'dev/ui-kit', labelKey: 'nav.devUiKit', icon: Code2 },
];

export const ALL_MODULES: readonly ModuleDef[] = [
  ...NAV_GROUPS.flatMap((group) => group.modules),
  ...SECONDARY_MODULES,
];

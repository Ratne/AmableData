import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/*
 * CRM pages under /t/$tenant, each in its own lazily loaded chunk. Paths
 * matching a module of navigation.ts replace its placeholder.
 */

/** `?saved=<id>` opens a saved search, `?tag=<id>` filters by one tag. */
export interface RecordListSearch {
  saved?: string;
  tag?: string;
}

function recordListSearch(search: Record<string, unknown>): RecordListSearch {
  return {
    ...(typeof search['saved'] === 'string' ? { saved: search['saved'] } : {}),
    ...(typeof search['tag'] === 'string' ? { tag: search['tag'] } : {}),
  };
}

export const contactsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'contacts',
  validateSearch: recordListSearch,
  component: lazyRouteComponent(() => import('./pages/contacts-list'), 'ContactsListPage'),
});

export const contactImportRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'contacts/import',
  component: lazyRouteComponent(() => import('./pages/import-wizard'), 'ImportWizardPage'),
});

/** Tabs of the contact page, in display order; `?tab=` keeps the open one. */
export const CONTACT_TABS = [
  'activity',
  'tags',
  'notes',
  'tasks',
  'appointments',
  'deals',
  'orders',
  'submissions',
  'emails',
  'automations',
  'journey',
  'marketing',
] as const;
export type FixedContactTab = (typeof CONTACT_TABS)[number];
/** Custom field layout tabs: `cf:<tab id>`, `cf:other` for the ungrouped fields. */
export type CustomFieldContactTab = `cf:${string}`;
export type ContactTab = FixedContactTab | CustomFieldContactTab;

export interface ContactDetailSearch {
  tab?: ContactTab;
}

export const isCustomFieldTab = (value: string): value is CustomFieldContactTab =>
  /^cf:[A-Za-z0-9_-]{1,64}$/.test(value);

function contactDetailSearch(search: Record<string, unknown>): ContactDetailSearch {
  const tab = search['tab'];
  if (typeof tab !== 'string') return {};
  const fixed = CONTACT_TABS.find((value) => value === tab);
  if (fixed !== undefined) return { tab: fixed };
  return isCustomFieldTab(tab) ? { tab } : {};
}

export const contactDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'contacts/$contactId',
  validateSearch: contactDetailSearch,
  component: lazyRouteComponent(() => import('./pages/contact-detail'), 'ContactDetailPage'),
});

export const companiesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'companies',
  validateSearch: recordListSearch,
  component: lazyRouteComponent(() => import('./pages/companies'), 'CompaniesListPage'),
});

export const companyDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'companies/$companyId',
  component: lazyRouteComponent(() => import('./pages/companies'), 'CompanyDetailPage'),
});

export const dealsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'deals',
  component: lazyRouteComponent(() => import('./pages/deals'), 'DealsPage'),
});

export const dealDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'deals/$dealId',
  component: lazyRouteComponent(() => import('./pages/deal-detail'), 'DealDetailPage'),
});

export const tasksRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'tasks',
  component: lazyRouteComponent(() => import('./pages/tasks'), 'TasksPage'),
});

export const tagsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'tags',
  component: lazyRouteComponent(() => import('./pages/tags'), 'TagsPage'),
});

export const searchesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'searches',
  component: lazyRouteComponent(() => import('../search/searches-page'), 'SavedSearchesPage'),
});

export const customFieldsSettingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/custom-fields',
  component: lazyRouteComponent(
    () => import('./pages/custom-fields-settings'),
    'CustomFieldsSettingsPage',
  ),
});

export const pipelinesSettingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/pipelines',
  component: lazyRouteComponent(
    () => import('./pages/pipelines-settings'),
    'PipelinesSettingsPage',
  ),
});

/** Every CRM route, for `featureRoutes` in the app router. */
export const crmRoutes = [
  contactsRoute,
  contactImportRoute,
  contactDetailRoute,
  companiesRoute,
  companyDetailRoute,
  dealsRoute,
  dealDetailRoute,
  tasksRoute,
  tagsRoute,
  searchesRoute,
  customFieldsSettingsRoute,
  pipelinesSettingsRoute,
] as const;

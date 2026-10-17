import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';
import type { InboxView } from './api';

export interface InboxSearch {
  view?: InboxView;
  /** Open conversation. */
  c?: string;
}

const VIEWS: readonly InboxView[] = ['open', 'mine', 'unassigned', 'pending', 'closed'];

export function isInboxView(value: unknown): value is InboxView {
  return typeof value === 'string' && (VIEWS as readonly string[]).includes(value);
}

function validateInboxSearch(search: Record<string, unknown>): InboxSearch {
  return {
    ...(isInboxView(search['view']) ? { view: search['view'] } : {}),
    ...(typeof search['c'] === 'string' && search['c'] !== '' ? { c: search['c'] } : {}),
  };
}

export const inboxRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'conversations',
  validateSearch: validateInboxSearch,
  component: lazyRouteComponent(() => import('./pages/inbox'), 'InboxPage'),
});

export const conversationRoutes = [inboxRoute] as const;
export { VIEWS as INBOX_VIEWS };

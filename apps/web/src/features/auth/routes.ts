import { createRoute, lazyRouteComponent, type AnyRoute, type RouteComponent } from '@tanstack/react-router';
import { LoginPage } from './pages/login';

/**
 * Auth routes, attached to the app's root route by the router:
 *
 *   rootRoute.addChildren([...createAuthRoutes(rootRoute), …])
 *
 * Paths are fixed: the server builds email links to /auth/magic, /auth/reset,
 * /auth/email and /invite (token in the URL fragment).
 *
 * Only the login page is in the entry chunk; the others load on demand.
 */
export function createAuthRoutes(parent: AnyRoute): AnyRoute[] {
  const route = (path: string, component: RouteComponent) =>
    createRoute({ getParentRoute: () => parent, path, component });
  const tokens = () => import('./pages/tokens');
  return [
    route('/login', LoginPage),
    route('/auth/challenge', lazyRouteComponent(() => import('./pages/challenge'), 'ChallengePage')),
    route('/auth/magic', lazyRouteComponent(tokens, 'MagicLinkPage')),
    route('/auth/forgot', lazyRouteComponent(tokens, 'ForgotPasswordPage')),
    route('/auth/reset', lazyRouteComponent(tokens, 'ResetPasswordPage')),
    route('/auth/email', lazyRouteComponent(tokens, 'EmailConfirmPage')),
    route('/invite', lazyRouteComponent(() => import('./pages/invite'), 'InvitePage')),
    // Standalone for now; the shell can re-parent it under its settings layout.
    route('/account/security', lazyRouteComponent(() => import('./pages/security'), 'SecurityPage')),
  ];
}

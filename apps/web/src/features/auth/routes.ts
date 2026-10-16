import { createRoute, type AnyRoute } from '@tanstack/react-router';
import type { JSX } from 'react';
import { ChallengePage } from './pages/challenge';
import { InvitePage } from './pages/invite';
import { LoginPage } from './pages/login';
import { SecurityPage } from './pages/security';
import { EmailConfirmPage, ForgotPasswordPage, MagicLinkPage, ResetPasswordPage } from './pages/tokens';

/**
 * Auth routes, attached to the app's root route by the router:
 *
 *   rootRoute.addChildren([...createAuthRoutes(rootRoute), …])
 *
 * Paths are fixed: the server builds email links to /auth/magic, /auth/reset,
 * /auth/email and /invite (token in the URL fragment).
 */
export function createAuthRoutes(parent: AnyRoute): AnyRoute[] {
  const route = (path: string, component: () => JSX.Element) =>
    createRoute({ getParentRoute: () => parent, path, component });
  return [
    route('/login', LoginPage),
    route('/auth/challenge', ChallengePage),
    route('/auth/magic', MagicLinkPage),
    route('/auth/forgot', ForgotPasswordPage),
    route('/auth/reset', ResetPasswordPage),
    route('/auth/email', EmailConfirmPage),
    route('/invite', InvitePage),
    // Standalone for now; the shell can re-parent it under its settings layout.
    route('/account/security', SecurityPage),
  ];
}

export { SecurityPage, LoginPage, ChallengePage, InvitePage };
export { SecondFactorForm } from './pages/challenge';

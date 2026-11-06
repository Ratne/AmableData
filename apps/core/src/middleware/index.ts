/**
 * Public API of the access layer — see obsidian/moduli/auth.md.
 *
 *   const routes = new Hono<AppEnv>();
 *   routes.get('/', requirePermission('contacts:read'), (c) => { getTenant(c); tenantDb(c); … });
 *   app.route('/t/:slug/contacts', routes);   // requireAuth + requireTenant applied by app.ts
 */
export type { AppEnv, AuthContext, TenantContext } from './context';
export {
  requireAuth,
  requireTenant,
  requireAnyPermission,
  requirePermission,
  requireStepUp,
  requireStepUpForSession,
  requireStepUpForSessionWhen,
  optionalAuth,
  getAuth,
  getSessionAuth,
  getTenant,
  tenantDb,
} from './access';
export { audit } from './audit';
export { HttpError, jsonError } from './errors';
export { handleError } from './error-handler';
export { parseJson } from './validate';
export { defer, clientIp, clientCountry } from './request';
export { appOrigin, apiCors, apiSecurityHeaders, csrfProtection, authServices } from './security';

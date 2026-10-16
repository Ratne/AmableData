/**
 * Public API of the access layer — see obsidian/moduli/auth.md.
 *
 *   const routes = new Hono<AppEnv>();
 *   routes.get('/', requirePermission('contacts:read'), (c) => { getTenant(c); tenantDb(c); … });
 *   app.route('/t/:slug/contacts', routes);   // requireAuth + requireTenant applied by app.ts
 */
export type { AppEnv, AuthContext, AuthUser, AuthSession, AuthApiKey, TenantContext } from './context';
export {
  requireAuth,
  requireTenant,
  requirePermission,
  requireStepUp,
  requireStepUpForSession,
  requireStepUpForSessionWhen,
  requireSession,
  optionalAuth,
  getAuth,
  getSessionAuth,
  getTenant,
  tenantDb,
} from './access';
export { audit } from './audit';
export type { AuditDetails } from './audit';
export { HttpError, jsonError } from './errors';
export { handleError } from './error-handler';
export { parseJson } from './validate';
export { defer, clientIp, clientCountry } from './request';
export { allowedOrigins, appOrigin, apiCors, apiSecurityHeaders, csrfProtection, authServices } from './security';

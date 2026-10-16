# features/auth

Auth pages of the SPA (plain Tailwind, theme tokens `bg-background`, `bg-card`,
`border-border`, `text-muted-foreground`, `bg-primary` when the shell defines them).

## Wiring

`routes.ts` exports `createAuthRoutes(parent)`; the router attaches them to the root:

```ts
import { createAuthRoutes } from './features/auth/routes';
rootRoute.addChildren([indexRoute, ...createAuthRoutes(rootRoute), tenantRoute.addChildren([...])]);
```

| Path                | Page                 | Notes                                                     |
| ------------------- | -------------------- | --------------------------------------------------------- |
| `/login`            | `LoginPage`          | password or magic link; Turnstile when required           |
| `/auth/challenge`   | `ChallengePage`      | TOTP / email code / recovery code, or mandatory 2FA setup |
| `/auth/magic`       | `MagicLinkPage`      | `#token=` from the email                                   |
| `/auth/forgot`      | `ForgotPasswordPage` | identical answer for unknown emails                        |
| `/auth/reset`       | `ResetPasswordPage`  | `#token=`, 1 hour, single use                             |
| `/auth/email`       | `EmailConfirmPage`   | confirms an email change                                  |
| `/invite`           | `InvitePage`         | `#token=`, new account or sign-in + accept                |
| `/account/security` | `SecurityPage`       | devices, password, recovery codes, language/theme         |

The email paths are fixed: the server builds links to them. Tokens travel in the
URL fragment (never sent to the server or logged) and are scrubbed on load.

`SecurityPage` is standalone; the shell may re-parent it under its settings
layout. `SecondFactorForm` (exported) is the reusable OTP form; point
`basePath` at `/api/auth/step-up` for a step-up before sensitive actions
(the API answers `403 step_up_required`).

## Conventions

- Every state-changing request sends `x-amable-csrf: 1` (CSRF guard).
- Language comes from `window.__AMABLE__.locale` (injected by the worker) or
  the browser; changing preferences reloads so the server-injected `lang` /
  theme class are applied everywhere.

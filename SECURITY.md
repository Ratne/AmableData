# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Email **security@amabledata.com** with a
description, the affected version (`GET /api/health` shows the schema version) and
steps to reproduce. We acknowledge reports within 3 business days and keep you
informed until a fix is released; we are happy to credit you.

## Supported versions

Security fixes land on the latest release. Managed installations are updated
automatically; self-hosted installations should update by redeploying
(`git pull && pnpm self-host:setup --deploy`).

## Scope

The product in this repository (`apps/`, `packages/`) and its default configuration.
Issues in your own Cloudflare account setup, third-party providers or a modified
deployment are out of scope, but tell us if our defaults make them easy to get wrong.

## Hardening checklist for self-hosted installations

- Keep `PASSWORD_PEPPER`, `AUTH_ENCRYPTION_KEY`, `EMAIL_TOKEN_SECRET` and
  `EDGE_GATEWAY_SECRET` as Wrangler secrets, unique per installation.
- Never deploy with `ENVIRONMENT=dev` (it enables development-only routes).
- Configure Turnstile and use a dedicated Cloudflare account or a minimally scoped
  API token for DNS automation.

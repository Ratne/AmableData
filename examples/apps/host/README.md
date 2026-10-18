# Apps host

One Cloudflare Worker for every official app, at `https://apps.amabledata.com/<app id>`: no
subdomain per app, one deploy. Workspaces find the apps by searching the Marketplace; this Worker
only answers the calls of the installed ones.

Each app stays a separate app: its own manifest (`base_url` = `https://apps.amabledata.com/<id>`),
signing keys (`<ID>_APP_KEYS` secret), and storage (its keys in the shared `INSTALLS` namespace
are prefixed with `<id>:`). The host picks the app from the first path segment; `createAppHandler`
strips the path of `base_url`, so the apps see the same routes as on a Worker of their own.
Static files of each app (screens, icon) are copied to `public/<id>/` and served before the
Worker.

## Add an app

1. Put the app in `examples/apps/<id>` with `base_url` `https://apps.amabledata.com/<id>` and
   the derived `jwks_url`, `redirect_uris`, `icon_url`. Screens load their files and call their
   API with URLs relative to `<base href="<base_url>/">`.
2. Add it to `APPS` in `src/host.ts` and to `apps.json` (the tests check they match).
3. Create its signing key and store it as a secret:

   ```sh
   cd examples/apps/<id> && npx amable-app keys generate
   npx amable-app keys secret | (cd ../host && npx wrangler secret put <ID>_APP_KEYS)
   ```

   Keep a copy of `.amable/keys.json` outside the repository: losing it means rotating the
   app's identity.
4. `pnpm --filter @amable/apps-host run deploy`, run `amable-app test --manifest
   examples/apps/<id>/manifest.json` against production, then open the catalog pull request.

## Commands

```sh
pnpm --filter @amable/apps-host test       # every hosted app through the host, offline
pnpm --filter @amable/apps-host run dev    # builds public/ and starts wrangler dev
pnpm --filter @amable/apps-host run deploy # needs CLOUDFLARE_ACCOUNT_ID of the amabledata.com account
```

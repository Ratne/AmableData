# __APP_NAME__

An [AmableData](https://github.com/Ratne/AmableData) app running on Cloudflare Workers.
Developer guide: [docs/apps](https://github.com/Ratne/AmableData/blob/main/docs/apps/README.md).

## Develop

```sh
npm install
npx wrangler kv namespace create INSTALLS     # copy the id into wrangler.jsonc
npm run dev                                   # http://localhost:8787
```

`create-amable-app` generated your signing key in `.amable/keys.json` and wrote it to `.dev.vars`
for `wrangler dev`. Never commit either file.

To try the app on a development installation, set `base_url` (and the URLs that derive from it)
in `manifest.json` to `http://localhost:8787`, then in the workspace open
**Settings → Apps → Install from URL** with `http://localhost:8787/manifest.json`. The app is
marked "not verified": that is expected for private apps. Run the conformance suite with
`npx amable-app test --manifest manifest.json --local`.

## Deploy

```sh
npx amable-app keys secret | npx wrangler secret put APP_KEYS
npm run deploy
```

Put the Worker URL in `manifest.json` (`base_url`, `jwks_url`, `redirect_uris`, links), check it
with `npm run validate`, then open a pull request on
[amable-apps](https://github.com/Ratne/amable-apps) to list the app in the Marketplace.

## Rotate the signing key

```sh
npx amable-app keys rotate                     # new key first, the old one stays published
npx amable-app keys secret | npx wrangler secret put APP_KEYS && npm run deploy
# a day later
npx amable-app keys prune && npx amable-app keys secret | npx wrangler secret put APP_KEYS && npm run deploy
```

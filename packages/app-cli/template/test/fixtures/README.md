# Fixtures

Recorded answers of the provider your app talks to, one JSON file per case, in a folder per
provider (`test/fixtures/<provider>/<case>.json`). Tests load them with `fixtureFetch` from
`@amable/app-sdk/testing`, so they run offline and fail when your code stops matching what the
provider really sends.

```json
{
  "provider": "acme",
  "description": "List of items, two pages",
  "source": "live",
  "recorded_at": "2026-10-18",
  "request": { "method": "GET", "url": "https://api.acme.com/v1/items" },
  "response": { "status": 200, "body": { "items": [] } }
}
```

- `source: "live"`: recorded from the real API with a test account, through `redact()`
  (API keys, tokens, secrets, emails and phone numbers of real people replaced). Read the file
  before committing it.
- `source: "docs"`: copied from the provider's API reference (`docs_url`) when the case cannot be
  produced with a test account (paid features, Meta review, rare errors).
- Record the errors too: wrong key, out of quota, rate limit, not found, timeouts the provider
  documents. They are the cases that break in production.
- `{param}` in `request.url` matches any path segment; the query string is ignored unless
  `"match_query": true`.

API keys for recording live in your shell environment, never in the repository.

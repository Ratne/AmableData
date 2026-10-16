# @amable/auth

Runtime-agnostic auth and security primitives (WebCrypto only — Workers, Node, browsers).

- `@amable/auth`: Argon2id + pepper (WASM engine injected) with PBKDF2 fallback, password
  policy + k-anonymity breach check, TOTP (RFC 6238), OTP and recovery codes, opaque tokens,
  `SecretBox` (AES-256-GCM), session timing, API keys and scope cap, CSRF check,
  `RateLimiter` / `TurnstileVerifier` contracts, HMAC webhook signatures, `AUTH_POLICY`.
- `@amable/auth/security`: `safeFetch` / `assertSafeUrl` (SSRF), `sanitizeHtml` /
  `sanitizeStyle`, `createSandboxedLiquid`.

Storage and HTTP wiring live in `apps/core/src/auth` and `apps/core/src/middleware`.
No function here performs network I/O unless a `fetchFn` is passed in.

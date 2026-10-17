/**
 * @amable/app-sdk — everything an app backend needs to talk to AmableData:
 *
 * - `discover(origin)`: endpoints and keys of an installation (`/.well-known/amable-apps.json`);
 * - `generateAppKey`, `jwksOf`: the Ed25519 key behind `private_key_jwt` and the `jwks_url` document;
 * - `exchangeCode`, `refreshTokens`: OAuth without client secrets;
 * - `readSignedCall`, `verifySignature`: checks every call the CRM makes to the app;
 * - `verifySessionToken`: who is looking at an app screen;
 * - `createAmableClient`: the CRM API for one installation.
 */
export * from './client';
export * from './discovery';
export * from './handler';
export { randomId } from './encoding';
export * from './keys';
export * from './oauth';
export * from './session';
export * from './signature';

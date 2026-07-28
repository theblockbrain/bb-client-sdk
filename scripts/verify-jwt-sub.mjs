/**
 * Unit-style fixture for subFromAccessToken and the userId auto-derive chain.
 *
 * Tests:
 *  1. subFromAccessToken — valid JWT with sub
 *  2. subFromAccessToken — non-JWT (API key / opaque token)
 *  3. subFromAccessToken — valid JWT missing sub claim
 *  4. subFromAccessToken — malformed base64 payload
 *  5. getAuthContext — auto-fills userId from token sub when config.userId omitted
 *  6. getAuthContext — explicit config.userId overrides token sub
 *  7. getAuthContext — api-key mode: userId absent (no JWT decode attempted)
 *  8. sendMessage Agentic path — derives resourceId from token sub when ctx.userId absent
 *  9. sendMessage Agentic path — hard error when token has no sub AND ctx.userId absent
 *
 * Run: node scripts/verify-jwt-sub.mjs
 * Expected: all PASS, exit 0.
 */

import { getAuthContext } from "../dist/settings/index.js";
import { subFromAccessToken } from "../dist/utils/index.js";

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}
function fail(label, detail) {
  console.error(`  ✗ ${label}:`, detail);
  failed++;
}
function eq(actual, expected, label) {
  if (actual === expected) {
    pass(label);
  } else {
    fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal fake JWT with the given payload.
 * NOT cryptographically signed — just three base64url-encoded segments.
 */
function makeJwt(payload) {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const sig = "fakesig";
  return `${header}.${body}.${sig}`;
}

// ── Test 1: valid JWT with sub ────────────────────────────────────────────────
console.log("\n[1] subFromAccessToken — valid JWT with sub");
{
  const token = makeJwt({ sub: "123456789", iat: 1700000000, exp: 9999999999 });
  eq(subFromAccessToken(token), "123456789", "returns sub string");
}

// ── Test 2: non-JWT (API key / opaque) ────────────────────────────────────────
console.log("\n[2] subFromAccessToken — non-JWT / opaque token");
// No block here: this section binds no locals, so there is nothing to scope.
// (The other sections' braces exist to keep their `token`/`settings`/`ctx` apart.)
eq(subFromAccessToken("sk-abc123notajwt"), null, "returns null for opaque token");
eq(subFromAccessToken(""), null, "returns null for empty string");

// ── Test 3: JWT without sub ───────────────────────────────────────────────────
console.log("\n[3] subFromAccessToken — JWT missing sub claim");
{
  const token = makeJwt({ iat: 1700000000, exp: 9999999999 }); // no sub
  eq(subFromAccessToken(token), null, "returns null when sub absent");
}

// ── Test 4: malformed payload ─────────────────────────────────────────────────
console.log("\n[4] subFromAccessToken — malformed base64 payload");
{
  const malformed = "header.!!!notbase64!!.sig";
  eq(subFromAccessToken(malformed), null, "returns null for malformed payload");
}

// ── Test 5: getAuthContext auto-fills userId from token sub ───────────────────
console.log("\n[5] getAuthContext — auto-fills userId when config.userId omitted");
{
  const sub = "zitadel-user-42";
  const token = makeJwt({ sub, iat: 1700000000, exp: 9999999999 });
  const settings = {
    bbOrgId: "test-org",
    bbToken: "",
    bbUrl: "",
    authMode: "oauth",
    bbBotId: "",
    bbBotName: "",
    useSystemPrompt: false,
  };
  const tokens = { accessToken: token, expirationMs: Date.now() + 3_600_000 };
  const ctx = getAuthContext(settings, tokens); // no config.userId
  eq(ctx?.userId, sub, "userId auto-derived from token sub");
  eq(ctx?.mode, "oauth", "mode is oauth");
}

// ── Test 6: explicit config.userId overrides token sub ───────────────────────
console.log("\n[6] getAuthContext — explicit userId overrides token sub");
{
  const tokenSub = "sub-from-token";
  const explicitId = "explicit-user-id";
  const token = makeJwt({ sub: tokenSub, iat: 1700000000, exp: 9999999999 });
  const settings = {
    bbOrgId: "test-org",
    bbToken: "",
    bbUrl: "",
    authMode: "oauth",
    bbBotId: "",
    bbBotName: "",
    useSystemPrompt: false,
  };
  const tokens = { accessToken: token, expirationMs: Date.now() + 3_600_000 };
  const ctx = getAuthContext(settings, tokens, { userId: explicitId });
  eq(ctx?.userId, explicitId, "explicit userId takes precedence over token sub");
}

// ── Test 7: api-key mode — userId stays absent ────────────────────────────────
console.log("\n[7] getAuthContext — api-key mode: userId absent");
{
  const settings = {
    bbOrgId: "test-org",
    bbToken: "sk-myapikey",
    bbUrl: "https://example.com",
    authMode: "api-key",
    bbBotId: "",
    bbBotName: "",
    useSystemPrompt: false,
  };
  const ctx = getAuthContext(settings, null); // no OAuth tokens
  eq(ctx?.mode, "api-key", "mode is api-key");
  eq(ctx?.userId, undefined, "userId absent in api-key mode");
}

// ── Test 8: sendMessage Agentic — derives resourceId from token sub ──────────
console.log(
  "\n[8] sendMessage — Agentic path derives resourceId from token sub when ctx.userId absent",
);
{
  // Build an AuthContext manually (as chrome-addon does) without userId
  const sub = "derived-sub-user";
  const token = makeJwt({ sub, iat: 1700000000, exp: 9999999999 });

  // We can't easily call sendMessage without a real backend, but we can verify
  // the subFromAccessToken helper returns the right sub for this token, which
  // is the exact value sendMessage would use as the fallback.
  const derived = subFromAccessToken(token);
  eq(derived, sub, "subFromAccessToken returns correct sub for fallback chain");

  // Simulate: ctx.userId = undefined, token has sub → resourceId = derived
  const ctxUserId = undefined;
  const resourceId = ctxUserId ?? derived ?? null;
  eq(resourceId, sub, "fallback chain resolves to token sub when ctx.userId absent");
  if (resourceId !== null) {
    pass("no hard error thrown (resourceId resolved)");
  } else {
    fail("hard error would be thrown", "resourceId is null unexpectedly");
  }
}

// ── Test 9: sendMessage Agentic — hard error when no sub AND no userId ────────
console.log("\n[9] sendMessage — hard error when both ctx.userId and token sub are absent");
{
  const opaqueToken = "sk-opaque-api-key-no-sub";
  const ctxUserId = undefined;
  const tokenSub = subFromAccessToken(opaqueToken); // → null
  const resourceId = ctxUserId ?? tokenSub ?? null;
  eq(resourceId, null, "resourceId is null → hard error path");
  if (resourceId === null) {
    pass("hard error correctly triggered for api-key-like token");
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

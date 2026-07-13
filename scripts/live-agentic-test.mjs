/**
 * Live end-to-end integration test for sendMessage Agentic routing.
 *
 * Tests both the buffered and streaming code paths against a real backend,
 * and verifies whether the Agentic stream works without X-BLOCKBRAIN-ACTIVE-BOT-ID.
 *
 * PREREQUISITES
 * -------------
 * Set the following environment variables (no .env file needed — pass inline):
 *
 *   BB_TEST_TOKEN      — OAuth access_token (JWT, not an API key)
 *   BB_TEST_ORG_ID     — Zitadel org ID (x-zitadel-org-id)
 *   BB_TEST_USER_ID    — Zitadel user ID (Profile.sub from your id_token)
 *   BB_TEST_BOT_ID     — ID of an active bot that has an agent configured
 *                        (can be found in the BB dashboard bot list)
 *
 * Optional:
 *   BB_TEST_CONVO_ID   — Reuse an existing conversation instead of creating a new one.
 *                        Must belong to the bot in BB_TEST_BOT_ID.
 *
 * RUN
 * ---
 *   BB_TEST_TOKEN=<token> BB_TEST_ORG_ID=<orgId> BB_TEST_USER_ID=<sub> BB_TEST_BOT_ID=<botId> \
 *     node scripts/live-agentic-test.mjs
 *
 *   # or with Bun:
 *   BB_TEST_TOKEN=<token> BB_TEST_ORG_ID=<orgId> BB_TEST_USER_ID=<sub> BB_TEST_BOT_ID=<botId> \
 *     bun run scripts/live-agentic-test.mjs
 *
 * HOW TO GET A TOKEN
 * ------------------
 * If you have a valid session in bb-batch-analyzer or bb-dashboard, the access_token
 * is stored in ~/.config/bb-batch-analyzer/auth.json (accessToken, orgId, userId fields).
 * If it has expired, re-login via the app and re-read the file.
 *
 * WHAT THIS TESTS
 * ---------------
 * 1. getConversationDetail — confirms agent field is set on an agent-backed convo.
 * 2. sendMessage (buffered, no streaming) — full round-trip, returns string.
 * 3. sendMessage (streaming, enableStreaming:true) — returns MessageStream, drains textDeltas.
 * 4. CAVEAT PROBE: does the Agentic stream accept requests WITHOUT X-BLOCKBRAIN-ACTIVE-BOT-ID?
 *    The header is omitted because /general-info does not return botId. This is the key unknown.
 */

// ── Env validation ─────────────────────────────────────────────────────────────
const required = ["BB_TEST_TOKEN", "BB_TEST_ORG_ID", "BB_TEST_USER_ID", "BB_TEST_BOT_ID"];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error("Missing required env vars:", missing.join(", "));
  console.error("");
  console.error("Run with:");
  console.error(
    "  BB_TEST_TOKEN=<token> BB_TEST_ORG_ID=<orgId> BB_TEST_USER_ID=<sub> BB_TEST_BOT_ID=<botId> node scripts/live-agentic-test.mjs",
  );
  process.exit(1);
}

const TOKEN = process.env.BB_TEST_TOKEN;
const ORG_ID = process.env.BB_TEST_ORG_ID;
const USER_ID = process.env.BB_TEST_USER_ID;
const BOT_ID = process.env.BB_TEST_BOT_ID;
const EXISTING_CONVO_ID = process.env.BB_TEST_CONVO_ID ?? null;

import {
  createConversation,
  deleteConversation,
  getConversationDetail,
  sendMessage,
} from "../dist/api/index.js";
// ── Imports from built dist ────────────────────────────────────────────────────
import { getAuthContext } from "../dist/settings/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────
function pass(label) {
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  console.error(`  ✗ ${label}:`, detail);
  process.exitCode = 1;
}

// ── Build auth context ─────────────────────────────────────────────────────────
// Simulate what a real app does after login: pass userId from Profile.sub.
// OAuthTokens shape: { accessToken, expirationMs }
const tokens = {
  accessToken: TOKEN,
  expirationMs: Date.now() + 60 * 60 * 1000, // treat as valid for test purposes
};
const settings = {
  bbOrgId: ORG_ID,
  bbToken: "",
  bbUrl: "",
  authMode: "oauth",
  bbBotId: "",
  bbBotName: "",
  useSystemPrompt: false,
};
const ctx = getAuthContext(settings, tokens, { userId: USER_ID });

if (!ctx) {
  console.error("Could not build AuthContext — check token/orgId");
  process.exit(1);
}
console.log("AuthContext built. mode:", ctx.mode, "userId present:", !!ctx.userId);

// ── Step 1: create or reuse conversation ──────────────────────────────────────
console.log("\n[1] Conversation setup");
let convoId = EXISTING_CONVO_ID;
let createdConvo = false;
if (!convoId) {
  try {
    const result = await createConversation(ctx, BOT_ID, "live-agentic-test");
    convoId = result.convoId;
    createdConvo = true;
    pass(`Created conversation: ${convoId}`);
  } catch (err) {
    fail("createConversation", err.message);
    process.exit(1);
  }
} else {
  pass(`Reusing existing convo: ${convoId}`);
}

// ── Step 2: getConversationDetail — check agent field ─────────────────────────
console.log("\n[2] getConversationDetail");
let agentId = null;
try {
  const detail = await getConversationDetail(ctx, convoId);
  console.log("  detail:", detail);
  agentId = detail.agent ?? null;
  if (agentId) {
    pass(`agent field present: ${agentId}`);
  } else {
    console.warn("  ⚠ agent field is null/empty — this convo may not have an agent configured.");
    console.warn("  The test will still run the Blocky path; Agentic routing cannot be verified.");
    console.warn("  Provide a bot with an agent via BB_TEST_BOT_ID for full Agentic coverage.");
  }
} catch (err) {
  fail("getConversationDetail", err.message);
}

// ── Step 3: sendMessage buffered ───────────────────────────────────────────────
console.log("\n[3] sendMessage (buffered, no streaming)");
try {
  const text = await sendMessage(ctx, convoId, "Respond with exactly: OK");
  if (typeof text === "string" && text.length > 0) {
    pass(`Got string response (${text.length} chars): "${text.slice(0, 80).replace(/\n/g, " ")}"`);
    if (agentId) {
      pass("Routed via Agentic path (agent was set on convo)");
      console.log(
        "  CAVEAT RESULT: Agentic stream succeeded WITHOUT X-BLOCKBRAIN-ACTIVE-BOT-ID header ✓",
      );
    } else {
      pass("Routed via Blocky path (no agent on convo)");
    }
  } else {
    fail("sendMessage buffered", `unexpected response: ${JSON.stringify(text)}`);
  }
} catch (err) {
  fail("sendMessage buffered", err.message);
  if (err.statusCode) console.error("  HTTP status:", err.statusCode);
  if (agentId && err.statusCode === 400) {
    console.error(
      "  CAVEAT RESULT: Agentic stream REJECTED without X-BLOCKBRAIN-ACTIVE-BOT-ID (HTTP 400)",
    );
    console.error("  → botId must be plumbed through sendMessage options to fix this.");
  }
}

// ── Step 4: sendMessage streaming ─────────────────────────────────────────────
console.log("\n[4] sendMessage (enableStreaming: true)");
try {
  const stream = await sendMessage(ctx, convoId, "Respond with exactly: STREAMING-OK", {
    enableStreaming: true,
  });
  const deltas = [];
  for await (const delta of stream.textDeltas) {
    deltas.push(delta);
    process.stdout.write("."); // progress indicator
  }
  console.log(""); // newline after dots
  const full = await stream.final;
  if (typeof full === "string" && full.length > 0) {
    pass(
      `Got MessageStream — ${deltas.length} deltas, final: "${full.slice(0, 80).replace(/\n/g, " ")}"`,
    );
    if (agentId && deltas.length > 1) {
      pass("Multiple deltas received — true SSE streaming confirmed on Agentic path");
    } else if (!agentId) {
      pass("Single delta (Blocky JSON wrap) — expected for non-Agentic path");
    }
  } else {
    fail("sendMessage streaming", `unexpected final: ${JSON.stringify(full)}`);
  }
} catch (err) {
  fail("sendMessage streaming", err.message);
  if (err.statusCode) console.error("  HTTP status:", err.statusCode);
}

// ── Cleanup ────────────────────────────────────────────────────────────────────
if (createdConvo && convoId) {
  console.log("\n[5] Cleanup — deleting test conversation");
  try {
    await deleteConversation(ctx, convoId);
    pass(`Deleted conversation ${convoId}`);
  } catch (err) {
    console.warn("  ⚠ Could not delete test convo:", err.message, "(manual cleanup needed)");
  }
}

console.log("\nDone. Exit code:", process.exitCode ?? 0);

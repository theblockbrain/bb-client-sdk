/**
 * The canonical product-analytics taxonomy — the single source of truth.
 *
 * This module is the code form of the KR 2.1 analytics standard (PDEV-7011). It
 * declares WHAT may be emitted; it deliberately contains no transport, no vendor
 * client, and no emit function. That separation is what lets the web app ship
 * instrumentation FIRST, against these names, while the SDK's runtime seam
 * (PDEV-7009) is still being built — and then hand the same events over to the
 * SDK without a rename.
 *
 * INVARIANTS
 * - Event names never encode the surface or the emitter. Those are properties
 *   (`surface`, `emitter`). Forking a name per surface breaks every cross-surface
 *   funnel, because a Mixpanel funnel is an ordered list of NAMES.
 * - snake_case on the wire, object-then-verb, past tense for terminal events.
 * - No PII, ever. No free text of any kind: no prompts, search queries, file
 *   names, display names, note bodies, or error messages. Ids and closed enums
 *   only. See {@link DENIED_PROPERTY_KEYS}.
 * - Closed enums change in ONE change that touches the type, the runtime
 *   allowlist, and the backend classifier together.
 *
 * @see vocabulary.ts for the enums shared with Botticelli's metering plane.
 */

import type { AgentKind, Outcome, Route } from "./vocabulary.js";

// ─────────────────────────────────────────────────────────────────────────────
// Axes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH PRODUCT the user touched. One Mixpanel project is discriminated by this
 * single super-property rather than split per surface, so cross-surface funnels
 * and de-duplicated account MAU work at all.
 */
export const SURFACES = [
  "web_app",
  "outlook_addin",
  "word_addin",
  "web_component",
  "mobile",
  "slack",
] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * WHICH CODEBASE emitted the event. Not redundant with {@link Surface}: during
 * the SDK handover the same `(surface: web_app, event: message_sent)` pair has
 * two possible producers over time, and telling them apart is what lets us prove
 * parity before deleting the native path, detect double counting when both are
 * briefly live, and attribute an instrumentation bug to the right repository.
 *
 * Do NOT infer this from "is `sdk_version` present" — a surface consumes the SDK
 * for auth and transport long before it consumes it for telemetry, so
 * `sdk_version` is populated while the events are still native.
 *
 * The invariant: exactly one emitter per (event, surface, build).
 */
export const EMITTERS = ["web_app_native", "sdk", "backend"] as const;
export type Emitter = (typeof EMITTERS)[number];

/**
 * The coarse SUBJECT MATTER of a conversation.
 *
 * Classified SERVER-SIDE, in the plane where prompt content already lives; the
 * backend returns only this label and the client forwards only this label.
 * Client-side classification is rejected: it would require raw prompt text at the
 * analytics call site.
 *
 * Distinct from {@link Route} — `route` is the kind of action, `chat_topic` is
 * what it was about. Anything unrecognised coerces to `other` (see
 * {@link coerceChatTopic}) so a backend bug cannot leak free text into Mixpanel.
 */
export const CHAT_TOPICS = [
  "it_support",
  "hr",
  "finance",
  "legal",
  "sales",
  "engineering",
  "data_analysis",
  "document_qa",
  "knowledge_lookup",
  "customer_support",
  "other",
] as const;
export type ChatTopic = (typeof CHAT_TOPICS)[number];

/** Version of the {@link CHAT_TOPICS} vocabulary, so it can evolve without breaking history. */
export const TOPIC_TAXONOMY_VERSION = "v1";

/** Role, aligned to Zitadel. A people-profile property, not an event property. */
export const OWNER_PERMISSIONS = ["owner", "org_admin", "member", "viewer"] as const;
export type OwnerPermission = (typeof OWNER_PERMISSIONS)[number];

/** Which kind of bot a conversation ran against. */
export const BOT_KINDS = ["company_gpt", "predefined", "custom"] as const;
export type BotKind = (typeof BOT_KINDS)[number];

/** How the user composed a turn. */
export const INPUT_MODES = ["text", "dictation", "realtime_voice"] as const;
export type InputMode = (typeof INPUT_MODES)[number];

/** What a commercial limit blocked. Pairs with `cb_limit_reached`. */
export const BLOCKED_ACTIONS = ["message", "upload", "workflow"] as const;
export type BlockedAction = (typeof BLOCKED_ACTIONS)[number];

/**
 * How the user authenticated.
 *
 * Includes `api_key` because a server-side consumer (the Slack backend) authenticates
 * that way, and the auth funnel has to be able to tell a machine caller from a human
 * one rather than lumping both into an "other".
 */
export const SIGN_IN_METHODS = ["password", "sso", "oidc", "api_key"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

/** Coarse phase of a failed sign-in. Never error detail. */
export const SIGN_IN_STAGES = ["launch", "parse", "exchange"] as const;
export type SignInStage = (typeof SIGN_IN_STAGES)[number];

/**
 * Why a session ended.
 *
 * Closed rather than free text: an expiry and a deliberate sign-out look identical in
 * a retention curve otherwise, and only one of them is churn.
 */
export const SIGN_OUT_CAUSES = ["user", "expired", "forced"] as const;
export type SignOutCause = (typeof SIGN_OUT_CAUSES)[number];

/** Where a conversation was opened from. */
export const CONVERSATION_ENTRY_POINTS = [
  "new_chat",
  "bot_card",
  "share_link",
  "deep_link",
] as const;
export type ConversationEntryPoint = (typeof CONVERSATION_ENTRY_POINTS)[number];

/** How the user composed the turn's prompt. */
export const PROMPT_SOURCES = ["freeform", "template", "pinned_skill", "suggestion"] as const;
export type PromptSource = (typeof PROMPT_SOURCES)[number];

/**
 * Deployment environment.
 *
 * Named so the super-property and any env-filtering helper cannot drift apart, and
 * so the set is enumerable when building a Lexicon entry.
 */
export const TELEMETRY_ENVS = ["local", "dev", "staging", "prod"] as const;
export type TelemetryEnv = (typeof TELEMETRY_ENVS)[number];

/** Version of THIS taxonomy. Additive changes bump it; history stays intact. */
export const TAXONOMY_VERSION = "v1";

// ─────────────────────────────────────────────────────────────────────────────
// Super-properties
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stamped on EVERY event by the seam, never by a call site.
 *
 * These cannot be backfilled, so they must be complete at emit time. `org_id` and
 * `workspace_id` are the two registered Mixpanel group keys and must be on the
 * EVENT: a group key present only on the user profile does not attribute that
 * user's events to the group.
 */
export interface SuperProperties {
  /** Which product. */
  surface: Surface;
  /** Which codebase emitted this. */
  emitter: Emitter;
  /** Version of that codebase — the app version, or the SDK semver. */
  emitter_version?: string;
  /** Group key: company / tenant. The pseudonymous id, never a display name. */
  org_id?: string;
  /** Group key: client / workspace, the finer B2B tier. Pseudonymous. */
  workspace_id?: string;
  /** Present whenever the SDK is loaded at all, even if it is not emitting. */
  sdk_version?: string;
  /** The surface's own build version. */
  app_version?: string;
  /** Sub-surface breakdown, e.g. `owa`, `desktop_win`, `chrome`. */
  host?: string;
  /** Keeps non-prod out of dashboards. */
  env?: TelemetryEnv;
  /**
   * True for the duration of an admin impersonation session. Usage boards must
   * filter these out by default, or support activity inflates a customer's
   * apparent engagement.
   */
  is_impersonated?: boolean;
  /** One of the four shipped locales, so language is a real dimension. */
  locale?: string;
  /** @see TAXONOMY_VERSION */
  taxonomy_version: string;
}

/** Slowly-changing user attributes. Set via identify traits, not per event. */
export interface PeopleProperties {
  owner_permission?: OwnerPermission;
  plan?: string;
}

/**
 * Mixpanel-reserved and PII property keys that must never be sent.
 *
 * Enforced at the seam rather than by reviewer vigilance. The `$`-prefixed names
 * are Mixpanel's own reserved profile properties; sending them would attach real
 * identity to a deliberately pseudonymous `distinct_id`.
 */
export const DENIED_PROPERTY_KEYS = [
  "$email",
  "$name",
  "$first_name",
  "$last_name",
  "$phone",
  "email",
  "name",
  "display_name",
  "full_name",
  "phone",
  "subject",
  "body",
  "message_text",
  "prompt",
  "query",
  "file_name",
  "filename",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// The core event catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The events observed IDENTICALLY on every surface.
 *
 * Ownership moves but names do not: the web app emits these natively first
 * (`emitter: web_app_native`), then the SDK takes them over (`emitter: sdk`) and
 * every later surface gets them for free. That the names survive the handover is
 * the entire point of declaring them here rather than in a surface.
 *
 * Surface-specific events (Outlook's `draft_inserted`, the web app's
 * `cb_limit_reached`, and so on) are NOT in this map — they live with their
 * surface. Only what the SDK can observe everywhere belongs here.
 */
export interface CoreEventMap {
  // ── auth ──
  sign_in_started: { method: SignInMethod };
  sign_in_completed: {
    method: SignInMethod;
    owner_permission?: OwnerPermission;
    latency_ms?: number;
  };
  /** `stage` is a coarse phase label. Never error detail. */
  sign_in_failed: {
    method: SignInMethod;
    stage?: SignInStage;
    error_code?: string;
  };
  session_token_refreshed: { latency_ms?: number };
  session_token_refresh_failed: { error_code?: string };
  sign_out: { cause: SignOutCause };

  // ── the AI funnel ──
  conversation_started: {
    conversation_id: string;
    route: Route;
    bot_id?: string;
    bot_kind?: BotKind;
    agent_id?: string;
    agent_kind?: AgentKind;
    entry_point?: ConversationEntryPoint;
  };
  message_sent: {
    conversation_id: string;
    message_id: string;
    route: Route;
    /** Server-derived enum only. NEVER the message text. */
    chat_topic?: ChatTopic;
    topic_taxonomy_version?: string;
    model?: string;
    input_mode?: InputMode;
    prompt_source?: PromptSource;
    attachment_count?: number;
    has_knowledge_base?: boolean;
  };
  /** Carries `ttft_ms`, the source of the TTFT p95 SLO. */
  message_first_token: { route: Route; request_id?: string; ttft_ms: number };
  message_completed: {
    route: Route;
    request_id?: string;
    duration_ms?: number;
    outcome: Outcome;
    model?: string;
    reference_count?: number;
  };
  message_failed: { route: Route; stage?: string; error_code?: string };

  // ── stream health ──
  stream_started: { route: Route; request_id?: string; conversation_id?: string };
  stream_stalled: { route: Route; request_id?: string; stall_ms: number };
  stream_dropped: { route: Route; reason?: string };
  stream_reconnect: { route: Route; attempt: number };

  // ── errors ──
  /**
   * A handled error surfaced to the user. Exists so an error can appear INSIDE a
   * funnel as a drop-off reason. A code, never a message and never a stack —
   * crashes and stack traces belong to Sentry.
   */
  error_raised: {
    scope: string;
    error_code?: string;
    request_id?: string;
    is_blocking?: boolean;
  };
  /** HTTP failure. NEVER the response body — scrubbed to status + endpoint. */
  api_error: { status_code: number; endpoint?: string; method?: string };
}

export type CoreEventName = keyof CoreEventMap;
export type CoreEventProps<K extends CoreEventName> = CoreEventMap[K];

/**
 * Every name in {@link CoreEventMap}, as a runtime array.
 *
 * A TypeScript interface is not enumerable at runtime, but the lint rule and the
 * drift tests both need the actual list. The two type assertions below make this
 * array provably exhaustive: add an event to the map without adding it here (or
 * vice versa) and `tsc` fails, so the array cannot silently fall behind the type.
 */
export const CORE_EVENT_NAMES = [
  "sign_in_started",
  "sign_in_completed",
  "sign_in_failed",
  "session_token_refreshed",
  "session_token_refresh_failed",
  "sign_out",
  "conversation_started",
  "message_sent",
  "message_first_token",
  "message_completed",
  "message_failed",
  "stream_started",
  "stream_stalled",
  "stream_dropped",
  "stream_reconnect",
  "error_raised",
  "api_error",
] as const satisfies readonly CoreEventName[];

/** Declared in the map but missing from {@link CORE_EVENT_NAMES}. Must be `never`. */
type MissingFromNames = Exclude<CoreEventName, (typeof CORE_EVENT_NAMES)[number]>;
/** Listed in {@link CORE_EVENT_NAMES} but not declared in the map. Must be `never`. */
type NotInEventMap = Exclude<(typeof CORE_EVENT_NAMES)[number], CoreEventName>;

/**
 * Compile-time proof that {@link CORE_EVENT_NAMES} and {@link CoreEventMap} agree.
 * If either side gains an entry the other lacks, this stops type-checking.
 */
const _namesAreExhaustive: [MissingFromNames, NotInEventMap] extends [never, never]
  ? true
  : { error: "CORE_EVENT_NAMES is out of sync with CoreEventMap" } = true;
void _namesAreExhaustive;

/**
 * The min-event-set: the T1 subset that gates a release.
 *
 * MAU, activation, retention, and the MAU-reconciliation KR are all computable
 * from these alone. A surface that emits everything except these has not shipped
 * instrumentation; a surface that emits only these has.
 *
 * The three T1 events NOT in {@link CoreEventMap} are surface-owned and cannot be
 * observed by the SDK: `session_started`, `first_value_reached`, and
 * `cb_limit_reached`.
 */
export const MIN_EVENT_SET = [
  "sign_in_started",
  "sign_in_completed",
  "sign_in_failed",
  "sign_out",
  "conversation_started",
  "message_sent",
  "message_first_token",
  "message_completed",
  "message_failed",
  "stream_stalled",
  "error_raised",
] as const satisfies readonly CoreEventName[];

// ─────────────────────────────────────────────────────────────────────────────
// Runtime guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a server-supplied topic to a known {@link ChatTopic}.
 *
 * The layer of defence that makes `chat_topic` safe: the union type stops a raw
 * prompt string at compile time, and this stops one at runtime if a backend bug
 * or a schema drift ever sends something unexpected. Unknown input becomes
 * `other` rather than passing through, so free text cannot reach Mixpanel.
 */
export function coerceChatTopic(value: unknown): ChatTopic {
  return typeof value === "string" && (CHAT_TOPICS as readonly string[]).includes(value)
    ? (value as ChatTopic)
    : "other";
}

/**
 * Strip denied keys from a property bag.
 *
 * Belt-and-braces with the type system: the typed event map already prevents a
 * declared PII property, but a surface building props dynamically (spreading an
 * API response, say) can still smuggle one in. Runs at the seam so no call site
 * has to remember.
 */
export function stripDeniedProperties<T extends Record<string, unknown>>(props: T): Partial<T> {
  const denied = new Set<string>(DENIED_PROPERTY_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    // Mixpanel reserves the `$` and `mp_` prefixes for its own properties.
    if (denied.has(key) || key.startsWith("$") || key.startsWith("mp_")) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration off the pre-standard names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The rename PDEV-7009 has to execute on the existing `AnalyticsEventMap`.
 *
 * That map predates this standard and uses SDK-internal names. Renaming is free
 * right now — the seam is unreleased and no surface consumes it — and strictly
 * cheaper than translating inside the adapter forever, which would put a hidden
 * indirection between the typed name and the wire name and defeat the point of a
 * single source of truth.
 *
 * Kept as data, not prose, so `taxonomy.test.ts` can assert every target
 * actually exists in {@link CoreEventMap}. Delete this map once the rename lands.
 *
 * Note `token_refresh` maps to TWO events: its boolean `ok` becomes a success and
 * a failure event, because a boolean discriminator does not read as a funnel step.
 */
export const LEGACY_EVENT_RENAMES = {
  auth_started: "sign_in_started",
  auth_success: "sign_in_completed",
  auth_failed: "sign_in_failed",
  token_refresh: "session_token_refreshed",
  message_send: "message_sent",
  stream_start: "stream_started",
  stream_first_token: "message_first_token",
  stream_complete: "message_completed",
  stream_dropped: "stream_dropped",
  stream_reconnect: "stream_reconnect",
  api_error: "api_error",
} as const satisfies Record<string, CoreEventName>;

/**
 * Names that appeared in an earlier design document and must NOT be used.
 *
 * `response_received` was the architecture report's name for the moment the
 * web-app catalog called `message_completed`. One name has to win; it is
 * `message_completed`. Listed here so the reconciliation is discoverable from the
 * code rather than only from a document revision.
 */
export const RETIRED_EVENT_NAMES = ["response_received"] as const;

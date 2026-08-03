/**
 * Botticelli's action vocabulary, vendored.
 *
 * The canonical source is Botticelli `libs/nats/src/usage/schemas.ts`
 * (`llmActionTypeSchema`) and `libs/nats/src/invocation/schemas.ts`
 * (`invocationKindSchema`, `agentKindSchema`). Those are the enums the backend
 * metering plane stamps on every usage and invocation event.
 *
 * WHY IT IS COPIED RATHER THAN IMPORTED (PDEV-7011 decision, 2026-07-28):
 * `@botticelli/nats` exposes no pure-schema subpath today — `./usage` pulls in
 * `@botticelli/core` and `./invocation` needs `node:crypto`, neither of which a
 * browser add-in or a React Native bundle can take. The two options were to
 * request a `@botticelli/nats/schemas` subpath upstream, or to vendor the
 * vocabulary with a drift test. We vendor, matching the D4 precedent already set
 * for `capabilities` in the consolidation initiative: zero runtime dependency
 * now, a documented upgrade path later.
 *
 * THE CONTRACT THIS CREATES: these arrays must stay value-identical to the
 * upstream zod enums. `taxonomy.test.ts` pins them against a checked-in
 * fingerprint so an upstream addition fails a test here rather than silently
 * splitting the vocabulary in two. When that test fails, the upstream enum
 * gained or lost a value — mirror it here in the same change.
 *
 * Types-only consumers pay nothing: `import type { Route }` is erased by the
 * compiler, so the arrays below are never reached. Note they are not currently
 * tree-shakeable for VALUE importers, because the package does not declare
 * `sideEffects` — see the note in `index.ts`.
 */

/**
 * Every action the backend meters. Mirrors `llmActionTypeSchema` exactly,
 * including values no client can observe — parity with upstream is the point,
 * so the drift test can be an equality check rather than a subset check.
 *
 * @see CLIENT_ROUTES for the subset a surface actually emits.
 */
export const BACKEND_ACTION_TYPES = [
  "chat",
  "agent",
  "workflow",
  "extract_document_text_ocr_api",
  "embedding",
  "smart_processing_ocr",
  "smart_processing_image",
  "smart_processing_table",
  "retrieval",
  "retrieval_eval",
  "ingest",
  "table_mapper_compile",
  "table_vision_extract",
] as const;

/** An action type as the backend metering plane names it. */
export type BackendActionType = (typeof BACKEND_ACTION_TYPES)[number];

/**
 * The subset of {@link BACKEND_ACTION_TYPES} a CLIENT surface can actually
 * observe and therefore emit as `route`.
 *
 * The excluded values are all backend-internal: `embedding`,
 * `extract_document_text_ocr_api`, `retrieval_eval`, `table_mapper_compile`, and
 * `table_vision_extract` happen inside ingest or evaluation pipelines with no
 * client-side moment to hang an event on. Narrowing here keeps `route` honest —
 * a value in this union means a surface really can produce it — while the
 * backend-parity array above keeps the two planes reconcilable.
 */
export const CLIENT_ROUTES = [
  "chat",
  "agent",
  "workflow",
  "retrieval",
  "ingest",
  "smart_processing_ocr",
  "smart_processing_image",
  "smart_processing_table",
] as const;

/**
 * What kind of AI action produced this event. Shares the backend's vocabulary so
 * a Mixpanel funnel and a compute-cost breakdown mean the same thing by the same
 * name.
 */
export type Route = (typeof CLIENT_ROUTES)[number];

/**
 * What kind of thing was invoked. Mirrors `invocationKindSchema` so a Mixpanel
 * tool-adoption breakdown and an invocation-cost breakdown group identically.
 */
export const TOOL_KINDS = ["tool", "mcp_tool", "skill", "custom_api"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** Which agent id space an `agent_id` belongs to. Mirrors `agentKindSchema`. */
export const AGENT_KINDS = ["predefined", "custom"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Terminal result of an operation. Mirrors the backend's `outcome` enum. */
export const OUTCOMES = ["success", "error"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * A stable fingerprint of the vendored backend vocabulary.
 *
 * `taxonomy.test.ts` asserts the arrays above still hash to these strings. The
 * point is not cryptographic — it is that a well-meaning edit here, or a mirrored
 * upstream change, cannot land without someone consciously updating the expected
 * value and thereby noticing that the two planes' vocabularies just moved.
 */
export const VOCABULARY_FINGERPRINT = {
  backendActionTypes: BACKEND_ACTION_TYPES.join(","),
  toolKinds: TOOL_KINDS.join(","),
  agentKinds: AGENT_KINDS.join(","),
  outcomes: OUTCOMES.join(","),
} as const;

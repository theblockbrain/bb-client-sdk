import { describe, expect, it } from "vitest";

import type { AnalyticsEventMap } from "../adapters/analytics.js";
import type { CoreEventName } from "./taxonomy.js";
import {
  CHAT_TOPICS,
  CONVERSATION_ENTRY_POINTS,
  CORE_EVENT_NAMES,
  coerceChatTopic,
  DENIED_PROPERTY_KEYS,
  EMITTERS,
  ERROR_SCOPES,
  INPUT_MODES,
  LEGACY_EVENT_RENAMES,
  LEGACY_RENAME_TARGETS,
  MESSAGE_FAILED_STAGES,
  MIN_EVENT_SET,
  PROMPT_SOURCES,
  RETIRED_EVENT_NAMES,
  SIGN_IN_METHODS,
  SIGN_IN_STAGES,
  SIGN_OUT_CAUSES,
  STREAM_DROP_REASONS,
  SURFACES,
  stripDeniedProperties,
  TELEMETRY_ENVS,
} from "./taxonomy.js";
import {
  BACKEND_ACTION_TYPES,
  CLIENT_ROUTES,
  TOOL_KINDS,
  VOCABULARY_FINGERPRINT,
} from "./vocabulary.js";

/**
 * These are governance tests, not unit tests of behaviour. Each one pins a
 * decision from the KR 2.1 standard (PDEV-7011) so that breaking it fails CI
 * rather than silently shipping a split taxonomy.
 */

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

describe("wire naming", () => {
  it("every core event name is snake_case", () => {
    const offenders = CORE_EVENT_NAMES.filter(n => !SNAKE_CASE.test(n));
    expect(offenders).toEqual([]);
  });

  it("every enum value is snake_case", () => {
    // Every closed vocabulary, not a subset. A value slipping through here becomes a
    // permanent Mixpanel dimension value nobody defined.
    const all = [
      ...SURFACES,
      ...EMITTERS,
      ...CHAT_TOPICS,
      ...BACKEND_ACTION_TYPES,
      ...TOOL_KINDS,
      ...SIGN_IN_METHODS,
      ...SIGN_IN_STAGES,
      ...SIGN_OUT_CAUSES,
      ...MESSAGE_FAILED_STAGES,
      ...STREAM_DROP_REASONS,
      ...ERROR_SCOPES,
      ...INPUT_MODES,
      ...PROMPT_SOURCES,
      ...CONVERSATION_ENTRY_POINTS,
      ...TELEMETRY_ENVS,
    ];
    expect(all.filter(v => !SNAKE_CASE.test(v))).toEqual([]);
  });

  it("every closed vocabulary is a deduplicated as-const array", () => {
    // The file's convention: derive the type from a runtime array rather than an
    // inline union. Inline unions cannot be tested, cannot feed a Lexicon export,
    // and repeat themselves (SonarQube S4323).
    for (const vocab of [
      SURFACES,
      EMITTERS,
      CHAT_TOPICS,
      SIGN_IN_METHODS,
      SIGN_IN_STAGES,
      SIGN_OUT_CAUSES,
      MESSAGE_FAILED_STAGES,
      STREAM_DROP_REASONS,
      ERROR_SCOPES,
      INPUT_MODES,
      PROMPT_SOURCES,
      CONVERSATION_ENTRY_POINTS,
      TELEMETRY_ENVS,
    ]) {
      expect(new Set(vocab).size).toBe(vocab.length);
      expect(vocab.length).toBeGreaterThan(0);
    }
  });

  it("no core event name encodes a surface", () => {
    // Forking a name per surface breaks every cross-surface funnel, because a
    // Mixpanel funnel is an ordered list of names. The surface is a property.
    const offenders = CORE_EVENT_NAMES.filter(name => SURFACES.some(s => name.includes(s)));
    expect(offenders).toEqual([]);
  });

  it("no core event name encodes an emitter", () => {
    const offenders = CORE_EVENT_NAMES.filter(name => EMITTERS.some(e => name.includes(e)));
    expect(offenders).toEqual([]);
  });

  it("core event names are unique", () => {
    expect(new Set(CORE_EVENT_NAMES).size).toBe(CORE_EVENT_NAMES.length);
  });
});

describe("backend vocabulary parity", () => {
  // The vendored copy must stay value-identical to Botticelli's zod enums. When
  // one of these fails, upstream `libs/nats` changed: mirror it in vocabulary.ts
  // and update the fingerprint in the same change, so the move is deliberate.
  it("backend action types match the pinned fingerprint", () => {
    expect(BACKEND_ACTION_TYPES.join(",")).toBe(VOCABULARY_FINGERPRINT.backendActionTypes);
    expect(BACKEND_ACTION_TYPES.join(",")).toBe(
      "chat,agent,workflow,extract_document_text_ocr_api,embedding," +
        "smart_processing_ocr,smart_processing_image,smart_processing_table," +
        "retrieval,retrieval_eval,ingest,table_mapper_compile,table_vision_extract",
    );
  });

  it("tool kinds match invocationKindSchema", () => {
    expect(TOOL_KINDS.join(",")).toBe("tool,mcp_tool,skill,custom_api");
  });

  it("client routes are a strict subset of the backend vocabulary", () => {
    // A route the backend does not know would not reconcile against metering.
    const backend = new Set<string>(BACKEND_ACTION_TYPES);
    expect(CLIENT_ROUTES.filter(r => !backend.has(r))).toEqual([]);
    expect(CLIENT_ROUTES.length).toBeLessThan(BACKEND_ACTION_TYPES.length);
  });
});

describe("the min-event-set", () => {
  it("is entirely covered by the core map", () => {
    const core = new Set<string>(CORE_EVENT_NAMES);
    expect(MIN_EVENT_SET.filter(n => !core.has(n))).toEqual([]);
  });

  it("contains the funnel steps activation and retention depend on", () => {
    // Losing any of these silently breaks MAU, activation, or the TTFT SLO.
    for (const required of [
      "sign_in_completed",
      "conversation_started",
      "message_sent",
      "message_first_token",
      "message_completed",
    ] as const) {
      expect(MIN_EVENT_SET).toContain(required);
    }
  });
});

describe("the legacy rename map", () => {
  it("every target exists in the core catalog", () => {
    const core = new Set<string>(CORE_EVENT_NAMES);
    expect(LEGACY_RENAME_TARGETS.filter(to => !core.has(to))).toEqual([]);
  });

  it("splits token_refresh into both halves of its boolean", () => {
    // The one fan-out in the map. If a future edit flattens it back to a single
    // target, session_token_refresh_failed silently stops being renamed.
    expect(LEGACY_EVENT_RENAMES.token_refresh).toEqual({
      success: "session_token_refreshed",
      failure: "session_token_refresh_failed",
    });
    expect(LEGACY_RENAME_TARGETS).toContain("session_token_refresh_failed");
  });

  it("the seam speaks only canonical names", () => {
    // The seam used to declare its OWN vocabulary (`auth_success`, `message_send`,
    // `stream_start`, …), and this assertion checked that each of those had a
    // canonical rename waiting for it. That second vocabulary is gone —
    // `AnalyticsEventMap` is now an alias of `CoreEventMap` — so the guard that
    // matters is the inverse: nothing can reintroduce a non-canonical event name
    // through the seam.
    //
    // Type-level, because an interface is not enumerable at runtime.
    type NonCanonical = Exclude<keyof AnalyticsEventMap, CoreEventName>;
    const _canonical: NonCanonical extends never
      ? true
      : { error: "the analytics seam declares an event outside CoreEventMap" } = true;
    expect(_canonical).toBe(true);
  });

  it("still translates every legacy name a surface may be emitting", () => {
    // The rename map outlives the seam change: a surface pinned to an older SDK,
    // or one that hand-rolled the pre-standard names, still needs a documented
    // target. Losing an entry here would strand that surface's dashboards.
    for (const legacy of ["auth_started", "auth_success", "message_send", "stream_start"]) {
      expect(LEGACY_EVENT_RENAMES).toHaveProperty(legacy);
    }
  });

  it("does not resurrect a retired name", () => {
    for (const retired of RETIRED_EVENT_NAMES) {
      expect(LEGACY_RENAME_TARGETS as readonly string[]).not.toContain(retired);
      expect(CORE_EVENT_NAMES as readonly string[]).not.toContain(retired);
    }
  });
});

describe("coerceChatTopic", () => {
  it("passes through a known topic", () => {
    expect(coerceChatTopic("finance")).toBe("finance");
  });

  it("coerces an unknown topic to other", () => {
    // The runtime half of the free-text guard: a backend bug or schema drift
    // must not put prompt text into Mixpanel.
    expect(coerceChatTopic("please summarise the Q3 contract for ACME")).toBe("other");
  });

  it("coerces non-strings to other", () => {
    for (const input of [undefined, null, 42, {}, [], true]) {
      expect(coerceChatTopic(input)).toBe("other");
    }
  });

  it("is case-sensitive, so a near-miss is not silently accepted", () => {
    expect(coerceChatTopic("Finance")).toBe("other");
  });
});

describe("stripDeniedProperties", () => {
  it("keeps safe properties untouched", () => {
    const props = { route: "chat", duration_ms: 1200, outcome: "success" };
    expect(stripDeniedProperties(props)).toEqual(props);
  });

  it("drops every denied key", () => {
    const props: Record<string, unknown> = { route: "chat" };
    for (const key of DENIED_PROPERTY_KEYS) props[key] = "leaked";
    expect(stripDeniedProperties(props)).toEqual({ route: "chat" });
  });

  it("drops Mixpanel's reserved prefixes even when not explicitly denied", () => {
    const out = stripDeniedProperties({
      route: "chat",
      $unexpected_reserved: "x",
      mp_internal: "y",
    });
    expect(out).toEqual({ route: "chat" });
  });

  it("does not mutate its input", () => {
    const props = { route: "chat", email: "a@b.c" };
    stripDeniedProperties(props);
    expect(props.email).toBe("a@b.c");
  });

  it("denies a key whose case differs from the denylist entry", () => {
    // A bag built from somewhere else does not have to match our spelling for the
    // value behind the key to be PII.
    const out = stripDeniedProperties({ route: "chat", Email: "a@b.c", PHONE: "+1", $Name: "x" });
    expect(out).toEqual({ route: "chat" });
  });

  it("denies the camelCase spelling of a snake_case denied key", () => {
    // The denylist is snake_case because the wire format is, but the rest of the
    // SDK is camelCase — so this is the spelling a real leak arrives in.
    const out = stripDeniedProperties({
      route: "chat",
      displayName: "Ada",
      fullName: "Ada L",
      fileName: "q3.pdf",
      messageText: "secret",
    });
    expect(out).toEqual({ route: "chat" });
  });

  it("keeps a safe key that merely shares a prefix with a denied one", () => {
    // The guard is exact-match on the folded key, not substring — over-stripping
    // is tolerable but it must not be unbounded.
    const props = { prompt_source: "template", owner_permission: "member", topic_name_id: "x" };
    expect(stripDeniedProperties(props)).toEqual(props);
  });

  it("denies the Mixpanel reserved identity properties by name", () => {
    // Sending these would attach real identity to a deliberately pseudonymous
    // distinct_id, which is the single worst failure available to us here.
    for (const key of ["$email", "$name", "$first_name", "$last_name", "$phone"]) {
      expect(DENIED_PROPERTY_KEYS as readonly string[]).toContain(key);
    }
  });
});

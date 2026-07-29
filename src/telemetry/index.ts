/**
 * `@theblockbrain/bb-client-sdk/telemetry` — the product-analytics taxonomy.
 *
 * The KR 2.1 standard (PDEV-7011) as code: names, closed enums, the super-property
 * shape, and the two runtime guards that keep free text out of Mixpanel. There is
 * no transport and no vendor client here on purpose, so a surface can instrument
 * against these names before the SDK's runtime seam exists.
 *
 * The runtime sink and the Mixpanel adapter live at `./analytics` today and move
 * under this subpath in the 0.18.0 rename (PDEV-7009), at which point `./analytics`
 * goes away — it collides with `@botticelli/client-analytics` and with Botticelli's
 * metering `analytics-service`, both of which mean something different by the word.
 *
 * RUNTIME COST, stated precisely. A pure `import type { … }` is erased by the
 * compiler and costs literally nothing, which is the import a surface needs to
 * instrument against these names. Importing a VALUE (`SURFACES`, `coerceChatTopic`)
 * pulls in this module, currently about 6 KB unminified for everything here.
 *
 * That number could be smaller: nothing in this directory has a side effect, but
 * the package does not declare `sideEffects`, so a bundler cannot safely drop the
 * exports you did not use. Declaring it would have to be
 * `sideEffects: ["**\/*.css"]` rather than a blanket `false`, because
 * `./ui/theme-base.css` genuinely is a side-effecting import. That is a
 * package-wide bundling change, so it is deliberately left as a follow-up rather
 * than smuggled in here.
 */

export type {
  ConsentGate,
  ConsentSource,
  ConsentState,
} from "./consent.js";
export {
  createConsentGate,
  createStaticConsentSource,
  createTogglableConsentSource,
} from "./consent.js";
export type {
  BlockedAction,
  BotKind,
  ChatTopic,
  ConversationEntryPoint,
  CoreEventMap,
  CoreEventName,
  CoreEventProps,
  Emitter,
  ErrorScope,
  InputMode,
  MessageFailedStage,
  OwnerPermission,
  PeopleProperties,
  PromptSource,
  SignInMethod,
  SignInStage,
  SignOutCause,
  SplitRename,
  StreamDropReason,
  SuperProperties,
  Surface,
  TelemetryEnv,
} from "./taxonomy.js";
export {
  BLOCKED_ACTIONS,
  BOT_KINDS,
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
  OWNER_PERMISSIONS,
  PROMPT_SOURCES,
  RETIRED_EVENT_NAMES,
  SIGN_IN_METHODS,
  SIGN_IN_STAGES,
  SIGN_OUT_CAUSES,
  STREAM_DROP_REASONS,
  SURFACES,
  stripDeniedProperties,
  TAXONOMY_VERSION,
  TELEMETRY_ENVS,
  TOPIC_TAXONOMY_VERSION,
} from "./taxonomy.js";
export type {
  AgentKind,
  BackendActionType,
  Outcome,
  Route,
  ToolKind,
} from "./vocabulary.js";
export {
  AGENT_KINDS,
  BACKEND_ACTION_TYPES,
  CLIENT_ROUTES,
  OUTCOMES,
  TOOL_KINDS,
  VOCABULARY_FINGERPRINT,
} from "./vocabulary.js";

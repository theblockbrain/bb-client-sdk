# SLO targets — the numbers the telemetry gate reads

The `AnalyticsAdapter` taxonomy exists to make these SLOs **measurable**. This file is the
target reference the telemetry gate points at: each SLI maps to an `AnalyticsEventMap`
event (WS9, on `main`), so once a surface registers an adapter the number can actually be read.

> **Canonical source.** These are the SDK- and surface-relevant rows extracted from the
> domain-wide **Apps Domain — SLO Catalog** (all 13 repos, Grafana-centric tooling). The full
> catalog lives in Confluence (`Apps Domain — SLO Catalog`, page `1035698188`, child of the
> Apps-Domain OKRs page) and as `~/Documents/Apps-Domain/Apps-Domain-SLO-Catalog.md`. **Don't
> restate the full matrix here** — link to it. These are launch/acceptance targets: almost every
> surface is pre-instrumentation, so baselines are TBD until Faro + Sentry + Mixpanel land (that
> instrumentation is itself the O2 release gate).

## SLIs the SDK taxonomy feeds (map event → SLO → tool)

> **Renamed in `0.20.0`.** Every event and property below is the `CoreEventMap`
> vocabulary (`./telemetry`). The previous column used the retired `auth_*` /
> camelCase names, so **any dashboard, PromQL rule or Mixpanel funnel built from
> the old rows has to be re-keyed** — that is the migration work this rename
> creates, and it is why the change is a breaking minor. Old→new map:
> `LEGACY_EVENT_RENAMES`, plus the table in the CHANGELOG.

| SLI | `CoreEventMap` event(s) | Target | Tool |
|---|---|---|---|
| **Auth success rate** | `sign_in_started` → `sign_in_completed` / `sign_in_failed` | ≥ 99% | Mixpanel funnel + Sentry; Faro (browser) |
| **Auth latency** | `sign_in_completed.latency_ms` | p95 ≤ 4s (add-in dialog) · ≤ 1.5s token-exchange leg (SPA) | Faro span / Sentry perf |
| **Token-refresh success** | `session_token_refreshed` vs `session_token_refresh_failed` | ≥ 99.5%, 0 refresh storms (single-flight) | Faro / Sentry |
| **Chat/agent error rate** | `api_error{status_code,endpoint}` + `message_sent` | < 1% of sends fail | Mixpanel + Sentry; Mimir burn-rate |
| **Stream connect success** | `stream_started` → `message_first_token` | ≥ 99% | Faro/OTel → Mimir |
| **Time-to-first-token (TTFT)** | `message_first_token.ttft_ms` | client-observed p95 ≤ 2.5s / p99 ≤ 5s (shared backend budget) | Tempo + Mimir |
| **Mid-stream drop** | `stream_dropped` (vs `message_completed`) | < 1% | Faro/OTel |
| **Stream stall** | `stream_stalled.stall_ms` | (no target set yet — new in the taxonomy) | Faro/OTel |
| **Stream reconnection** | `stream_reconnect` → `message_completed` | ≥ 95% recover | Faro/OTel |
| **Crash-free sessions / users** | (health telemetry, not a track event) | ≥ 99.5% / ≥ 99.5% web+add-in · users ≥ 99% mobile · ≥ 99.7% blocky-frontend | Sentry release-health (+ Faro) |
| **Min-event-set coverage** | all of the above, emitting | 100% of shipping surfaces | Mixpanel + Faro coverage check |

## Rules that bind these numbers (see `telemetry-release-gate.md`)

- **TTFT is one shared backend budget**, not a per-surface knob — a client cannot beat the model's
  time-to-first-token. Don't set a client TTFT below 2.5s except where a real production baseline
  justifies it (blocky-frontend ≤2s).
- **Crash-free is one domain pair** (sessions ≥99.5% / users ≥99.5%) with two reasoned exceptions
  (mobile users ≥99%, blocky-frontend users ≥99.7%). No un-instrumented surface claims tighter.
- **No PII in events.** Identify by Zitadel `sub`, group by org id; never emails/names/tokens, never
  `BBApiError.responseBody`.
- **Zero-tolerance invariants are page-on-breach, not budget burns**: `orgId`/`targetOrgId` tenant
  isolation (0 cross-tenant), no browser-visible/committed tokens.

Enable Grafana SLO error budgets + multi-window burn-rate alerts only **after** 2–4 weeks of
Faro/Sentry baseline exist — see `telemetry-release-gate.md` and the full catalog.

---
applyTo: "src/api/**,src/auth/**,src/settings/**,src/adapters/**,src/text/**,src/utils/**,src/analytics/**,src/telemetry/**,src/i18n/**,src/config.ts,src/index.ts"
---

# The framework-agnostic core

These files are imported by a **Node backend (Slack), a Lit web component, and React
Native** as well as by React add-ins. Anything you add here must work in all of them.

## Never in these files

- `import ... from "react"` — anything React-shaped belongs in `src/react/**` or
  `src/ui/react.ts`. The clean-room gate imports every one of these modules with **no React
  installed** and fails if one needs it.
- A platform global dereferenced **at module scope**: `window`, `document`, `localStorage`,
  `sessionStorage`, `crypto`, `navigator`, `fetch`. Module scope runs at import time, so it
  breaks the import itself, not just the call. Resolve inside a function, or inject a port.
- A DOM-lib-only type in an **exported** signature — `Storage`, `Document`, `Element`,
  `DocumentFragment`, `HTMLElement`. Use a structural interface (see `WebStorageArea`,
  `MarkdownDocument`, `OfficeGlobal`). `URL`, `AbortSignal`, `Blob`, `File` and `FormData`
  are fine — `@types/node` declares them.

## Ports, not conditionals

When the core needs something only a host can do, add an **adapter port** rather than
branching on the runtime. Existing ports: `StorageAdapter` / `SyncStorageAdapter`,
`IdentityAdapter`, `CryptoAdapter`, `FlagAdapter`, `AnalyticsAdapter`, `FormatterAdapter`,
`HostCapabilityRegistry`, `Transporter`.

A port's default resolves the platform implementation **lazily** so browser behaviour is
unchanged and the module still imports where the global is absent.

Ports that read on a render path (flags) are **synchronous and total** — they cannot await,
and a throwing or absent provider degrades to the caller's fallback rather than breaking the
feature it was meant to gate.

## Untrusted input

`./api` responses, SSE frame fields and agent tool ids are **server-controlled**. Do not
interpolate them into a message that is rendered or fed back to a model. See the
"never echo untrusted text" rule in `.github/copilot-instructions.md`.

Never log `BBApiError.responseBody` raw — it can carry a token.

## Adding an entry point

A new subpath means: `package.json#exports` (with a `react-native` condition **ahead of**
`import`), `tsup.config.ts` entry, the barrel, and a regenerated contract snapshot. The
clean-room check enumerates entry points from `package.json#exports`, so it picks the new one
up automatically — including the DOM-less typecheck.

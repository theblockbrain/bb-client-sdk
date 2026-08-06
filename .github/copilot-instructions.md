# bb-client-sdk — repository instructions

`@theblockbrain/bb-client-sdk` is the **shared, framework-agnostic frontend SDK** ("thin
surface, thick SDK") consumed by **every** BlockBrain Apps surface: React add-ins
(Outlook / Word / PowerPoint / Excel), an SPFx extension + web part (SharePoint / Teams),
a Lit web component (blocky-chat), a **Node** backend (Slack), and a **React Native** app.

**A change here fans out to all of them. A change that breaks any one adapter is a defect,
not a trade-off.** That single fact drives every rule below.

ESM-only · `"type": "module"` · published private to GitHub Packages · Node 24 (`.nvmrc`)
· one runtime dependency (`marked`) · optional peers `react >=18 <20`, `@tanstack/react-query ^5`.

> This file is the **shared** rule set for GitHub Copilot *and* Claude. Deep, task-specific
> playbooks live in `.claude/skills/**` (start at `.claude/skills/sdk/SKILL.md`) and
> `CLAUDE.md`. When a rule belongs to both audiences it goes **here**, once, so the two
> cannot drift.

---

## The five invariants

1. **Framework-agnostic core.** Only `./react` and `./ui/react` may import React. `./api`,
   `./auth`, `./settings`, `./text`, `./utils`, `./adapters`, `./config`, `./ui` must
   tree-shake with **zero React in the graph**. Non-React consumers import subpaths.
2. **No runtime assumptions.** No bare `window` / `document` / `localStorage` /
   `sessionStorage` / `crypto` / `fetch` at module scope in the core. Platform globals are
   resolved **lazily, inside a function**, or injected through an adapter port. `fetch` and
   `ReadableStream` are unreliable on React Native.
3. **Verify all adapters.** Every change is checked against the adapter matrix. Public-API
   changes pass the contract test **and** are canary-tested before `latest`.
4. **Security in every layer.** Tokens never logged or bundled. PKCE S256 + CSRF. `orgId`
   vs `targetOrgId` discipline. Zero cross-tenant leakage. `extractJson` never throws.
   Minimal dependencies.
5. **Instrument every surface.** Nothing ships to production without product analytics and
   health telemetry, emitted through the `AnalyticsAdapter` seam.

---

## Two rules that exist because they were violated

### Public declarations carry no platform-specific ambient types

A type that only exists in TypeScript's `dom` lib will break a consumer whose `lib`
excludes it — **even if that consumer never calls the function**, because the declaration
still gets checked. Use a **structural** interface over the slice you actually need.
Precedents in this repo: `OfficeGlobal`, `WebStorageArea`, `MarkdownDocument`.

Know the difference before flagging or "fixing" one:

| Type | Declared by `@types/node`? | Safe in a public signature? |
|---|---|---|
| `URL`, `AbortSignal`, `Blob`, `File`, `FormData` | **yes** | **Yes** — every real runtime provides these. Do **not** replace them; a look-alike loses fidelity |
| `Storage`, `Document`, `Element`, `DocumentFragment`, `HTMLElement` | **no** | **No** — DOM-lib only. Use a structural type |

`npm run check:cleanroom` phase 3 enforces this by typechecking the packed tarball as a
DOM-less Node consumer.

### Never echo untrusted text into rendered or agent-facing output

Server- and agent-controlled strings (`toolId` off a stream frame, `BBApiError.responseBody`,
a server error message) must not be interpolated raw into anything that gets rendered or fed
back to a model. Server text can echo a submitted credential; agent text can inject
instructions or line breaks into the next turn.

- `describeBBApiError` deliberately ignores the response body and the error message.
- `routeToolCall` quotes `toolId` via `JSON.stringify` after collapsing control/format
  characters and clamping by **code point** (not UTF-16 unit — slicing units can split a
  surrogate pair).
- Do **not** HTML-escape at this layer. These are plain-text messages; escaping belongs at
  the sink. A surface that `innerHTML`s SDK output has its own bug.

---

## Code style

Follow the surrounding file. It is dense, deliberate, and comments explain **why**, not what
— match that.

- **No `any`**, no `Function`, no `var`. Use `unknown` + narrowing.
- **No suppressions.** `biome-ignore`, `eslint-disable`, `@ts-ignore` / `@ts-expect-error`,
  and `as any` / `as unknown as T` are last resorts, not tools. A diagnostic is information
  about the code — fix the cause. Even an `ℹ`-level Biome diagnostic that exits 0 counts: a
  clean `npm run lint` is the standard. If a rule genuinely must be waived, that is a config
  decision in `biome.json` / `eslint.config.js` with a written rationale, not an inline
  comment scattered through `src/`.
- **Relative imports end in `.js`.** Node ESM requires the extension; a bundler hides the
  mistake and a real install fails.
- **Early returns** over nested `if`/`else`. No nested ternaries.
- **Typed errors.** Every `./api` call throws `BBApiError` on non-2xx. Handle with
  `isBBApiError(err)`; prefer `describeBBApiError(err)` over a hand-rolled status ladder.
- **Server-supplied enums:** closed type for our use, open type on the wire.
- **Never encode a domain condition in an HTTP status the application does not exclusively
  own** — a proxy or mesh emits the same codes. Use a typed body field.
- Pure, immutable, fully typed by default. Hoist static values and pure helpers to module
  scope; keep anything with a runtime dependency inside.

---

## Verification — required before any change is "done"

```bash
nvm use               # Node 24
npm run lint          # biome + type-aware eslint
npm run typecheck     # tsc --noEmit
npm test              # vitest — includes the public-API contract test
npm run build         # tsup + tsc (dts)
npm run check:package # publint + attw (esm-only)
npm run check:cleanroom # 3 phases: install, no-React import, DOM-less typecheck
```

A public-API change **fails `src/public-api.contract.test.ts` on purpose** — that is a
conscious semver decision. If intentional, update the snapshot in the same change
(`npx vitest run -u src/public-api.contract.test.ts`) and pick the version bump per
`.claude/skills/sdk/references/release-and-versioning.md`.

Green gates mean "the tests I wrote pass" — not "the input space is covered". For anything
security-adjacent, enumerate the hazard classes **first**, then write the test per class.

---

## Governance

- **Commits:** Conventional Commit scoped by a Jira ticket — `feat(PDEV-123): …` (enforced).
- **Branches:** `type/TICKET-123/description` (enforced).
- `dist/` is git-ignored; `file:`-linked consumers must `npm run build` once after a pull.

---

## When reviewing a pull request

The review is only useful if it is **true**. This repo has had reviews that were confidently
wrong, so:

- **Verify the claim against the repo before making it.** "This type breaks Node consumers"
  is checkable — check it. Prefer naming the file and line you verified.
- **Do not assert a second occurrence you have not found.** Claiming "this also appears on
  line N" when it does not costs more trust than the finding earns.
- **State the mechanism, not the vibe.** Which consumer, which config, which runtime, and
  what breaks.
- **Distinguish "wrong" from "differently styled".** Deliberate decisions in this repo are
  documented in the code and in `.claude/skills/**` — a comment explaining why something is
  *not* done the obvious way is a decision, not an oversight.
- **The highest-value findings here** are: a cross-adapter break (Node / Lit / RN), a leaked
  platform assumption, untrusted text reaching output, a token in a log, a public-API change
  with no snapshot update, and a gate that would not have caught the bug.

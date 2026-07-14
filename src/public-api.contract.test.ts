import { describe, expect, it } from "vitest";

// Public-API contract test.
//
// Snapshots the exported names of every public entry point declared in
// package.json "exports". If a public symbol is renamed or removed, the snapshot
// diff fails CI — forcing a conscious decision (and, for consumers like the
// Outlook add-in, an intentional breaking-change bump) rather than a silent break.
//
// This complements publint/attw (which check that types *resolve*) by guarding
// the *stability of the surface* itself. To intentionally change the API, update
// the snapshot with `vitest -u` in the same PR.

const entries = {
  ".": () => import("./index.js"),
  "./auth": () => import("./auth/index.js"),
  "./api": () => import("./api/index.js"),
  "./settings": () => import("./settings/index.js"),
  "./utils": () => import("./utils/index.js"),
  "./adapters": () => import("./adapters/index.js"),
  "./config": () => import("./config.js"),
  "./prompt": () => import("./prompt/index.js"),
  "./actions": () => import("./actions/index.js"),
  "./ui": () => import("./ui/index.js"),
  "./react": () => import("./react/index.js"),
} as const;

describe("public API surface", () => {
  for (const [subpath, load] of Object.entries(entries)) {
    it(`exports of "${subpath}" are stable`, async () => {
      const mod = await load();
      const names = Object.keys(mod).sort();
      expect(names).toMatchSnapshot();
    });
  }
});

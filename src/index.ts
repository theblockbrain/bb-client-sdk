// Public barrel — every framework-agnostic module, and nothing that imports React.
//
// `./react` and `./ui/react` are deliberately absent (PDEV-7724). Re-exporting
// either pulls React into this graph, which made the barrel unimportable from Node
// with no React installed — reproduced against a real install, not inferred.
//
// `./ui` IS re-exported: once `useTheme` moved to `./ui/react`, that layer became
// React-free, so keeping it here costs nothing and holds the breaking change to
// the one symbol that actually caused the problem. Dropping the whole layer would
// have removed seven working exports from `.` to fix one.

export type { IdentityAdapter, StorageAdapter } from "./adapters/index.js";
export * from "./analytics/index.js";
export * from "./api/index.js";
export * from "./auth/index.js";
export * from "./config.js";
export * from "./settings/index.js";
export * from "./text/index.js";
export * from "./ui/index.js";
export * from "./utils/index.js";

import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/auth/index.ts",
    "src/api/index.ts",
    "src/api/agentic/index.ts",
    "src/settings/index.ts",
    "src/utils/index.ts",
    "src/text/index.ts",
    "src/media/index.ts",
    "src/adapters/index.ts",
    "src/adapters/office.ts",
    "src/config.ts",
    "src/i18n/index.ts",
    "src/ui/index.ts",
    "src/ui/react.ts",
    "src/react/index.ts",
    "src/analytics/index.ts",
    "src/analytics/mixpanel.ts",
    "src/analytics/faro.ts",
    "src/telemetry/index.ts",
    "src/telemetry/cookiebot.ts",
    // Node-only dev tooling. A LEAF: nothing under src/ imports it, and the `.`
    // barrel must never re-export it — see src/dev/sdk-link.leaf.test.ts.
    "src/dev/sdk-link.ts",
    "src/dev/sdk-link-bin.ts",
  ],
  format: ["esm"],
  // Keep `node:fs` as `node:fs`. tsup 8 rewrites it to a bare `fs` by default
  // (the default flips to false in tsup 9), and a bare `fs` is an ordinary
  // specifier to a bundler — Metro can resolve it to a userland shim instead of
  // failing loudly, which is the opposite of what the prefix is for. esbuild
  // preserves the prefix on its own; this is purely tsup's own rewrite.
  removeNodeProtocol: false,
  // Declarations are emitted by `tsc -p tsconfig.build.json` in the build script.
  // tsup's dts builder hardcodes a deprecated `baseUrl` that TS 6 rejects, so we
  // let tsc (via tsconfig.build.json, which extends tsconfig.json — no baseUrl)
  // generate .d.ts instead.
  dts: false,
  clean: true,
  sourcemap: true,
  // Required for ThemeToggle.tsx and any future JSX components
  jsx: "react-jsx",
});

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
    "src/adapters/index.ts",
    "src/config.ts",
    "src/ui/index.ts",
    "src/react/index.ts",
    "src/analytics/index.ts",
    "src/analytics/mixpanel.ts",
    "src/telemetry/index.ts",
    "src/telemetry/cookiebot.ts",
  ],
  format: ["esm"],
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

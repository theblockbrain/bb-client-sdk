import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/auth/index.ts",
    "src/api/index.ts",
    "src/settings/index.ts",
    "src/utils/index.ts",
    "src/adapters/index.ts",
    "src/config.ts",
    "src/prompt/index.ts",
    "src/actions/index.ts",
    "src/ui/index.ts",
    "src/react/index.ts",
  ],
  format: ["esm"],
  // Declarations are emitted by `tsc -p tsconfig.build.json` in the build script.
  // tsup's dts builder hardcodes a deprecated `baseUrl` that TS 6 rejects, so we
  // let tsc (which reads tsconfig.json — no baseUrl) generate .d.ts instead.
  dts: false,
  clean: true,
  sourcemap: true,
  // Required for ThemeToggle.tsx and any future JSX components
  jsx: "react-jsx",
});

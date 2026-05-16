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
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});

import { defineConfig } from "vitest/config";

// Runs the vitest suites under src/ (the ./react layer tests + the public-API
// contract test). The legacy test/auth/*.test.ts file still imports `bun:test`
// and lives outside src/, so this include never picks it up.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

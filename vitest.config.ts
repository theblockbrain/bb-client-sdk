import { defineConfig } from "vitest/config";

// Scoped to the new ./react layer's tests. The legacy test/auth/*.test.ts file
// still imports `bun:test` and is migrated separately (WS1); excluding it here
// keeps this suite green without coupling the two workstreams.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/react/**/*.test.{ts,tsx}"],
  },
});

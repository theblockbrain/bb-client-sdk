import { defineConfig } from "vitest/config";

// Every test lives under src/, co-located with what it covers.
//
// Keep it that way. A `test/` directory outside this glob is invisible to CI:
// `test/auth/pkce-state-separation.test.ts` sat there for months on `bun:test`,
// never running, while the security docs cited it as coverage for a CWE-200
// defect (PDEV-7684). A test that cannot run is worse than no test, because it
// stops anyone from writing the real one.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

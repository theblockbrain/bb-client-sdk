import pluginQuery from "@tanstack/eslint-plugin-query";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// ESLint here is intentionally narrow: it runs the TYPE-AWARE correctness rules
// that Biome cannot (floating promises, misused promises, unsafe any-flow) plus
// React-hooks and TanStack Query rules. Biome owns formatting and stylistic lint,
// so anything Biome already covers is disabled here to avoid double-reporting.
// Scope is `src/` only (see the `lint:types` script); build output, config files,
// and the legacy `test/` suite are out of scope.
export default tseslint.config(
  // Type-aware correctness across all source
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The highest-value rules for an async transport/auth SDK:
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Biome already reports these — avoid duplicate diagnostics:
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  // React hooks rules for the react-query and UI layers.
  // The two classic, high-signal rules; v7's additional React-compiler rules
  // (immutability/refs/static-components/…) can be adopted deliberately later.
  {
    files: ["src/react/**/*.{ts,tsx}", "src/ui/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // TanStack Query correctness rules for the react-query layer
  ...pluginQuery.configs["flat/recommended"].map(cfg => ({
    ...cfg,
    files: ["src/react/**/*.{ts,tsx}"],
  })),

  // Query keys are derived through a helper (`bbKeys(scope)`, where scope is itself
  // derived from targetOrgId) and queryFns take stable `getCtx` getters by design.
  // The exhaustive-deps rule can trace neither, so it only false-positives here.
  {
    files: ["src/react/**/*.{ts,tsx}"],
    rules: { "@tanstack/query/exhaustive-deps": "off" },
  },

  // Tests legitimately use `any`, non-null assertions, and loose typing
  {
    files: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);

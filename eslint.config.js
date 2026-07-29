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

  // ── Telemetry governance (PDEV-7011) ──
  // The typed event map already stops an unknown event NAME at compile time, so
  // this rule targets the three ways code can get around the type system and
  // reach Mixpanel with an arbitrary string:
  //
  //   1. importing a vendor client into the SDK and calling it directly,
  //   2. calling a `mixpanel` instance outside the one adapter that may,
  //   3. casting a string into an event-name union.
  //
  // `src/analytics/mixpanel.ts` is the single legitimate integration point and is
  // exempted below.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/analytics/mixpanel.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "mixpanel-browser",
              message:
                "Do not import a vendor analytics client here. The SDK stays provider-agnostic: describe the client structurally (see MixpanelClient in src/analytics/mixpanel.ts) and let the surface pass an instance in.",
            },
            {
              name: "posthog-js",
              message:
                "Do not import a vendor analytics client here. Emit through the typed seam so one taxonomy governs every surface.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: 'CallExpression[callee.object.name="mixpanel"]',
          message:
            "Do not call a Mixpanel client directly — it bypasses the typed taxonomy and the PII denylist. Emit via trackEvent() from ./analytics, whose event names are checked against src/telemetry/taxonomy.ts.",
        },
        {
          selector: 'TSAsExpression > TSTypeReference > Identifier[name="CoreEventName"]',
          message:
            "Do not cast to CoreEventName. The cast launders an unchecked string into the event union, which is exactly what the typed map exists to prevent. Add the event to CoreEventMap instead.",
        },
        {
          selector: 'TSAsExpression > TSTypeReference > Identifier[name="AnalyticsEventName"]',
          message:
            "Do not cast to AnalyticsEventName. Add the event to AnalyticsEventMap (and give it a canonical name in LEGACY_EVENT_RENAMES) instead of casting past the type.",
        },
      ],
    },
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

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Public-API contract test.
//
// Snapshots the exported names — VALUES AND TYPES — of every public JS entry point
// declared in package.json "exports". If a public symbol (including a type) is renamed
// or removed, the snapshot diff fails CI, forcing a conscious decision (and, for
// consumers like the Outlook add-in, an intentional breaking-change bump) rather than a
// silent break.
//
// Why the TypeScript checker instead of `Object.keys(await import(...))`: runtime keys
// exclude type-only exports (e.g. ./adapters is entirely `export type …`, so its runtime
// namespace is empty), which would let a broken type surface pass unnoticed.
// `getExportsOfModule` reports types too, and resolves `export *` re-exports.
//
// The entry list is DERIVED from package.json "exports" (not hard-coded) so it can't
// drift from the publish surface. Non-module asset subpaths (e.g. ./ui/theme-base.css,
// whose target is a plain string rather than an { import } conditions object) are skipped.
//
// This complements publint/attw (which check that types *resolve*) by guarding the
// *stability of the surface* itself. To intentionally change the API, update the
// snapshot with `vitest -u` in the same PR.

const rootDir = dirname(dirname(fileURLToPath(import.meta.url))); // <root>/src/… -> <root>
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
  exports: Record<string, string | { import?: string; types?: string }>;
};

// JS module entry points only: their target is a conditions object with an `import`
// field. Asset subpaths (string targets, like the CSS file) are intentionally excluded.
const jsEntries = Object.entries(pkg.exports).flatMap(([subpath, target]) => {
  if (typeof target !== "object" || !target.import) return [];
  // ./dist/foo/index.js -> <root>/src/foo/index.ts (the source behind the published entry)
  const source = target.import.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
  return [{ subpath, file: join(rootDir, source) }];
});

// One Program over all entry sources, using the repo tsconfig so `export *` and
// cross-module re-exports resolve exactly as they do for a real consumer.
const configPath = join(rootDir, "tsconfig.json");
const parsedConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, fileName => ts.sys.readFile(fileName)).config,
  ts.sys,
  rootDir,
);
const program = ts.createProgram(
  jsEntries.map(e => e.file),
  parsedConfig.options,
);
const checker = program.getTypeChecker();

function exportedNames(file: string): string[] {
  const sourceFile = program.getSourceFile(file);
  if (!sourceFile) throw new Error(`entry source not found: ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`no module symbol for: ${file}`);
  return checker
    .getExportsOfModule(moduleSymbol)
    .map(s => s.getName())
    .sort();
}

describe("public API surface", () => {
  for (const { subpath, file } of jsEntries) {
    it(`exports of "${subpath}" are stable`, () => {
      expect(exportedNames(file)).toMatchSnapshot();
    });
  }
});

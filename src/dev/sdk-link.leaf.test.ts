/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The leaf invariant for `./dev/**`.
//
// `./dev/sdk-link` imports `node:fs` and `node:path`. This package also ships a
// React Native condition, and every declared export is subject to it, so a
// single re-export from a shared barrel would put Node built-ins in a React
// Native consumer's graph. That failure is not hypothetical: 0.18.0 shipped a
// `.` barrel that re-exported `./ui`'s `useTheme` and was therefore unimportable
// from Node with no React installed, with every other gate green (PDEV-7724).
//
// So this walks the REAL import graph rather than trusting the barrel comments:
// one TypeScript program over every non-dev entry point, resolving `export *`
// and cross-module re-exports exactly as a consumer's compiler would, and fails
// if any file under `src/dev/` turns up in it.
//
// The entry list is derived from package.json "exports" for the same reason the
// public-API contract test derives its own — a hard-coded list drifts from the
// publish surface, and the drift is invisible.
//
// The source graph is only half the invariant, because the source is not what
// ships. The second half — `describe("the built dist/…")` at the bottom of this
// file — asserts the same property against `dist/`, and it exists because the
// source walk is structurally blind to what the bundler does to a specifier: the
// source said `node:fs` and tsup emitted `fs`, which every check here called
// clean.

const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // <root>/src/dev/… -> <root>
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
  exports: Record<string, string | { import?: string }>;
};

const DEV_PREFIX = `src${sep}dev${sep}`;

/**
 * The published JS entry points, as `{ subpath, file, target }` — the source
 * behind each one, and the built file a consumer actually resolves.
 */
const jsEntries = Object.entries(pkg.exports).flatMap(([subpath, target]) => {
  if (typeof target !== "object" || !target.import) return [];
  const source = target.import.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
  return [{ subpath, file: join(rootDir, source), target: target.import }];
});

const devEntries = jsEntries.filter(e => e.subpath.startsWith("./dev/"));
const otherEntries = jsEntries.filter(e => !e.subpath.startsWith("./dev/"));

const parsedConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(rootDir, "tsconfig.json"), fileName => ts.sys.readFile(fileName)).config,
  ts.sys,
  rootDir,
);

/** Repo-relative source files a program over `files` actually pulls in. */
function reachableSources(files: string[]): string[] {
  const program = ts.createProgram(files, parsedConfig.options);
  return program
    .getSourceFiles()
    .filter(sourceFile => !sourceFile.isDeclarationFile)
    .map(sourceFile => relative(rootDir, sourceFile.fileName));
}

describe("./dev/** is a leaf", () => {
  it("is exported at all, so the checks below are not vacuous", () => {
    expect(devEntries.map(e => e.subpath)).toContain("./dev/sdk-link");
  });

  it("is not reachable from any other entry point", () => {
    const leaked = reachableSources(otherEntries.map(e => e.file)).filter(file =>
      file.startsWith(DEV_PREFIX),
    );
    expect(leaked).toEqual([]);
  });

  // Guards the guard: if `DEV_PREFIX` ever stops matching how the files are
  // named, the check above passes for the wrong reason.
  it("is reachable from its own entry point", () => {
    const own = reachableSources(devEntries.map(e => e.file)).filter(file =>
      file.startsWith(DEV_PREFIX),
    );
    expect(own).toContain(join("src", "dev", "sdk-link.ts"));
  });

  // The bin is not an export subpath, so the walk above would never see it. It
  // is still shipped, so it gets the same treatment from the other direction:
  // nothing but `./dev` may reach it either.
  it("keeps the bin out of every entry point's graph, including its own subpath", () => {
    const reachable = reachableSources(jsEntries.map(e => e.file));
    expect(reachable).not.toContain(join("src", "dev", "sdk-link-bin.ts"));
  });
});

// ─── The same invariant, against what actually ships ─────────────────────────

const distDir = join(rootDir, "dist");

/** Node built-ins, by their bare name — `node:fs` and `fs` both reduce to `fs`. */
const BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

const isBuiltin = (specifier: string): boolean =>
  BUILTINS.has(specifier.replace(/^node:/, "")) && !specifier.startsWith(".");

/**
 * Every `.js` file under `dir`, recursively.
 *
 * Tolerates an absent directory so an unbuilt tree fails on the one assertion
 * that names the fix, rather than on an ENOENT stack that does not.
 */
function builtFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return builtFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

/**
 * Specifiers a built file imports or re-exports.
 *
 * Parsed rather than regexed: a regex over emitted JS mistakes a specifier in a
 * string or a comment for an import. Top-level statements only, which is all
 * this package's output has — tsup emits static ESM, no dynamic `import()`.
 */
function specifiersOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.JS,
  );
  return source.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    const specifier = statement.moduleSpecifier;
    return specifier && ts.isStringLiteral(specifier) ? [specifier.text] : [];
  });
}

/** Built files reachable from `entry` by following its relative imports. */
function reachableBuilt(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
    }
  }
  return [...seen];
}

/** Every `builtin` specifier reachable from `entry`, as `file -> specifier`. */
function builtinsReachableFrom(entry: string): string[] {
  return reachableBuilt(entry).flatMap(file =>
    specifiersOf(file)
      .filter(isBuiltin)
      .map(specifier => `${relative(rootDir, file)} -> ${specifier}`),
  );
}

// `dist/` is what a consumer resolves, and it is not what the walk above reads.
// tsup rewrote every `node:fs` to a bare `fs` on the way out (`removeNodeProtocol`
// defaults to true in tsup 8), so the shipped artifact asked for an ordinary bare
// specifier — which a bundler is free to resolve to a userland `fs` shim instead
// of failing loudly — while every source-level check in this file stayed green.
describe("the built dist/ keeps Node built-ins where the source put them", () => {
  it("is built at all, so the checks below are not vacuous", () => {
    // Deliberately a failure rather than a skip: a check that quietly does
    // nothing is the reason the rewrite shipped. `npm run build` fixes it.
    expect(
      existsSync(distDir),
      "dist/ is missing — run `npm run build` before the tests, nothing builds it for you.",
    ).toBe(true);
  });

  it("imports every built-in under the node: prefix, never as a bare specifier", () => {
    const bare = builtFiles(distDir).flatMap(file =>
      specifiersOf(file)
        .filter(specifier => isBuiltin(specifier) && !specifier.startsWith("node:"))
        .map(specifier => `${relative(rootDir, file)} -> ${specifier}`),
    );
    expect(bare).toEqual([]);
  });

  it("keeps every Node built-in out of the non-dev entry points' built graphs", () => {
    const leaked = otherEntries.flatMap(entry =>
      builtinsReachableFrom(join(rootDir, entry.target)),
    );
    expect(leaked).toEqual([]);
  });

  // Guards the guard: the two checks above pass trivially if nothing in the
  // built output imports a built-in at all.
  it("still reaches node:fs from ./dev/sdk-link's own built graph", () => {
    const reached = devEntries.flatMap(entry => builtinsReachableFrom(join(rootDir, entry.target)));
    expect(reached.some(line => line.endsWith("-> node:fs"))).toBe(true);
  });
});

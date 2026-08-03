#!/usr/bin/env node
/**
 * Clean-room install check (PDEV-7001).
 *
 * Packs the tarball, installs it in a temp directory OUTSIDE this repo, and
 * imports every JS entry point. This is the guard that external installability
 * has not silently broken.
 *
 * Why it cannot be a unit test: `npm test` resolves `src/`, and `check:package`
 * (publint + attw) reads the export map statically. Neither of them ever
 * *executes* the published artefact from a consumer's position. The failures
 * this catches are the ones only a real install shows — a subpath missing from
 * `files`, a `.js` extension dropped from a relative import, a dependency that
 * was devDependency-only, a `dist/` file the build forgot to emit.
 *
 * It matters more than usual for 0.18.0: the SDK is the only artifact in the
 * organisation with a working publish pipeline, and three repos install it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

/** Every JS entry point. The CSS asset is not importable, so it is excluded. */
const subpaths = Object.keys(pkg.exports).filter(key => !key.endsWith(".css"));

/**
 * The React peers at the versions this package actually declares.
 *
 * A bare `npm install react` resolves to whatever is newest, so the day React
 * ships a major outside the declared peer range this gate starts failing for a
 * reason that has nothing to do with the SDK — a release gate that breaks on the
 * calendar is worse than no gate. Derived from `package.json` rather than
 * hardcoded so the two cannot drift apart.
 */
const peerRanges = pkg.peerDependencies ?? {};
const peerSpecs = [
  ...Object.entries(peerRanges).map(([name, range]) => `${name}@${range}`),
  // Not a declared peer and nothing under src/ imports it, but React and
  // react-dom ship in lockstep and peer graphs expect the pair to agree.
  ...(peerRanges.react ? [`react-dom@${peerRanges.react}`] : []),
];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

console.log(`clean-room: packing ${pkg.name}@${pkg.version}`);
const tarball = run("npm", ["pack", "--silent"], repo).trim().split("\n").pop();

// Outside the repo on purpose: inside it, Node would resolve through the local
// node_modules and the check would pass without proving anything.
const dir = mkdtempSync(join(tmpdir(), "bb-sdk-cleanroom-"));
let failed = false;

try {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "cleanroom", private: true, type: "module" }, null, 2),
  );

  console.log(`clean-room: installing into ${dir}`);
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", join(repo, tarball)], dir);

  // React and @tanstack/react-query are optional peers — install them so the
  // React-only entry points can be imported too, rather than skipped.
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", ...peerSpecs], dir);

  const probe = subpaths
    .map(sub => {
      const spec = sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
      return `try {
  const m = await import(${JSON.stringify(spec)});
  console.log("  ok   ${sub}  (" + Object.keys(m).length + " exports)");
} catch (err) {
  console.log("  FAIL ${sub}  " + (err && err.message ? err.message.split("\\n")[0] : err));
  process.exitCode = 1;
}`;
    })
    .join("\n");

  writeFileSync(join(dir, "probe.mjs"), probe);
  console.log(`clean-room: importing ${subpaths.length} entry points`);
  process.stdout.write(run("node", ["probe.mjs"], dir));
} catch (err) {
  failed = true;
  // Echo the child's captured stdout BEFORE the summary. `run` pipes stdout, so
  // when `probe.mjs` exits non-zero `execFileSync` throws and the per-subpath
  // "FAIL <subpath> <reason>" lines are on the error, not the terminal. Without
  // this a CI log says only that the gate failed, never which entry point.
  const captured = typeof err?.stdout === "string" ? err.stdout : "";
  if (captured.length > 0) process.stdout.write(captured);
  console.error("clean-room: FAILED —", err instanceof Error ? err.message : err);
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(repo, tarball), { force: true });
}

if (failed) process.exitCode = 1;
if (process.exitCode) {
  console.error("\nclean-room: at least one entry point is not importable from a real install.");
} else {
  console.log(`\nclean-room: all ${subpaths.length} entry points import cleanly.`);
}

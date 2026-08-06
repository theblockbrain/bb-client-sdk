#!/usr/bin/env node
/**
 * Clean-room install check (PDEV-7001).
 *
 * Packs the tarball, installs it in a temp directory OUTSIDE this repo, and
 * imports every JS entry point. This is the guard that external installability
 * has not silently broken.
 *
 * Three phases, each catching what the previous one cannot:
 *   1. import every entry point with the peers installed  — is it installable at all?
 *   2. import them again with NO react                    — did React leak into the core?
 *   3. typecheck them as a DOM-less Node consumer         — do the declarations compile?
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

  bareNodeGate();
  nodeTypesGate();
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

/**
 * Second phase: import every React-free entry point from an install with **no**
 * React at all — which is `bb-slack-integrations`' situation (Node, no DOM, no
 * React) and a bare-Node smoke test's.
 *
 * The phase above cannot catch a React leak because it installs the peers first.
 * That is exactly how `.` shipped in 0.18.0 re-exporting `./ui` -> `useTheme`:
 * every gate was green and the root barrel was still unimportable without React.
 *
 * `./react` and `./ui/react` are expected to fail here — they are the React
 * layers. Asserting they DO fail keeps this gate honest: if they ever import
 * cleanly, React stopped being a real peer and the split lost its meaning.
 */
function bareNodeGate() {
  const reactOnly = new Set(["./react", "./ui/react"]);
  const bare = mkdtempSync(join(tmpdir(), "bb-sdk-barenode-"));
  try {
    writeFileSync(
      join(bare, "package.json"),
      JSON.stringify({ name: "barenode", private: true, type: "module" }, null, 2),
    );
    run("npm", ["install", "--silent", "--no-audit", "--no-fund", join(repo, tarball)], bare);

    const checks = subpaths
      .map(sub => {
        const spec = sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
        const wantFail = reactOnly.has(sub);
        return `try {
  await import(${JSON.stringify(spec)});
  ${
    wantFail
      ? `console.log("  FAIL ${sub}  imported without react — it is meant to need it");
  process.exitCode = 1;`
      : `console.log("  ok   ${sub}");`
  }
} catch (err) {
  const msg = (err && err.message ? err.message : String(err)).slice(0, 100);
  ${
    wantFail
      ? `console.log("  ok   ${sub}  (correctly needs react)");`
      : `console.log("  FAIL ${sub}  " + msg);
  process.exitCode = 1;`
  }
}`;
      })
      .join("\n");

    writeFileSync(join(bare, "probe.mjs"), checks);
    console.log(`\nclean-room: importing ${subpaths.length} entry points with NO react installed`);
    process.stdout.write(run("node", ["probe.mjs"], bare));
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
}

/**
 * Third phase: **typecheck** the installed package as a DOM-less Node consumer.
 *
 * The two phases above only *import*, so they are blind to a type-level break —
 * and a consumer whose build fails does not care that `node -e "import(...)"`
 * worked. PDEV-7724 found exactly that: `.` was fixed at runtime while `./ui`'s
 * declarations still named the DOM's `Document` / `Element` / `DocumentFragment`,
 * which exist only in TypeScript's `dom` lib. `@types/node` does not declare them,
 * so `bb-slack-integrations` could import the barrel and still fail `tsc` on
 * declarations it never calls. Every gate was green.
 *
 * Hence `lib: ["ES2022"]` with **no** `dom`, and `skipLibCheck: false` so the
 * package's own `.d.ts` files are actually checked rather than trusted. React
 * Native is the stricter version of this consumer (no DOM lib *and* no
 * `@types/node`); it is not modelled here because `AbortSignal`, `Blob`, `File`,
 * `FormData` and `URL` legitimately appear in `./api` and are provided by every
 * real runtime — pretending otherwise would mean weakening those signatures.
 *
 * `typescript` and `@types/node` are installed at the versions this repo pins, for
 * the same reason `peerSpecs` derives the React range from `package.json`: a gate
 * that floats to whatever npm ships today breaks on the calendar.
 *
 * The React entry points are excluded — they need React's types, which a Node
 * consumer has no reason to install. Phase 2 already proves they are React-only.
 */
function nodeTypesGate() {
  const reactOnly = new Set(["./react", "./ui/react"]);
  const typed = subpaths.filter(sub => !reactOnly.has(sub));
  const dev = pkg.devDependencies ?? {};
  const toolchain = [`typescript@${dev.typescript}`, `@types/node@${dev["@types/node"]}`];

  const types = mkdtempSync(join(tmpdir(), "bb-sdk-types-"));
  try {
    writeFileSync(
      join(types, "package.json"),
      JSON.stringify({ name: "typescheck", private: true, type: "module" }, null, 2),
    );
    run("npm", ["install", "--silent", "--no-audit", "--no-fund", join(repo, tarball)], types);
    run("npm", ["install", "--silent", "--no-audit", "--no-fund", ...toolchain], types);

    writeFileSync(
      join(types, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "nodenext",
            moduleResolution: "nodenext",
            target: "ES2022",
            // No "DOM" on purpose — that is the whole point of this phase.
            lib: ["ES2022"],
            types: ["node"],
            strict: true,
            skipLibCheck: false,
            noEmit: true,
          },
          include: ["probe.ts"],
        },
        null,
        2,
      ),
    );

    const imports = typed
      .map(sub => {
        const spec = sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
        return `import ${JSON.stringify(spec)};`;
      })
      .join("\n");
    writeFileSync(join(types, "probe.ts"), `${imports}\n`);

    console.log(
      `\nclean-room: typechecking ${typed.length} entry points as a Node consumer (no DOM lib)`,
    );
    const tsc = join(types, "node_modules", "typescript", "bin", "tsc");
    run(process.execPath, [tsc, "-p", "tsconfig.json"], types);
    for (const sub of typed) console.log(`  ok   ${sub}`);
  } finally {
    rmSync(types, { recursive: true, force: true });
  }
}

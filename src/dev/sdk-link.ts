/// <reference types="node" />
/**
 * Point `@theblockbrain/bb-client-sdk` at a local checkout, and put it back —
 * `@theblockbrain/bb-client-sdk/dev/sdk-link`, plus the `bb-sdk-link` bin.
 *
 * The SDK is consumed from GitHub Packages at a pinned version, not as a
 * workspace dependency, so a change made in a local SDK checkout is invisible to
 * a consumer until it is released. That makes the unreleased surface untestable,
 * which is the gap this bridges.
 *
 * Why a script rather than a package-manager command. `npm install --no-save
 * file:../bb-client-sdk` resolves to a symlink without touching either manifest,
 * but bun has no `--no-save`: `bun link` writes a `link:` entry into
 * package.json, and `bun add file:../…` rewrites package.json *and* bun.lock.
 * Both leave a local path staged for commit. So the link is made where the
 * dependency is actually resolved from, and no manifest is read or written by
 * either direction of this module.
 *
 * The displaced published entry is moved aside rather than deleted, so `unlink`
 * restores it without reinstalling. Its presence is also the single source of
 * truth for "is a link currently in place" — inferring that from what the
 * symlink points at would misread a package manager's own store symlink as ours.
 *
 * ─── Why it lives here, and why it is a leaf ─────────────────────────────────
 *
 * Four surfaces had solved this, in two incompatible ways, with one confirmed
 * divergence bug between two copies of the *same* solution (see
 * {@link removeEntry}). `ms-word-addin` and `ms-outlook-addin` each carry a
 * script; `ms-powerpoint-addin` uses the cruder `npm install --no-save file:`
 * that the paragraph above argues against. Sharing the engine is the only way
 * the fix reaches all of them.
 *
 * **This module pulls `node:fs` and `node:path` into a package that also ships a
 * React Native condition** on every other subpath. It is therefore a LEAF: it is
 * exported only as its own subpath, nothing under `src/` imports it, and the `.`
 * barrel must never re-export it. Its own subpath declares no `react-native`
 * condition either — that is exactly the condition a Node-only dev entry point
 * must not carry, since it invites a bundler to resolve what should never be
 * bundled. `sdk-link.leaf.test.ts` enforces both halves: a TypeScript program
 * over every other entry point that fails if any of them reaches this directory,
 * and a walk of the BUILT `dist/` for the same property, because the source is
 * not the artifact a consumer resolves.
 *
 * Everything here takes its paths from an injected {@link SdkLinkLayout} and
 * throws rather than exiting, so the filesystem moves are exercised against
 * temporary directories in the tests. The process-level concerns (argv, the real
 * paths, the exit code) live in {@link runSdkLinkCli} and
 * {@link deriveSdkLinkLayout}, and a surface that wants its own wrapper composes
 * `link`/`unlink` directly.
 */

import type { Dirent } from "node:fs";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** The npm scope directory the entry sits under, inside `node_modules`. */
const SCOPE_DIR = "@theblockbrain";
const PACKAGE_NAME = "bb-client-sdk";
const BACKUP_NAME = ".bb-client-sdk.published";

/** Every refusal in here. Thrown, so a test can assert on it and only the CLI exits. */
export class SdkLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdkLinkError";
    // Preserve prototype so `instanceof` survives bundler realms — same reason
    // `BBApiError` does it.
    Object.setPrototypeOf(this, SdkLinkError.prototype);
  }
}

function fail(message: string): never {
  throw new SdkLinkError(message);
}

/** What is at `path`, without following a link — the link itself is the subject. */
function entryKind(path: string): "absent" | "symlink" | "directory" {
  try {
    return lstatSync(path).isSymbolicLink() ? "symlink" : "directory";
  } catch {
    return "absent";
  }
}

/**
 * Remove a `node_modules` entry, whatever it is.
 *
 * `unlinkSync` for a symlink, `rmSync` only for a real directory. A bare
 * `rmSync` resolves a link's target before deciding what it is, which Node
 * 24.13.0 refuses with `EISDIR` — and 24.13.0 is the version moon pins for CI,
 * so a bare `rmSync` passes on a developer's newer Node and fails only there.
 *
 * This is the divergence bug that justified sharing the engine: two add-ins
 * carry the same script and only one carries this fix.
 */
function removeEntry(path: string): void {
  if (entryKind(path) === "symlink") {
    unlinkSync(path);
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

/** A semver range evaluator, injectable so the decision below is testable. */
export type SemverSatisfies = (version: string, range: string) => boolean;

/** The slice of the `Bun` global {@link detectSemverSatisfies} reads. */
interface BunSemverGlobal {
  semver?: { satisfies?: (version: string, range: string) => boolean };
}

/**
 * Bun's own range evaluator, or `null` when Bun is not the runtime.
 *
 * Read off `globalThis` structurally rather than through an ambient `Bun`
 * declaration: this package takes no dependency on `@types/bun`, and a bare
 * `typeof Bun` would not compile without one. Resolved inside the function, not
 * at module scope, because a platform global dereferenced at import time breaks
 * the import rather than the call.
 *
 * `null` is a real answer, not a failure — under Node (which is where the tests
 * run, and where the `bb-sdk-link` bin runs for an npm consumer) there is no
 * range evaluator, and {@link mismatchWarning} then stays quiet rather than
 * guessing.
 */
export function detectSemverSatisfies(): SemverSatisfies | null {
  const bun = (globalThis as { Bun?: BunSemverGlobal }).Bun;
  const satisfies = bun?.semver?.satisfies;
  if (typeof satisfies !== "function") return null;
  return (version, range) => satisfies(version, range);
}

/**
 * The warning to print when the linked build does not satisfy the declared
 * range, or `null` when there is nothing to say.
 *
 * Undecidable inputs — either side unknown, no evaluator, an unparseable range —
 * return `null` and stay quiet. A false mismatch trains the reader to ignore the
 * line, which costs more than a missed one: the consequence of a real mismatch
 * is already visible as the next install restoring the pin.
 */
export function mismatchWarning(
  linked: string | null,
  range: string | null,
  satisfies: SemverSatisfies | null = detectSemverSatisfies(),
): string | null {
  if (!linked || !range || !satisfies) return null;
  try {
    if (satisfies(linked, range)) return null;
  } catch {
    return null;
  }
  return (
    `  ⚠ ${linked} does not satisfy ${range}. ` +
    "Installing dependencies again will replace the link with the declared version."
  );
}

function readVersion(packageDir: string): string | null {
  try {
    const raw = readFileSync(join(packageDir, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Which branch and commit the checkout is on, read straight from `.git`.
 *
 * The point of linking is to test a specific unreleased branch, and the version
 * in `package.json` cannot tell you which one: every branch off `main` reads the
 * same number, so the version line alone looks identical whether you linked the
 * branch you meant or the one you left checked out last week.
 *
 * Read rather than shelled out to `git`, so this stays a pure function of the
 * filesystem and is testable against a fixture directory. A detached HEAD gives
 * a bare sha, and anything unreadable gives `null` rather than throwing: not
 * knowing the branch is not a reason to refuse a link.
 */
export function describeCheckout(sdkPath: string): {
  branch: string | null;
  commit: string | null;
} {
  const readHead = (): string | null => {
    try {
      return readFileSync(join(sdkPath, ".git", "HEAD"), "utf8").trim();
    } catch {
      return null;
    }
  };

  const head = readHead();
  if (head === null) return { branch: null, commit: null };

  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (!ref) {
    // Detached HEAD: the file holds the sha itself.
    return { branch: null, commit: head.slice(0, 9) };
  }

  const branch = ref[1];
  const commit = (() => {
    try {
      return readFileSync(join(sdkPath, ".git", "refs", "heads", branch), "utf8")
        .trim()
        .slice(0, 9);
    } catch {
      // Packed refs, or a ref file that is not there. The branch name is the
      // part that matters, so do not fail over a missing sha.
      return null;
    }
  })();

  return { branch, commit };
}

/** Directory entries, or none when the directory cannot be read. */
function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Newest mtime under `dir`, or 0 when it cannot be walked. */
function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (current: string): void => {
    for (const entry of readEntries(current)) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const { mtimeMs } = statSync(full);
        if (mtimeMs > newest) newest = mtimeMs;
      } catch {
        // Vanished mid-walk. Not worth failing a diagnostic over.
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Warn when `dist/` is older than `src/`, or `null` when it is not.
 *
 * The SDK builds to `dist/` and does not watch by default, so editing a source
 * file changes nothing a consumer can see. That failure is completely silent:
 * the link succeeds, the version matches, and the surface quietly runs the
 * previous build. Checking existence does not catch it, because the directory is
 * there and populated.
 *
 * Deliberately a warning rather than a refusal: a comment-only or test-only edit
 * moves `src/` without changing what `dist/` should contain, and refusing there
 * would be wrong.
 */
export function staleDistWarning(sdkPath: string): string | null {
  const src = newestMtime(join(sdkPath, "src"));
  const dist = newestMtime(join(sdkPath, "dist"));
  if (src === 0 || dist === 0 || dist >= src) return null;
  return (
    "  ⚠ dist/ is older than src/. You would be linking a STALE build.\n" +
    `    Run the SDK's build in ${sdkPath} first (nothing builds it for you).`
  );
}

/**
 * A `dist/` carrying JavaScript but no declarations.
 *
 * `bun run build` in the SDK is `tsup && tsc -p tsconfig.build.json`: tsup emits
 * the JS, and the SEPARATE tsc pass emits every `.d.ts`. So anything that runs
 * tsup alone leaves a dist that loads fine and types as nothing. `bun run dev`
 * (`tsup --watch`) is exactly that, and it is the natural thing to run while
 * iterating on a linked SDK.
 *
 * The consumer symptom is not a missing module. Every SDK value resolves to
 * `unknown`, so the errors surface far from the cause and read like the add-in's
 * own bug: `Property 'kind' does not exist on type 'unknown'`. Worse, `vitest`
 * keeps passing (it strips types) while only the webpack build fails, so the
 * cheap gate says green.
 */
export function typelessDistWarning(sdkPath: string): string | null {
  const dist = join(sdkPath, "dist");
  if (!existsSync(dist)) return null;
  if (hasDeclaration(dist)) return null;
  return (
    `  ⚠ dist/ has no .d.ts files, so every SDK type resolves to \`unknown\`.\n` +
    `    Something ran tsup without the declaration pass (\`bun run dev\` does).\n` +
    `    Run \`bun run build\` in ${sdkPath}.`
  );
}

/** First declaration found, depth-first. Stops early: one is enough to answer. */
function hasDeclaration(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (hasDeclaration(join(dir, entry.name))) return true;
    } else if (entry.name.endsWith(".d.ts")) {
      return true;
    }
  }
  return false;
}

/** Everything either direction of this module needs to know about the install. */
export interface SdkLinkLayout {
  /** The local SDK checkout to link to. Absolute. */
  sdkPath: string;
  /** The consuming package's own `node_modules/@theblockbrain`. The only directory written. */
  packageScope: string;
  /** The workspace-root scope. Read to produce a better refusal, never written by `link`. */
  rootScope: string;
  /** The range the consumer's package.json declares, or `null` when it could not be read. */
  declaredRange: string | null;
  /** Where progress goes. Injected so tests can assert on it instead of the console. */
  log?: (line: string) => void;
  /**
   * Range evaluator override.
   *
   * `undefined` means "work it out" ({@link detectSemverSatisfies}); an explicit
   * `null` means "there is none, stay quiet". The two are distinguished rather
   * than collapsed with `??`, so a caller can genuinely suppress the mismatch
   * line instead of silently getting Bun's evaluator back.
   */
  satisfies?: SemverSatisfies | null;
}

/** The evaluator to use, honouring an explicit `null` as "none". */
function evaluatorFor(layout: SdkLinkLayout): SemverSatisfies | null {
  return layout.satisfies === undefined ? detectSemverSatisfies() : layout.satisfies;
}

/**
 * The scope directory to link in: the consuming package's own, and only ever
 * that one.
 *
 * A hoisting install would put the entry at the workspace root instead. That
 * root entry is SHARED — a sibling workspace resolves the same dependency
 * through it, on its own pin — so replacing it would swap the SDK underneath
 * another package while this module reported success. Refusing is the honest
 * outcome: nothing here can create a package-local override that `unlink` would
 * reliably recognise later, since the displaced-entry backup is what marks a
 * link as ours.
 */
function resolveLinkScope(layout: SdkLinkLayout): string {
  if (entryKind(join(layout.packageScope, PACKAGE_NAME)) !== "absent") return layout.packageScope;

  if (entryKind(join(layout.rootScope, PACKAGE_NAME)) !== "absent") {
    return fail(
      `${SCOPE_DIR}/${PACKAGE_NAME} is installed at the workspace root, not under this package.\n` +
        `  Found ${join(layout.rootScope, PACKAGE_NAME)}\n` +
        "  That entry is shared with every other package that resolves the SDK through it, so this script will not replace it.\n" +
        `  Install dependencies so ${layout.packageScope} carries its own entry, then retry.`,
    );
  }

  return fail(
    `${SCOPE_DIR}/${PACKAGE_NAME} is not installed.\n  Looked in ${layout.packageScope}\n  and in ${layout.rootScope}\n  Install dependencies at the workspace root first.`,
  );
}

/**
 * Say out loud what was actually linked: version, branch, commit, and whether
 * the build is stale or the version outside the declared range.
 *
 * All four are things that make the link look like it worked while the surface
 * runs something other than what you meant.
 *
 * Only ever called once a link is known to be in place. Everything here reads
 * the link rather than the layout, so it describes what a surface RESOLVES; run
 * against a checkout that is not linked it would read as if it were.
 */
function report(layout: SdkLinkLayout, linkPath: string): void {
  const log = layout.log ?? console.log;

  const linked = readVersion(linkPath);
  // Whatever the link actually points at, not the checkout this layout would
  // link. `status` can find a link an older version of this script left at the
  // workspace root, pointing somewhere else entirely, and naming `sdkPath` there
  // would report a branch nothing is running.
  const checkout = linkTarget(linkPath) ?? layout.sdkPath;
  const { branch, commit } = describeCheckout(checkout);
  const at = branch ? `${branch}${commit ? ` @ ${commit}` : ""}` : (commit ?? "unknown");

  log(`  branch: ${at}`);
  log(
    `  version: ${linked ?? "unknown"}   package.json declares: ${layout.declaredRange ?? "unknown"}`,
  );

  const stale = staleDistWarning(checkout);
  if (stale) log(stale);

  const typeless = typelessDistWarning(checkout);
  if (typeless) log(typeless);

  const mismatch = mismatchWarning(linked, layout.declaredRange, evaluatorFor(layout));
  if (mismatch) log(mismatch);
}

/** Where an entry points, resolved to an absolute path, or `null` when it is not a link. */
function linkTarget(linkPath: string): string | null {
  if (entryKind(linkPath) !== "symlink") return null;
  try {
    return resolve(dirname(linkPath), readlinkSync(linkPath));
  } catch {
    return null;
  }
}

/**
 * The scopes a link of ours can be in, in the order every reading direction
 * walks them.
 *
 * `link` only ever writes the package scope, but an older version of this script
 * could leave one at the workspace root. Anything that ANSWERS "is a link in
 * place" has to look in both, or it disagrees with `unlink` about the same
 * install — `status` reporting the published version while every import resolves
 * into the local checkout.
 */
function linkScopes(layout: SdkLinkLayout): readonly string[] {
  return [layout.packageScope, layout.rootScope];
}

/**
 * The scope holding a link of ours, or `null` when there is none.
 *
 * The displaced-entry backup is the marker, for the reason given at the top of
 * this file: what the symlink points at cannot distinguish our link from a
 * package manager's own store pointer.
 */
function linkedScope(layout: SdkLinkLayout): string | null {
  return linkScopes(layout).find(scope => entryKind(join(scope, BACKUP_NAME)) !== "absent") ?? null;
}

/** Whether a link made by this module is currently in place, in either scope. */
export function isLinked(layout: SdkLinkLayout): boolean {
  return linkedScope(layout) !== null;
}

export function link(layout: SdkLinkLayout): void {
  const log = layout.log ?? console.log;

  if (!existsSync(layout.sdkPath)) {
    fail(`No SDK checkout at ${layout.sdkPath}. Clone it there, or set BB_SDK_PATH.`);
  }

  // dist/ is git-ignored in the SDK, so a fresh clone has none and a stale one
  // serves stale code. Absence is fatal, staleness is a warning in `report`.
  if (!existsSync(join(layout.sdkPath, "dist"))) {
    fail(`${layout.sdkPath}/dist is missing. Build the SDK first, nothing builds it for you.`);
  }

  const scope = resolveLinkScope(layout);
  const linkPath = join(scope, PACKAGE_NAME);
  const backupPath = join(scope, BACKUP_NAME);

  if (
    entryKind(linkPath) === "symlink" &&
    resolve(scope, readlinkSync(linkPath)) === layout.sdkPath
  ) {
    log(`• Already linked → ${layout.sdkPath}`);
    report(layout, linkPath);
    return;
  }

  if (entryKind(backupPath) === "absent") {
    // First link: preserve the published entry exactly as installed. `renameSync`
    // moves a symlink without following it, so the store pointer survives.
    renameSync(linkPath, backupPath);
  } else {
    // A backup already exists, so what is here now is a previous link of ours.
    // Overwriting the backup would discard the only restorable published entry.
    removeEntry(linkPath);
  }

  // Relative, so the link keeps working from a git worktree of the consumer.
  symlinkSync(relative(scope, layout.sdkPath), linkPath, "dir");
  log(`✓ Linked ${SCOPE_DIR}/${PACKAGE_NAME} → ${layout.sdkPath}`);
  log(`  via ${linkPath}`);
  report(layout, linkPath);
  log("  Restart the dev server so the bundler re-resolves the dependency.");
}

/**
 * Put the published entry back.
 *
 * Still walks BOTH scopes, unlike `link`: an older version of this script could
 * leave a link at the workspace root, and the backup marker is what identifies
 * one. Reading a scope `link` refuses to write is the point — this direction
 * cleans up, it does not create.
 */
export function unlink(layout: SdkLinkLayout): void {
  const log = layout.log ?? console.log;

  for (const scope of linkScopes(layout)) {
    const linkPath = join(scope, PACKAGE_NAME);
    const backupPath = join(scope, BACKUP_NAME);

    // The backup is the only reliable marker that we linked. Without it, the
    // entry present is the package manager's own, and removing it would break
    // the install.
    if (entryKind(backupPath) === "absent") continue;

    if (entryKind(linkPath) !== "absent") removeEntry(linkPath);
    renameSync(backupPath, linkPath);

    // The backup is a symlink into a content-addressed store, keyed by version
    // and hash. An install that moved the pin (or pruned the store) between link
    // and unlink leaves it dangling, so confirm it still resolves rather than
    // reporting success over a broken dependency.
    const restored = readVersion(linkPath);
    if (restored === null) {
      log("⚠ Restored entry does not resolve — the install moved on while linked.");
      log("  Install dependencies at the workspace root to reinstall the pinned SDK.");
      return;
    }
    log(`✓ Restored the published ${SCOPE_DIR}/${PACKAGE_NAME}@${restored}`);
    log(`  via ${linkPath}`);
    return;
  }

  log("• Not linked — nothing to restore.");
}

// ─── The CLI ──────────────────────────────────────────────────────────────────

/** What {@link deriveSdkLinkLayout} reads instead of touching the process. */
export interface SdkLinkCliContext {
  /** The consuming package's directory. Normally `process.cwd()`. */
  cwd: string;
  /** `BB_SDK_PATH`, when the caller set it. */
  sdkPath?: string;
  /** Where progress goes. Defaults to `console.log`. */
  log?: (line: string) => void;
  /** Where refusals go. Defaults to `console.error`. */
  error?: (line: string) => void;
}

/**
 * The nearest ancestor of `dir` that has a `node_modules`, or `dir` itself.
 *
 * This is the workspace root as far as this tool is concerned: the directory a
 * hoisting install would have written to, and the anchor the default checkout
 * path is a sibling of. Started one level UP so a single-package consumer (whose
 * own `node_modules` is the only one) reports itself rather than nothing.
 */
function findWorkspaceRoot(dir: string): string {
  let current = dirname(dir);
  while (true) {
    if (existsSync(join(current, "node_modules"))) return current;
    const parent = dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
}

/** The range the consuming package declares for the SDK, in either dependency block. */
function readDeclaredRange(packageDir: string): string | null {
  try {
    const raw = readFileSync(join(packageDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const spec = `${SCOPE_DIR}/${PACKAGE_NAME}`;
    return parsed.dependencies?.[spec] ?? parsed.devDependencies?.[spec] ?? null;
  } catch {
    return null;
  }
}

/**
 * Work out the layout from the consuming package's directory.
 *
 * The generic half of what each add-in used to hardcode. A surface with a layout
 * this cannot describe (a pnpm virtual store, a non-standard workspace) builds
 * an {@link SdkLinkLayout} itself and calls {@link link} directly — that is why
 * the engine takes the layout as data rather than deriving it internally.
 *
 * The checkout defaults to a sibling of the workspace root, which is how it is
 * laid out in practice (`Glassbox/botticelli` next to `Glassbox/bb-client-sdk`).
 */
export function deriveSdkLinkLayout(context: SdkLinkCliContext): SdkLinkLayout {
  const cwd = resolve(context.cwd);
  const workspaceRoot = findWorkspaceRoot(cwd);
  return {
    sdkPath: context.sdkPath
      ? resolve(context.sdkPath)
      : resolve(workspaceRoot, "..", PACKAGE_NAME),
    packageScope: join(cwd, "node_modules", SCOPE_DIR),
    rootScope: join(workspaceRoot, "node_modules", SCOPE_DIR),
    declaredRange: readDeclaredRange(cwd),
    log: context.log,
  };
}

const USAGE = "Usage: bb-sdk-link <link|unlink|status>";

/**
 * Run one CLI command and return the process exit code.
 *
 * Returns rather than exits, so the argv handling is a unit test instead of a
 * subprocess. The bin (`sdk-link-bin.ts`) is the only place that touches
 * `process`.
 */
export function runSdkLinkCli(argv: readonly string[], context: SdkLinkCliContext): number {
  const log = context.log ?? console.log;
  const error = context.error ?? console.error;
  const layout = deriveSdkLinkLayout(context);

  try {
    const command = argv[0];
    if (command === "link") {
      link(layout);
      return 0;
    }
    if (command === "unlink") {
      unlink(layout);
      return 0;
    }
    if (command === "status") {
      const scope = linkedScope(layout);
      if (scope === null) {
        // No `report`: it describes the link, and there is none. Naming a branch
        // and warning about a stale build here reads as "you are running your
        // checkout", which is the opposite of what this line says.
        log("• Not linked (using the published version)");
        log(`  package.json declares: ${layout.declaredRange ?? "unknown"}`);
        return 0;
      }
      const linkPath = join(scope, PACKAGE_NAME);
      log(`• Linked → ${linkTarget(linkPath) ?? layout.sdkPath}`);
      log(`  via ${linkPath}`);
      report(layout, linkPath);
      return 0;
    }
    fail(USAGE);
  } catch (err) {
    error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

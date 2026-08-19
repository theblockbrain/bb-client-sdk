#!/usr/bin/env node
/**
 * Verify a PUBLISHED version really contains the surface its source claimed.
 *
 * Sibling to `release-status.mjs`, and a different question. That one answers
 * "which version is out there"; this one answers "does that version contain what
 * it says on the tin". Both were needed to see the failure below, and only the
 * first existed.
 *
 * ─── The failure this exists to kill ─────────────────────────────────────────
 *
 * `v0.18.0` was tagged at 16:59 on 2026-08-06, pointing at the dependency-floor
 * merge. `publish.yml` fires on a `v*` tag push, so it published from THAT commit.
 * The client-executed tool relay merged at 19:39 the same evening — two hours and
 * forty minutes late, and therefore absent from the artifact.
 *
 * Nothing caught it. The tag existed, the version resolved, `release-status`
 * reported no divergence (tag and registry agreed), the CHANGELOG described the
 * relay, and the release notes were later edited to fold the relay in under
 * `0.18.0` on the belief that no `0.18.0` had shipped. Every signal a human reads
 * said the relay was released. It was not: the string `externalTools` appeared
 * nowhere in the published `dist/`.
 *
 * It surfaced five days later, in a consumer, as silence — `packages/word-addin`
 * declared `^0.18.0`, passed `externalTools`, and the field was dropped from the
 * request body with no error, no 4xx and no log. The agent was offered document
 * tools it could never call.
 *
 * ─── Why it checks the contract snapshot, not a hand-picked symbol ───────────
 *
 * `src/public-api.contract.test.ts` already snapshots every exported name of every
 * entry point, and CI keeps it honest at BUILD time. This reads the same snapshot
 * and asks whether the SHIPPED tarball carries those names. So the gate needs no
 * per-release curation: whatever the source claims to export is what the artifact
 * is held to, and a release cut from a commit that predates a feature fails on
 * that feature's own exports.
 *
 * ─── What a pass does and does not prove ─────────────────────────────────────
 *
 * The asymmetry is deliberate. **Absence proves the symbol is missing** from the
 * artifact, which is exactly the 0.18.0 failure. **Presence does not prove it is
 * correctly exported** — that is the contract test's job, run against source, in
 * CI. This is the artifact-level backstop for the one thing the contract test
 * structurally cannot see: that the bytes on the registry came from the commit
 * you think they did.
 *
 * One further limit, worth stating because it is not obvious. The expectation is
 * read at the tag (see `readExpectedSurface`), so the default check asks "is this
 * artifact consistent with what its own commit claimed" — and a tag cut too early
 * carries that early commit's snapshot too, so the two agree and the run is
 * green. The default mode therefore CANNOT, by itself, detect the 0.18.0 shape.
 * Two things cover it: the `ℹ` lag line, which lists what this checkout exports
 * and the tag did not, and `--symbol <name>`, which asks the direct question
 * "is the thing the notes promise actually in the bytes". Reading the expectation
 * from the working tree instead would catch it — and would also flag every
 * unreleased local export as a missing one, on every run, which is how a check
 * stops being read.
 *
 * ─── This one IS a gate ──────────────────────────────────────────────────────
 *
 * Unlike `release-status.mjs`, it exits non-zero when it finds a problem, and the
 * codes are distinguishable so a caller can tell a broken ARTIFACT from a broken
 * CHECK:
 *
 *   0  every expected symbol is present
 *   1  symbols are missing — the artifact does not match the source
 *   2  could not verify — no `gh`, no auth, version not published, no `tar`, an
 *      unreachable registry, a tarball that would not unpack, or a run whose
 *      expectation fell back to the WORKING TREE (see `readExpectedSurface`): that
 *      baseline describes a checkout rather than the release, so a `✘` computed
 *      from it is not an accusation this script is entitled to make. A broken CHECK
 *      must never borrow code 1, or a flaky network reads as a bad artifact.
 *
 * Safe to run anywhere: it needs network and `gh auth`, so it belongs in the
 * release routine (Phase 5, after the publish) rather than in `ci.yml`, for the
 * same reason `release-status.mjs` stays out of CI.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/verify-published.mjs                 # the version in package.json
 *   node scripts/verify-published.mjs 0.19.0
 *   node scripts/verify-published.mjs latest          # newest on the registry
 *   node scripts/verify-published.mjs 0.19.0 --symbol externalTools   # targeted
 *   node scripts/verify-published.mjs --json           # machine-readable
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "theblockbrain";
const PKG = "bb-client-sdk";
const REGISTRY = "https://npm.pkg.github.com";
/** Repo-relative, because `git show <tag>:<path>` takes a path from the repo root. */
const SNAPSHOT_REL = "src/__snapshots__/public-api.contract.test.ts.snap";
const SNAPSHOT = join(repo, SNAPSHOT_REL);

const EXIT_OK = 0;
const EXIT_MISSING = 1;
const EXIT_CANNOT_VERIFY = 2;

// ─── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const json = argv.includes("--json");
/** `--symbol X` (repeatable) narrows the check; otherwise the whole snapshot is used. */
const symbolOverrides = argv
  .flatMap((arg, i) => (arg === "--symbol" ? [argv[i + 1]] : []))
  .filter(Boolean);
const requestedVersion =
  argv.find(arg => !arg.startsWith("--") && !symbolOverrides.includes(arg)) ?? null;

/** Bare `console.log` unless `--json`, so the human path stays readable. */
const say = line => {
  if (!json) console.log(line);
};

/**
 * The unpacked tarball, removed on every exit path.
 *
 * `fail()` calls `process.exit`, which does not run `finally` blocks — so the
 * explicit `finally` at the bottom covers only the success path, and each of the
 * eight `fail()` sites would otherwise leave a copy of the package in the temp
 * directory. Registered once here rather than repeated at each site.
 */
let tempDir = null;
process.on("exit", () => {
  if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
});

const fail = (code, message, extra = {}) => {
  if (json) {
    console.log(JSON.stringify({ ok: false, reason: message, ...extra }, null, 2));
  } else {
    console.error(`\n  ✘ ${message}\n`);
  }
  process.exit(code);
};

// ─── Best-effort shell, matching release-status.mjs ───────────────────────────

const tryRun = (file, args, options = {}) => {
  try {
    return execFileSync(file, args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    }).trim();
  } catch {
    return null;
  }
};

const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** Newest-first by semver, so `[0]` is "current". Same comparator as release-status. */
const bySemverDesc = (a, b) => {
  const parse = v => v.replace(/^v/, "").split(/[.-]/).map(Number);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  return bMaj - aMaj || bMin - aMin || bPat - aPat;
};

// ─── The expected surface ─────────────────────────────────────────────────────

/**
 * Parse the vitest snapshot into `subpath -> exported names`.
 *
 * Deliberately a regex over the snapshot file rather than importing the contract
 * test: this must describe what the RELEASED source claimed, and running the test
 * would evaluate the working tree instead.
 *
 * ─── Read at the TAG, not from the working tree ──────────────────────────────
 *
 * The snapshot is read at `v<version>`, because the question is what the source
 * claimed **at the point of publish**. A working-tree read answers a different
 * question and answers it misleadingly: every export added since the release —
 * ordinary uncommitted or unreleased work — reads as absent from the artifact,
 * and the report says "the tag was almost certainly cut from a commit that
 * predates them". That accusation is then false, and a check that cries wolf
 * about the one failure it exists to detect is worse than no check, because this
 * script's whole value is being believed the day it is right.
 *
 * Falls back to the working tree when the tag is not reachable locally (a clone
 * fetched without tags), and says so. A degraded answer that announces itself is
 * fine; a confident wrong one is not.
 */
const parseSurface = raw => {
  const blocks = raw.matchAll(
    /exports\[`[^`]*exports of "([^"]+)"[^`]*`\] = `\n\[\n([\s\S]*?)\n\]\n`;/g,
  );
  const surface = new Map();
  for (const [, subpath, body] of blocks) {
    const names = [...body.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    if (names.length > 0) surface.set(subpath, names);
  }
  return surface;
};

/**
 * The snapshot as this checkout has it, or `null` if it cannot be read.
 *
 * Returns rather than throws, because the two callers want opposite things and
 * NEITHER wants an exception. The expectation path turns `null` into
 * EXIT_CANNOT_VERIFY — an unreadable snapshot means the check cannot run, which is
 * exit 2 and not the exit 1 that accuses the release. The lag report turns it into
 * an empty list, because an informational extra must never be the reason a good run
 * fails. Left throwing, it would escape the main `try` — which has only a `finally`
 * — and an uncaught throw exits 1, reintroducing exactly the conflation the exit
 * codes exist to prevent.
 */
const tryReadSurfaceFromWorkingTree = () => {
  try {
    return parseSurface(readFileSync(SNAPSHOT, "utf8"));
  } catch {
    return null;
  }
};

const readExpectedSurface = version => {
  // `maxBuffer` because the snapshot outgrows `execFileSync`'s 1MB default as
  // entry points are added, and the failure mode would be an opaque throw.
  const fromTag = tryRun("git", ["show", `v${version}:${SNAPSHOT_REL}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
  if (fromTag !== null) return { surface: parseSurface(fromTag), source: `tag v${version}` };
  const local = tryReadSurfaceFromWorkingTree();
  if (local === null) {
    fail(
      EXIT_CANNOT_VERIFY,
      `tag v${version} is unavailable and ${SNAPSHOT_REL} could not be read, so there is ` +
        "no expected surface to check against.",
    );
  }
  return { surface: local, source: "working tree" };
};

// ─── The published artifact ───────────────────────────────────────────────────

/**
 * The registry packument, via `gh auth token` + `fetch`.
 *
 * Not `npm view`: that needs a token in an `.npmrc`, and this package's `.npmrc`
 * lives in the CONSUMER monorepo, so `npm view` 401s from a fresh SDK clone —
 * which is exactly where a release is cut. `gh` already carries auth, the same
 * reasoning release-status.mjs uses for its registry lookup.
 */
const fetchPackument = async () => {
  const token = tryRun("gh", ["auth", "token"]);
  if (token === null) {
    fail(EXIT_CANNOT_VERIFY, "`gh auth token` failed — run `gh auth login`, then retry.");
  }
  // A `fetch` rejection (DNS, TLS, offline, proxy) is a BROKEN CHECK, not a broken
  // artifact. Letting it escape uncaught exits 1 — the code that means "symbols
  // are missing" — so an aeroplane wifi blip reads exactly like the 0.18.0 defect
  // this script exists to name. Every network and `tar` fault below is mapped to
  // EXIT_CANNOT_VERIFY for the same reason.
  const response = await fetch(`${REGISTRY}/@${ORG}%2f${PKG}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }).catch(error => {
    fail(EXIT_CANNOT_VERIFY, `could not reach ${REGISTRY}: ${error.message}`);
  });
  if (!response.ok) {
    fail(
      EXIT_CANNOT_VERIFY,
      `registry answered ${response.status} for @${ORG}/${PKG}. ` +
        "A 401 means the token lacks `read:packages` — `gh auth refresh -h github.com -s read:packages`.",
    );
  }
  return { packument: await response.json(), token };
};

/** Download and unpack the tarball. `tar` rather than a JS parser: it is everywhere this runs. */
const unpackTarball = async (tarballUrl, token) => {
  if (tryRun("tar", ["--version"]) === null) {
    fail(EXIT_CANNOT_VERIFY, "`tar` is not available, so the tarball cannot be unpacked.");
  }
  const response = await fetch(tarballUrl, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(error => {
    fail(EXIT_CANNOT_VERIFY, `tarball download failed: ${error.message}`);
  });
  if (!response.ok) {
    fail(EXIT_CANNOT_VERIFY, `tarball download failed with ${response.status}: ${tarballUrl}`);
  }
  const dir = mkdtempSync(join(tmpdir(), `${PKG}-verify-`));
  tempDir = dir;
  const tgz = join(dir, "package.tgz");
  writeFileSync(tgz, Buffer.from(await response.arrayBuffer()));
  try {
    execFileSync("tar", ["xzf", tgz, "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    // A truncated download or a `tar` that cannot read the archive says nothing
    // about the package's exports.
    fail(EXIT_CANNOT_VERIFY, `could not unpack the tarball: ${error.message}`);
  }
  return dir;
};

/** Every file under a directory, recursively. */
const walk = dir => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const declared = readJson(join(repo, "package.json"))?.version ?? null;
const { packument, token } = await fetchPackument();
const publishedVersions = Object.keys(packument.versions ?? {}).sort(bySemverDesc);

/**
 * Default to `package.json`, not to the newest published version. Right after a
 * release those agree, and when they do not, the interesting question is whether
 * the version THIS checkout claims to be actually shipped — which is the
 * discrepancy that hid the 0.18.0 failure for five days.
 */
const resolveVersion = () => {
  if (requestedVersion === "latest") return publishedVersions[0];
  if (requestedVersion !== null) return requestedVersion;
  return declared ?? publishedVersions[0];
};
const version = resolveVersion();

if (version === undefined || version === null) {
  fail(EXIT_CANNOT_VERIFY, "could not determine a version to check.");
}
const release = packument.versions?.[version];
if (release === undefined) {
  fail(
    EXIT_CANNOT_VERIFY,
    `${version} is not on the registry. Published: ${publishedVersions.join(", ")}`,
    {
      version,
      published: publishedVersions,
    },
  );
}

const tarballUrl = release.dist?.tarball;
if (typeof tarballUrl !== "string") {
  fail(EXIT_CANNOT_VERIFY, `${version} has no dist.tarball in its registry metadata.`, { version });
}

const dir = await unpackTarball(tarballUrl, token);
try {
  const distDir = join(dir, "package", "dist");
  let distFiles = [];
  try {
    distFiles = walk(distDir);
  } catch {
    fail(
      EXIT_MISSING,
      `published ${version} has no dist/ — the build did not run before publish.`,
      { version },
    );
  }
  if (distFiles.length === 0) {
    fail(EXIT_MISSING, `published ${version} ships an empty dist/.`, { version });
  }

  /**
   * One haystack. Per-entry-point resolution was considered and dropped: it means
   * modelling the `exports` map, barrel re-exports and the `.js` / `.d.ts` split,
   * every branch of which is a way to report a false MISSING. Absence from the
   * whole of `dist/` is unambiguous, and unambiguous is what a gate needs.
   *
   * `.map` files are excluded. A sourcemap carries `sourcesContent` — the whole
   * original module text — so searching it answers "was this name in the source"
   * when the only useful question is "did it reach the emitted output". That
   * weakens the single guarantee this script offers (absence proves missing): a
   * symbol dropped from the build but still present in its file's source would
   * read as shipped. Excluding them costs nothing, since anything genuinely
   * emitted appears in the `.js`/`.d.ts` the map was generated from.
   */
  const searchable = distFiles.filter(file => !file.endsWith(".map"));
  const haystack = searchable.map(file => readFileSync(file, "utf8")).join("\n");

  const { surface, source: surfaceSource } =
    symbolOverrides.length > 0
      ? { surface: new Map([["--symbol", symbolOverrides]]), source: "--symbol override" }
      : readExpectedSurface(version);

  /**
   * Exports the CURRENT checkout claims that the tag's snapshot did not.
   *
   * Reported, never failed on. Reading the expectation at the tag is what removes
   * the false positives, but it also makes the default check self-consistent by
   * construction: a tag cut from an early commit carries that commit's snapshot
   * too, so artifact and expectation agree and nothing looks wrong. That is
   * precisely the 0.18.0 shape — the tag was two hours and forty minutes early —
   * so the signal has to come from somewhere, and the only place it can come from
   * is the gap between the tag and what the release NOTES describe.
   *
   * A non-empty list is normal whenever `main` has moved on. It is a finding only
   * when the notes for THIS version promise something in it — which is the
   * judgement a human makes, and why this prints rather than exits.
   */
  const lagBehindCheckout = (() => {
    if (symbolOverrides.length > 0 || surfaceSource === "working tree") return [];
    const atTag = new Set([...surface.values()].flat());
    const localSurface = tryReadSurfaceFromWorkingTree();
    if (localSurface === null) return [];
    const local = new Set([...localSurface.values()].flat());
    return [...local].filter(name => !atTag.has(name)).sort();
  })();
  const missing = [];
  let checked = 0;
  for (const [subpath, names] of surface) {
    for (const name of names) {
      checked += 1;
      if (!haystack.includes(name)) missing.push({ subpath, name });
    }
  }

  const tarballVersion = readJson(join(dir, "package", "package.json"))?.version ?? null;
  const versionMismatch = tarballVersion !== null && tarballVersion !== version;

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: missing.length === 0 && !versionMismatch,
          version,
          tarballVersion,
          checked,
          // Which snapshot the expectation came from. A consumer of the JSON has to
          // be able to tell an authoritative run from a degraded working-tree one.
          expectedSurfaceFrom: surfaceSource,
          distFiles: distFiles.length,
          searchedFiles: searchable.length,
          missing,
        },
        null,
        2,
      ),
    );
  } else {
    const pad = (label, width = 20) => label.padEnd(width);
    say(`\n@${ORG}/${PKG} — published artifact\n`);
    say(
      `  ${pad("version checked")}${version}${version === declared ? "  (matches package.json)" : ""}`,
    );
    say(`  ${pad("tarball declares")}${tarballVersion ?? "unknown"}`);
    say(
      `  ${pad("dist files")}${distFiles.length}  (${searchable.length} searched, .map excluded)`,
    );
    say(`  ${pad("expected surface")}${surfaceSource}`);
    say(`  ${pad("symbols checked")}${checked}`);
    if (surfaceSource === "working tree") {
      say(
        `\n  ⚠ tag v${version} is not available locally, so the expectation came from the\n` +
          `    WORKING TREE. Any export added since the release will read as missing and be\n` +
          `    blamed on the tag. Run \`git fetch --tags\` and re-run before believing a ✘.`,
      );
    }
    if (missing.length === 0) {
      say(`\n  ✔ every expected symbol is present in the published dist/\n`);
      if (lagBehindCheckout.length > 0) {
        say(
          `  ℹ ${lagBehindCheckout.length} export(s) exist in this checkout but not at v${version}:`,
        );
        say(
          `      ${lagBehindCheckout.slice(0, 12).join(", ")}${lagBehindCheckout.length > 12 ? ", …" : ""}`,
        );
        say(
          `    Normal if main has moved on. A FINDING if the ${version} notes promise any of\n` +
            `    them — that is the 0.18.0 shape. Confirm with: --symbol <name> ${version}\n`,
        );
      }
    } else {
      say(
        `\n  ✘ ${missing.length} of ${checked} expected symbols are MISSING from the published dist/`,
      );
      if (surfaceSource !== "working tree") {
        say("    The tag was almost certainly cut from a commit that predates them.");
        say("    Compare: git log --oneline v" + version + "..main\n");
      }
      for (const { subpath, name } of missing.slice(0, 40)) {
        say(`      ${pad(subpath, 24)}${name}`);
      }
      if (missing.length > 40) say(`      … and ${missing.length - 40} more`);
      say("");
    }
    if (versionMismatch) {
      say(`  ⚠ the tarball declares ${tarballVersion} but was served as ${version}.\n`);
    }
  }

  /**
   * A `✘` computed from the WORKING TREE is not an accusation this script is
   * entitled to make. The expectation was the wrong baseline by construction — it
   * describes a checkout, not the release — so the honest code is "could not
   * verify" rather than "the artifact does not match its source". A `✔` in that
   * mode still means something (everything the checkout claims is present, which is
   * a stronger bar than the release had to clear), so only the failure is remapped.
   */
  const degraded = surfaceSource === "working tree";
  if (missing.length === 0 && !versionMismatch) process.exit(EXIT_OK);
  process.exit(degraded ? EXIT_CANNOT_VERIFY : EXIT_MISSING);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

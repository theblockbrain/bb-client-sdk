import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveSdkLinkLayout,
  describeCheckout,
  detectSemverSatisfies,
  isLinked,
  link,
  mismatchWarning,
  runSdkLinkCli,
  SdkLinkError,
  type SdkLinkLayout,
  staleDistWarning,
  unlink,
} from "./sdk-link.js";

const PACKAGE_NAME = "bb-client-sdk";
const BACKUP_NAME = ".bb-client-sdk.published";

describe("mismatchWarning", () => {
  // The evaluator is injected, so these assert the DECISION rather than semver
  // itself: that the range is handed to a range evaluator, and that an
  // undecidable input stays quiet.
  //
  // Versions carry a `-fixture` suffix so nobody reads them as tied to a real
  // release. They are labels in a message here, never operands of a real range
  // check. The one exception is `1.2.0` against `>=1.0.0 <1.2.0` below: that pair
  // is chosen so the version appears as a SUBSTRING of the range, which is the
  // trap a `range.includes(linked)` implementation falls into. Real examples of
  // that bug: it called `0.18.1` a mismatch against `^0.18.0`, and passed `1.2.0`
  // against `>=1.0.0 <1.2.0`.
  it("says nothing when the linked build satisfies the range", () => {
    expect(mismatchWarning("1.0.1-fixture", "^1.0.0-fixture", () => true)).toBeNull();
  });

  it("warns, naming both sides, when it does not", () => {
    const warning = mismatchWarning("9.9.9-fixture", "^1.0.0-fixture", () => false);
    expect(warning).toContain("9.9.9-fixture");
    expect(warning).toContain("^1.0.0-fixture");
    expect(warning).toContain("Installing dependencies");
  });

  it("asks the evaluator rather than comparing the strings", () => {
    const satisfies = vi.fn(() => true);
    mismatchWarning("1.2.0", ">=1.0.0 <1.2.0", satisfies);
    expect(satisfies).toHaveBeenCalledWith("1.2.0", ">=1.0.0 <1.2.0");
  });

  it("stays quiet when either side is unknown", () => {
    expect(mismatchWarning(null, "^1.0.0-fixture", () => false)).toBeNull();
    expect(mismatchWarning("9.9.9-fixture", null, () => false)).toBeNull();
  });

  it("stays quiet when there is no evaluator, rather than guessing", () => {
    expect(mismatchWarning("9.9.9-fixture", "^1.0.0-fixture", null)).toBeNull();
  });

  it("treats an unparseable range as undecidable, not as a mismatch", () => {
    expect(
      mismatchWarning("9.9.9-fixture", "not-a-range", () => {
        throw new Error("bad range");
      }),
    ).toBeNull();
  });
});

describe("detectSemverSatisfies", () => {
  afterEach(() => {
    delete (globalThis as { Bun?: unknown }).Bun;
  });

  // Vitest runs under Node, and the `bb-sdk-link` bin runs under Node for an npm
  // consumer. Neither has a range evaluator, and the tool has to be honest about
  // that rather than shipping one of its own.
  it("reports no evaluator when Bun is not the runtime", () => {
    expect(detectSemverSatisfies()).toBeNull();
  });

  it("reads Bun's evaluator structurally, off the global", () => {
    const satisfies = vi.fn(() => true);
    (globalThis as { Bun?: unknown }).Bun = { semver: { satisfies } };

    const detected = detectSemverSatisfies();
    expect(detected).not.toBeNull();
    expect(detected?.("1.0.0-fixture", "^1.0.0-fixture")).toBe(true);
    expect(satisfies).toHaveBeenCalledWith("1.0.0-fixture", "^1.0.0-fixture");
  });

  it("ignores a Bun global that has no semver evaluator", () => {
    (globalThis as { Bun?: unknown }).Bun = { semver: {} };
    expect(detectSemverSatisfies()).toBeNull();
  });
});

describe("link / unlink", () => {
  let root: string;
  let lines: string[];

  /** A fake store entry, so `readVersion` has a package.json to find. */
  function makeStoreEntry(version: string): string {
    const dir = join(root, ".store", `bb-client-sdk@${version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@theblockbrain/bb-client-sdk", version }),
    );
    return dir;
  }

  /** An SDK checkout that passes both up-front checks. */
  function makeSdkCheckout(name = "bb-client-sdk"): string {
    const dir = join(root, name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@theblockbrain/bb-client-sdk", version: "9.9.9-fixture" }),
    );
    return dir;
  }

  /** Install the published entry the way a package manager does: a symlink into the store. */
  function installPublished(scope: string, version: string): void {
    mkdirSync(scope, { recursive: true });
    symlinkSync(makeStoreEntry(version), join(scope, PACKAGE_NAME), "dir");
  }

  /**
   * Hand-build what an older version of this script left at the workspace root:
   * entry swapped for a link, published entry moved aside as the backup.
   *
   * `link` never produces this state (it refuses the shared root entry), so it
   * has to be built rather than reached, and both directions that READ a link
   * have to recognise it. Returns the store target the entry started at.
   */
  function installOldRootLink(layout: SdkLinkLayout): string {
    const rootLink = join(layout.rootScope, PACKAGE_NAME);
    const storeTarget = readlinkSync(rootLink);
    symlinkSync(storeTarget, join(layout.rootScope, BACKUP_NAME), "dir");
    // `unlinkSync`, not `rmSync`: this entry is a symlink POINTING AT a directory,
    // and a bare `rmSync` resolves the target before deciding what it is, which
    // Node 24.13.0 refuses with EISDIR. See the `removeEntry` describe below for
    // the gate that pins the engine's own side of this.
    unlinkSync(rootLink);
    symlinkSync(layout.sdkPath, rootLink, "dir");
    return storeTarget;
  }

  function layoutFor(sdkPath: string, overrides: Partial<SdkLinkLayout> = {}): SdkLinkLayout {
    return {
      sdkPath,
      packageScope: join(root, "packages", "consumer", "node_modules", "@theblockbrain"),
      rootScope: join(root, "node_modules", "@theblockbrain"),
      declaredRange: "^1.0.0-fixture",
      log: line => lines.push(line),
      // Node runs these tests, so Bun's evaluator is absent; inject one that
      // answers the same as `Bun.semver.satisfies("9.9.9-fixture", "^1.0.0-fixture")`.
      satisfies: () => false,
      ...overrides,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sdk-link-"));
    lines = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("replaces the package-local entry with a link to the checkout", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");

    link(layout);

    const linkPath = join(layout.packageScope, PACKAGE_NAME);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(resolve(layout.packageScope, readlinkSync(linkPath))).toBe(layout.sdkPath);
    expect(lines.join("\n")).toContain("✓ Linked");
  });

  it("preserves the displaced published entry, pointer intact", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");
    const storeTarget = readlinkSync(join(layout.packageScope, PACKAGE_NAME));

    link(layout);

    const backupPath = join(layout.packageScope, BACKUP_NAME);
    expect(lstatSync(backupPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(backupPath)).toBe(storeTarget);
  });

  it("reports the linked version against the declared range", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");

    link(layout);

    expect(lines.join("\n")).toContain(
      "version: 9.9.9-fixture   package.json declares: ^1.0.0-fixture",
    );
    expect(lines.join("\n")).toContain("does not satisfy");
  });

  // `undefined` and `null` are different answers: "work it out" and "there is
  // none". Collapsing them with `??` would hand a caller who asked for silence
  // the runtime's evaluator back, which is why `evaluatorFor` spells the check
  // out. Bun is stubbed so both branches are actually reachable under Node.
  it("suppresses the mismatch line for an explicitly null evaluator", () => {
    (globalThis as { Bun?: unknown }).Bun = { semver: { satisfies: () => false } };
    try {
      const layout = layoutFor(makeSdkCheckout(), { satisfies: null });
      installPublished(layout.packageScope, "1.0.0-fixture");

      link(layout);

      expect(lines.join("\n")).not.toContain("does not satisfy");
    } finally {
      delete (globalThis as { Bun?: unknown }).Bun;
    }
  });

  it("falls back to the runtime's evaluator when none was injected", () => {
    (globalThis as { Bun?: unknown }).Bun = { semver: { satisfies: () => false } };
    try {
      const layout = layoutFor(makeSdkCheckout(), { satisfies: undefined });
      installPublished(layout.packageScope, "1.0.0-fixture");

      link(layout);

      expect(lines.join("\n")).toContain("does not satisfy");
    } finally {
      delete (globalThis as { Bun?: unknown }).Bun;
    }
  });

  it("is idempotent — a second link recognises the first", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");

    link(layout);
    lines = [];
    link(layout);

    expect(lines.join("\n")).toContain("• Already linked");
  });

  it("keeps the original backup when relinking to a different checkout", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");
    const storeTarget = readlinkSync(join(layout.packageScope, PACKAGE_NAME));

    link(layout);
    link(layoutFor(makeSdkCheckout("bb-client-sdk-other")));

    // Overwriting it would discard the only restorable published entry, leaving
    // `unlink` with nothing to put back.
    expect(readlinkSync(join(layout.packageScope, BACKUP_NAME))).toBe(storeTarget);
  });

  it("restores the published entry and clears the marker", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");

    link(layout);
    lines = [];
    unlink(layout);

    expect(existsSync(join(layout.packageScope, BACKUP_NAME))).toBe(false);
    expect(lines.join("\n")).toContain("@1.0.0-fixture");
  });

  it("round-trips: unlink leaves the entry pointing where it started", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");
    const before = readlinkSync(join(layout.packageScope, PACKAGE_NAME));

    link(layout);
    unlink(layout);

    expect(readlinkSync(join(layout.packageScope, PACKAGE_NAME))).toBe(before);
  });

  it("does nothing when no link is in place", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");
    const before = readlinkSync(join(layout.packageScope, PACKAGE_NAME));

    unlink(layout);

    expect(readlinkSync(join(layout.packageScope, PACKAGE_NAME))).toBe(before);
    expect(lines.join("\n")).toContain("• Not linked");
  });

  it("reports whether a link of ours is in place, off the backup marker", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");
    expect(isLinked(layout)).toBe(false);

    link(layout);
    expect(isLinked(layout)).toBe(true);

    unlink(layout);
    expect(isLinked(layout)).toBe(false);
  });

  it("says so rather than claiming success when the backup no longer resolves", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");
    link(layout);
    // What an install that moved the pin (or pruned the store) leaves behind.
    rmSync(join(root, ".store"), { recursive: true, force: true });
    lines = [];

    unlink(layout);

    expect(lines.join("\n")).toContain("does not resolve");
    expect(lines.join("\n")).toContain("Install dependencies");
  });

  it("cleans up a root-scope link left by an older version of this script", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.rootScope, "0.9.0-fixture");
    const storeTarget = installOldRootLink(layout);

    unlink(layout);

    expect(readlinkSync(join(layout.rootScope, PACKAGE_NAME))).toBe(storeTarget);
    expect(existsSync(join(layout.rootScope, BACKUP_NAME))).toBe(false);
  });

  // The two directions have to agree about the same install. `unlink` walks both
  // scopes and acts on a root-scope link (the test above); reading only the
  // package scope made `isLinked` — and the `status` line built on it — call that
  // same state unlinked, telling a developer they were on the published SDK while
  // every import resolved into the local checkout.
  it("sees a root-scope link too, the one unlink is written to clean up", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.rootScope, "0.9.0-fixture");
    installOldRootLink(layout);
    // The package scope holds neither the link nor the marker, which is the
    // whole point: only the root scope can answer.
    expect(existsSync(join(layout.packageScope, BACKUP_NAME))).toBe(false);

    expect(isLinked(layout)).toBe(true);

    unlink(layout);
    expect(isLinked(layout)).toBe(false);
  });

  it("refuses to touch a hoisted root entry, which other workspaces share", () => {
    const layout = layoutFor(makeSdkCheckout());
    // No package-local entry: only the shared root one, as a hoisting install leaves it.
    installPublished(layout.rootScope, "0.9.0-fixture");
    const before = readlinkSync(join(layout.rootScope, PACKAGE_NAME));

    expect(() => link(layout)).toThrow(SdkLinkError);
    expect(() => link(layout)).toThrow(/workspace root/);
    expect(readlinkSync(join(layout.rootScope, PACKAGE_NAME))).toBe(before);
    expect(existsSync(join(layout.rootScope, BACKUP_NAME))).toBe(false);
  });

  it("refuses when the SDK is not installed at all", () => {
    expect(() => link(layoutFor(makeSdkCheckout()))).toThrow(/not installed/);
  });

  it("refuses when the checkout is missing", () => {
    const layout = layoutFor(join(root, "nope"));
    installPublished(layout.packageScope, "1.0.0-fixture");

    expect(() => link(layout)).toThrow(/No SDK checkout/);
  });

  it("refuses when the checkout has no dist, which would serve nothing", () => {
    const sdkPath = join(root, "unbuilt");
    mkdirSync(sdkPath, { recursive: true });
    const layout = layoutFor(sdkPath);
    installPublished(layout.packageScope, "1.0.0-fixture");

    expect(() => link(layout)).toThrow(/dist is missing/);
  });

  // The reason a surface links at all is to try an UNRELEASED branch, and every
  // branch off main reports the same version. Without the branch line, a
  // successful link looks identical whether you got the branch you meant or the
  // one left checked out last week.
  it("names the branch and commit it linked, not just the version", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");
    mkdirSync(join(layout.sdkPath, ".git", "refs", "heads", "feat", "PDEV-7369"), {
      recursive: true,
    });
    writeFileSync(
      join(layout.sdkPath, ".git", "HEAD"),
      "ref: refs/heads/feat/PDEV-7369/office-adopter-gaps\n",
    );
    writeFileSync(
      join(layout.sdkPath, ".git", "refs", "heads", "feat", "PDEV-7369", "office-adopter-gaps"),
      "abc123def456\n",
    );

    link(layout);

    expect(lines.join("\n")).toContain("branch: feat/PDEV-7369/office-adopter-gaps @ abc123def");
  });

  it("warns rather than silently serving a dist older than src", () => {
    const layout = layoutFor(makeSdkCheckout());
    installPublished(layout.packageScope, "1.0.0-fixture");

    // A source edit after the last build. The link succeeds, the version matches,
    // and the surface quietly runs the PREVIOUS build: the one failure mode an
    // existence check cannot see.
    const built = join(layout.sdkPath, "dist", "index.js");
    writeFileSync(built, "export const stale = true;");
    mkdirSync(join(layout.sdkPath, "src"), { recursive: true });
    const source = join(layout.sdkPath, "src", "index.ts");
    writeFileSync(source, "export const changed = true;");

    // Stamped rather than relying on write order: both writes land in the same
    // millisecond on a fast disk, and `dist >= src` would then read as fresh.
    const old = new Date("2020-01-01T00:00:00Z");
    const recent = new Date("2020-01-02T00:00:00Z");
    utimesSync(built, old, old);
    utimesSync(source, recent, recent);

    link(layout);

    expect(lines.join("\n")).toContain("STALE build");
  });
});

/**
 * The Node 24.13.0 `EISDIR` regression, simulated.
 *
 * `rmSync(path, { recursive: true })` on a symlink pointing AT a directory
 * resolved the target before deciding what it was, and refused. 24.13.0 is the
 * version moon pins for CI and the bug is fixed in 24.13.1, so an engine that
 * calls a bare `rmSync` here passes on a developer's newer Node and fails only
 * in CI. `ms-outlook-addin`'s copy still has the bare call.
 *
 * A behavioural test on a healthy Node cannot see the difference (verified: both
 * implementations remove the link and leave the target intact), so the buggy
 * `rmSync` is injected instead. Revert `removeEntry` to a bare `rmSync` and
 * both cases below fail — which is the only way to know this gate exists.
 */
describe("removeEntry, on a Node that refuses rm on a symlink", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sdk-link-eisdir-"));
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
  });

  /** Load the engine against an `fs` whose `rmSync` behaves like 24.13.0's. */
  async function loadEngineOnBuggyNode(): Promise<typeof import("./sdk-link.js")> {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const rmSync: typeof actual.rmSync = (path, options) => {
        if (
          typeof path === "string" &&
          actual.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()
        ) {
          const err: NodeJS.ErrnoException = new Error(
            `EISDIR: illegal operation on a directory, rm '${path}'`,
          );
          err.code = "EISDIR";
          throw err;
        }
        return actual.rmSync(path, options);
      };
      return { ...actual, rmSync, default: { ...actual, rmSync } };
    });
    return import("./sdk-link.js");
  }

  function makeCheckout(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@theblockbrain/bb-client-sdk", version: "9.9.9-fixture" }),
    );
    return dir;
  }

  function layoutFor(sdkPath: string): SdkLinkLayout {
    return {
      sdkPath,
      packageScope: join(root, "packages", "consumer", "node_modules", "@theblockbrain"),
      rootScope: join(root, "node_modules", "@theblockbrain"),
      declaredRange: "^1.0.0-fixture",
      log: () => {},
      satisfies: null,
    };
  }

  function installPublished(scope: string): void {
    const store = join(root, ".store", "bb-client-sdk@1.0.0-fixture");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, "package.json"),
      JSON.stringify({ name: "@theblockbrain/bb-client-sdk", version: "1.0.0-fixture" }),
    );
    mkdirSync(scope, { recursive: true });
    symlinkSync(store, join(scope, PACKAGE_NAME), "dir");
  }

  it("relinks to a different checkout without tripping over the previous link", async () => {
    const engine = await loadEngineOnBuggyNode();
    const first = layoutFor(makeCheckout("sdk-a"));
    installPublished(first.packageScope);

    engine.link(first);
    const second = layoutFor(makeCheckout("sdk-b"));
    engine.link(second);

    const linkPath = join(first.packageScope, PACKAGE_NAME);
    expect(resolve(first.packageScope, readlinkSync(linkPath))).toBe(second.sdkPath);
  });

  it("restores the published entry over an existing link", async () => {
    const engine = await loadEngineOnBuggyNode();
    const layout = layoutFor(makeCheckout("sdk-a"));
    installPublished(layout.packageScope);
    const before = readlinkSync(join(layout.packageScope, PACKAGE_NAME));

    engine.link(layout);
    engine.unlink(layout);

    expect(readlinkSync(join(layout.packageScope, PACKAGE_NAME))).toBe(before);
  });
});

describe("describeCheckout", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sdk-head-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a branch name with slashes in it", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feat/a/b\n");

    // The sha is missing here, which must not lose the branch: packed refs are
    // normal in a long-lived clone.
    expect(describeCheckout(dir)).toEqual({ branch: "feat/a/b", commit: null });
  });

  it("reports a bare sha for a detached HEAD", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "abcdef1234567890\n");

    expect(describeCheckout(dir)).toEqual({ branch: null, commit: "abcdef123" });
  });

  it("returns nulls rather than throwing when there is no .git", () => {
    // Not knowing the branch is not a reason to refuse a link.
    expect(describeCheckout(dir)).toEqual({ branch: null, commit: null });
  });
});

describe("staleDistWarning", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sdk-stale-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stays quiet when dist is newer than src", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "a");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "a.js"), "a");

    expect(staleDistWarning(dir)).toBeNull();
  });

  it("stays quiet when either directory is missing, rather than guessing", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "a");

    expect(staleDistWarning(dir)).toBeNull();
  });
});

describe("deriveSdkLinkLayout", () => {
  let root: string;
  let consumer: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sdk-derive-"));
    consumer = join(root, "packages", "consumer");
    // The root `node_modules` is what marks the workspace root. Without it the
    // walk keeps climbing into the real filesystem, which is the failure this
    // fixture shape exists to keep out of the assertions below.
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "consumer",
        dependencies: { "@theblockbrain/bb-client-sdk": "^1.0.0-fixture" },
      }),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("scopes the writable directory to the consuming package, not the workspace", () => {
    const layout = deriveSdkLinkLayout({ cwd: consumer });

    expect(layout.packageScope).toBe(join(consumer, "node_modules", "@theblockbrain"));
    expect(layout.rootScope).toBe(join(root, "node_modules", "@theblockbrain"));
  });

  it("defaults the checkout to a sibling of the workspace root", () => {
    expect(deriveSdkLinkLayout({ cwd: consumer }).sdkPath).toBe(
      resolve(root, "..", "bb-client-sdk"),
    );
  });

  it("honours an explicit checkout path", () => {
    const explicit = join(root, "elsewhere", "bb-client-sdk");
    expect(deriveSdkLinkLayout({ cwd: consumer, sdkPath: explicit }).sdkPath).toBe(explicit);
  });

  it("reads the declared range so the mismatch warning has something to compare", () => {
    expect(deriveSdkLinkLayout({ cwd: consumer }).declaredRange).toBe("^1.0.0-fixture");
  });

  it("also finds the range in devDependencies", () => {
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "consumer",
        devDependencies: { "@theblockbrain/bb-client-sdk": "^2.0.0-fixture" },
      }),
    );
    expect(deriveSdkLinkLayout({ cwd: consumer }).declaredRange).toBe("^2.0.0-fixture");
  });

  it("reports an unknown range rather than throwing when package.json is unreadable", () => {
    rmSync(join(consumer, "package.json"));
    expect(deriveSdkLinkLayout({ cwd: consumer }).declaredRange).toBeNull();
  });
});

describe("runSdkLinkCli", () => {
  let root: string;
  let consumer: string;
  let sdkPath: string;
  let lines: string[];
  let errors: string[];

  function run(...argv: string[]): number {
    return runSdkLinkCli(argv, {
      cwd: consumer,
      sdkPath,
      log: line => lines.push(line),
      error: line => errors.push(line),
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sdk-cli-"));
    lines = [];
    errors = [];

    mkdirSync(join(root, "node_modules"), { recursive: true });
    consumer = join(root, "packages", "consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "consumer",
        dependencies: { "@theblockbrain/bb-client-sdk": "^1.0.0-fixture" },
      }),
    );

    sdkPath = join(root, "checkout");
    mkdirSync(join(sdkPath, "dist"), { recursive: true });
    writeFileSync(
      join(sdkPath, "package.json"),
      JSON.stringify({ name: "@theblockbrain/bb-client-sdk", version: "9.9.9-fixture" }),
    );

    const store = join(root, ".store", "bb-client-sdk@1.0.0-fixture");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, "package.json"),
      JSON.stringify({ name: "@theblockbrain/bb-client-sdk", version: "1.0.0-fixture" }),
    );
    const scope = join(consumer, "node_modules", "@theblockbrain");
    mkdirSync(scope, { recursive: true });
    symlinkSync(store, join(scope, PACKAGE_NAME), "dir");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("links, reports status, and unlinks, each with exit code 0", () => {
    expect(run("link")).toBe(0);
    expect(lines.join("\n")).toContain("✓ Linked");

    lines = [];
    expect(run("status")).toBe(0);
    expect(lines.join("\n")).toContain("• Linked →");
    // Describing the checkout is the point of `status` when there IS one, so the
    // suppression below must not have turned into "never report".
    expect(lines.join("\n")).toContain("version: 9.9.9-fixture");

    lines = [];
    expect(run("unlink")).toBe(0);
    expect(lines.join("\n")).toContain("✓ Restored");
  });

  it("reports the unlinked state without touching anything", () => {
    expect(run("status")).toBe(0);
    expect(lines.join("\n")).toContain("• Not linked");
    expect(existsSync(join(consumer, "node_modules", "@theblockbrain", BACKUP_NAME))).toBe(false);
  });

  // `report` describes what is LINKED. Run against a checkout that is not linked
  // it reads as if it were: a branch name and a stale-build warning say "you are
  // running your checkout", and `version: unknown` — the only line that hinted
  // otherwise — reads as a lookup failure rather than as the absence of a link.
  it("does not describe the checkout when nothing is linked", () => {
    mkdirSync(join(sdkPath, ".git"), { recursive: true });
    writeFileSync(join(sdkPath, ".git", "HEAD"), "ref: refs/heads/feat/PDEV-7369/fixture\n");
    // A checkout whose dist is older than its src, so the stale warning would
    // fire if it were consulted at all.
    const built = join(sdkPath, "dist", "index.js");
    writeFileSync(built, "export const stale = true;");
    mkdirSync(join(sdkPath, "src"), { recursive: true });
    const source = join(sdkPath, "src", "index.ts");
    writeFileSync(source, "export const changed = true;");
    const old = new Date("2020-01-01T00:00:00Z");
    const recent = new Date("2020-01-02T00:00:00Z");
    utimesSync(built, old, old);
    utimesSync(source, recent, recent);

    expect(run("status")).toBe(0);

    const output = lines.join("\n");
    expect(output).toContain("• Not linked");
    expect(output).not.toContain("branch:");
    expect(output).not.toContain("STALE build");
    expect(output).not.toContain("version: unknown");
    // The declared range still belongs here: it is what the consumer resolves.
    expect(output).toContain("^1.0.0-fixture");
  });

  // Exits non-zero rather than throwing: a refusal is the tool working, and a
  // stack trace in a terminal buries the sentence that says what to do.
  it("turns a refusal into an exit code and a message, not a stack trace", () => {
    rmSync(sdkPath, { recursive: true, force: true });

    expect(run("link")).toBe(1);
    expect(errors.join("\n")).toContain("No SDK checkout");
    expect(errors.join("\n")).toMatch(/^✗ /);
  });

  it("refuses an unknown command with the usage line", () => {
    expect(run("relink")).toBe(1);
    expect(errors.join("\n")).toContain("bb-sdk-link <link|unlink|status>");
  });

  it("refuses no command at all", () => {
    expect(run()).toBe(1);
    expect(errors.join("\n")).toContain("bb-sdk-link <link|unlink|status>");
  });
});

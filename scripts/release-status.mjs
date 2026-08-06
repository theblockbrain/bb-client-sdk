#!/usr/bin/env node
/**
 * Release status — answer "where is this package, actually?" by querying, not by
 * reading prose (PDEV-7001).
 *
 * Four numbers decide every release conversation: what `package.json` declares,
 * what the newest git tag says, what the registry actually serves, and what each
 * consumer pins. They are answered here rather than restated in a dozen markdown
 * files, because a documented version is wrong the moment someone publishes and
 * nothing tells the next reader it went stale.
 *
 * The failure that motivated it: `v0.18.0` was tagged, its `publish.yml` run died
 * in *Set up job* on a GitHub Actions outage, and nothing anywhere reflected that
 * the tag existed but the version did not. Every doc still said "the last
 * published tag is v0.17.0" — accidentally true, and true for the wrong reason.
 * A tag that never became a release is invisible to `git`, invisible to the
 * changelog, and looks exactly like a successful one from the terminal.
 *
 * NOT a gate. It needs network and `gh` auth, so wiring it into `ci.yml` or
 * `publish.yml` would make them fail for reasons unrelated to the code. It exits
 * 0 even when it finds a divergence — reporting one is the job, and the human or
 * agent reading it decides whether it is expected.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "theblockbrain";
const PKG = "bb-client-sdk";

/**
 * Consumers to report a pin for. Each is a sibling checkout, so an absent one is
 * normal (nobody clones all of them) and is reported as unknown rather than
 * treated as an error.
 */
const CONSUMERS = [
  { name: "ms-outlook-addin", path: "../ms-outlook-addin" },
  { name: "ms-word-addin", path: "../ms-word-addin" },
  { name: "ms-powerpoint-addin", path: "../ms-powerpoint-addin" },
  { name: "Webcomponent-Webpart", path: "../Webcomponent-Webpart" },
  { name: "blocky-mobile", path: "../blocky-mobile" },
];

/** Every lookup here is best-effort: an unavailable answer is reported, never thrown. */
const tryRun = (file, args) => {
  try {
    return execFileSync(file, args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
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

/** Newest-first by semver, so `[0]` is "current" for tags and registry versions alike. */
const bySemverDesc = (a, b) => {
  const parse = v => v.replace(/^v/, "").split(/[.-]/).map(Number);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  return bMaj - aMaj || bMin - aMin || bPat - aPat;
};

const declared = readJson(join(repo, "package.json"))?.version ?? "unknown";

const tags = (tryRun("git", ["tag", "--list", "v*"]) ?? "")
  .split("\n")
  .filter(Boolean)
  .sort(bySemverDesc);
const newestTag = tags[0] ?? null;

/**
 * GitHub Packages, not npmjs — `npm view` against the default registry 404s, and
 * against `npm.pkg.github.com` needs a token in `.npmrc`. The `gh` CLI already
 * carries auth, so it is the one lookup that works from a fresh clone.
 */
const publishedRaw = tryRun("gh", [
  "api",
  `/orgs/${ORG}/packages/npm/${PKG}/versions`,
  "--jq",
  ".[].name",
]);
const published = publishedRaw ? publishedRaw.split("\n").filter(Boolean).sort(bySemverDesc) : null;
const newestPublished = published?.[0] ?? null;

const pins = CONSUMERS.map(consumer => {
  const manifest = readJson(join(repo, consumer.path, "package.json"));
  if (manifest === null) return { ...consumer, pin: null };
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  return { ...consumer, pin: deps[`@${ORG}/${PKG}`] ?? "not installed" };
});

const pad = (label, width = 20) => label.padEnd(width);
console.log(`\n@${ORG}/${PKG}\n`);
console.log(`  ${pad("package.json")}${declared}`);
console.log(`  ${pad("newest git tag")}${newestTag ?? "none"}`);
console.log(`  ${pad("newest published")}${newestPublished ?? "unknown (gh auth required)"}`);

console.log("\n  consumer pins");
for (const { name, pin } of pins) {
  console.log(`    ${pad(name, 24)}${pin ?? "not checked out"}`);
}

/**
 * Divergences worth a human's attention. Each is a state the repo can genuinely
 * be in — none of them is an error on its own, which is why this reports rather
 * than exits non-zero.
 */
const notes = [];

if (newestTag !== null && newestPublished !== null) {
  const tagVersion = newestTag.replace(/^v/, "");
  if (bySemverDesc(tagVersion, newestPublished) < 0) {
    notes.push(
      `${newestTag} is tagged but ${tagVersion} is NOT on the registry — the publish never ran, ` +
        `failed, or is still in flight. Check: gh run list --workflow publish.yml`,
    );
  }
}

if (newestPublished !== null && bySemverDesc(declared, newestPublished) > 0) {
  notes.push(
    `package.json (${declared}) is behind the newest published version (${newestPublished}) — ` +
      `main is probably stale; pull before cutting.`,
  );
}

if (newestTag !== null && newestTag.replace(/^v/, "") !== declared) {
  notes.push(
    `package.json (${declared}) and the newest tag (${newestTag}) disagree. publish.yml's version ` +
      `guard rejects a tag that does not match, so the tag must move or the version must bump.`,
  );
}

/** SLO E3: no surface more than one minor era behind the newest published version. */
if (newestPublished !== null) {
  const [, publishedMinor] = newestPublished.split(".").map(Number);
  for (const { name, pin } of pins) {
    if (pin === null || pin === "not installed") continue;
    const [, pinnedMinor] = pin
      .replace(/^[^\d]*/, "")
      .split(".")
      .map(Number);
    if (Number.isFinite(pinnedMinor) && publishedMinor - pinnedMinor > 1) {
      notes.push(
        `${name} pins ${pin}, ${publishedMinor - pinnedMinor} minor eras behind ${newestPublished} (SLO E3).`,
      );
    }
  }
}

if (notes.length > 0) {
  console.log("\n  ⚠ divergence");
  for (const note of notes) console.log(`    - ${note}`);
}
console.log("");

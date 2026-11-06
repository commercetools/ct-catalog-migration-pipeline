// Writes a patch changeset when the runtime dependencies of the lockfile
// changed since the last release, so a Dependabot update of something a
// reader installs ends up in the next Version Packages PR.
//
// Run by release.yml before changesets/action. The file it writes is not
// committed: the action reads changesets from disk, `changeset version`
// consumes the file into CHANGELOG.md, and nothing of it is left behind.
//
// Dev dependencies are skipped on purpose. The archive a reader fetches is
// installed with `npm ci`, so only what the lockfile marks as non-dev changes
// what they run.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CHANGESET_FILE = ".changeset/dependency-updates.md";
const MAX_LISTED = 25;

/** name -> sorted versions, for every package the lockfile does not mark dev. */
export function runtimePackages(lock) {
  const byName = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "" || entry.dev === true || entry.link === true) continue;
    if (typeof entry.version !== "string") continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(entry.version);
  }
  return new Map([...byName].map(([name, versions]) => [name, [...versions].sort()]));
}

/** Packages whose set of installed versions differs, sorted by name. */
export function diffRuntime(before, after) {
  const changes = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(name)?.join(", ") ?? null;
    const to = after.get(name)?.join(", ") ?? null;
    if (from !== to) changes.push({ name, from, to });
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}

function describeChange({ name, from, to }) {
  if (from === null) return `- ${name}: added ${to}`;
  if (to === null) return `- ${name}: removed ${from}`;
  return `- ${name}: ${from} -> ${to}`;
}

export function buildChangeset(packageName, baselineTag, changes) {
  const listed = changes.slice(0, MAX_LISTED).map(describeChange);
  if (changes.length > MAX_LISTED) {
    listed.push(`- and ${changes.length - MAX_LISTED} more`);
  }
  return [
    "---",
    `"${packageName}": patch`,
    "---",
    "",
    `Runtime dependencies changed since ${baselineTag}:`,
    "",
    ...listed,
    "",
  ].join("\n");
}

/**
 * Decide whether to write a changeset. Pure: the caller supplies what git
 * and the file system say.
 *
 * @returns {{ write: false, reason: string } | { write: true, content: string }}
 */
export function decide({ packageName, version, tags, lockAtTag, lockNow }) {
  const baselineTag = `v${version}`;
  // package.json is at a version nobody has tagged yet: either the very first
  // release, or the Version Packages PR just merged and the publish step has
  // not run. A changeset written now would make the action open another PR
  // instead of publishing.
  if (!tags.includes(baselineTag)) {
    return {
      write: false,
      reason: `${baselineTag} is not tagged yet; its release is pending, so nothing is added`,
    };
  }
  if (lockAtTag === null) {
    return { write: false, reason: `no package-lock.json at ${baselineTag}` };
  }
  const changes = diffRuntime(runtimePackages(lockAtTag), runtimePackages(lockNow));
  if (changes.length === 0) {
    return { write: false, reason: `no runtime dependency changed since ${baselineTag}` };
  }
  return { write: true, content: buildChangeset(packageName, baselineTag, changes) };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function lockfileAt(tag) {
  try {
    return JSON.parse(git("show", `${tag}:package-lock.json`));
  } catch {
    return null;
  }
}

function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  const result = decide({
    packageName: pkg.name,
    version: pkg.version,
    tags,
    lockAtTag: tags.includes(`v${pkg.version}`) ? lockfileAt(`v${pkg.version}`) : null,
    lockNow: JSON.parse(readFileSync("package-lock.json", "utf8")),
  });
  if (!result.write) {
    console.log(`No dependency changeset: ${result.reason}.`);
    return;
  }
  writeFileSync(CHANGESET_FILE, result.content);
  console.log(`Wrote ${CHANGESET_FILE}:\n\n${result.content}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

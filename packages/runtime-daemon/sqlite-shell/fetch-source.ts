// Puts `shell.c` from sqlite.org's amalgamation at `build/source/shell.c` for `binding.gyp` to
// compile. It runs as the daemon's `postinstall`, before `node-gyp` builds the shell. The release is
// the one the binding vendors, so the shell and the binding run the same SQLite; when the binding
// moves to another release, this refuses until the pin below moves with it. The archive is checked
// against the SHA3-256 sqlite.org publishes on its download page and kept, so a later install
// fetches nothing.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";

import { isMissingFileError } from "../src/missing-file-error.ts";

// The release whose `shell.c` is compiled, and its archive's hash from sqlite.org/download.html.
const PINNED_RELEASE = {
  version: "3.53.4",
  year: 2026,
  archiveSha3: "628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e",
} as const;

const sourceFolder = fileURLToPath(new URL("build/source/", import.meta.url));

function readHeaderValue(header: string, name: string): string {
  const match = new RegExp(`^#define ${name}\\s+"?([^"\\s]+)"?`, "m").exec(header);
  if (match?.[1] === undefined) {
    throw new Error(`sqlite3.h names no ${name}`);
  }
  return match[1];
}

function hashArchive(archive: Uint8Array): string {
  return createHash("sha3-256").update(archive).digest("hex");
}

async function readKeptArchive(archivePath: string): Promise<Uint8Array | undefined> {
  try {
    const archive = await readFile(archivePath);
    return hashArchive(archive) === PINNED_RELEASE.archiveSha3 ? archive : undefined;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function downloadArchive(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetching ${url} answered ${String(response.status)}`);
  }
  const archive = new Uint8Array(await response.arrayBuffer());
  const hash = hashArchive(archive);
  if (hash !== PINNED_RELEASE.archiveSha3) {
    throw new Error(`${url} has SHA3-256 ${hash}, not the pinned ${PINNED_RELEASE.archiveSha3}`);
  }
  return archive;
}

const bindingHeaderPath = path.join(
  path.dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json")),
  "deps",
  "sqlite3",
  "sqlite3.h",
);
const bindingHeader = await readFile(bindingHeaderPath, "utf8");
const bindingVersion = readHeaderValue(bindingHeader, "SQLITE_VERSION");
if (bindingVersion !== PINNED_RELEASE.version) {
  throw new Error(
    `better-sqlite3 vendors SQLite ${bindingVersion}, but the shell is pinned to ` +
      `${PINNED_RELEASE.version}: move the pin in sqlite-shell/fetch-source.ts to that release`,
  );
}
// sqlite.org names a release's files by its version as XYYZZ00: 3.53.4 is 3530400.
const [major, minor, patch] = PINNED_RELEASE.version.split(".");
const archiveName = `sqlite-amalgamation-${String(major)}${String(minor).padStart(2, "0")}${String(patch).padStart(2, "0")}00`;
const archivePath = path.join(sourceFolder, `${archiveName}.zip`);
await mkdir(sourceFolder, { recursive: true });
let archive = await readKeptArchive(archivePath);
if (archive === undefined) {
  archive = await downloadArchive(
    `https://sqlite.org/${String(PINNED_RELEASE.year)}/${archiveName}.zip`,
  );
  await writeFile(archivePath, archive);
}
const shellEntryName = `${archiveName}/shell.c`;
const shellSource = unzipSync(archive, { filter: (entry) => entry.name === shellEntryName })[
  shellEntryName
];
if (shellSource === undefined) {
  throw new Error(`${archiveName}.zip holds no ${shellEntryName}`);
}
// An unchanged `shell.c` keeps its time, so the build that follows compiles nothing again.
const shellPath = path.join(sourceFolder, "shell.c");
const keptShellSource = await readFile(shellPath).catch((error: unknown) => {
  if (isMissingFileError(error)) {
    return undefined;
  }
  throw error;
});
if (keptShellSource === undefined || !keptShellSource.equals(shellSource)) {
  await writeFile(shellPath, shellSource);
}

// Builds the daemon's `sqlite3` shell at install: it runs as the daemon's `postinstall`. It puts
// `shell.c` from sqlite.org's amalgamation at `build/source/shell.c`, then has `node-gyp` compile
// `binding.gyp` into `build/Release/`. The release is the one the binding vendors, so the shell and
// the binding run the same SQLite; when the binding moves to another release, this refuses until
// the pin below moves with it. The archive is checked against the SHA3-256 sqlite.org publishes on
// its download page and kept. A shell built from the same inputs on the same platform is kept too,
// so a later install fetches and compiles nothing.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";

import { isMissingFileError } from "../src/file/missing-error.ts";

// The release whose `shell.c` is compiled, and its archive's hash from sqlite.org/download.html.
const PINNED_RELEASE = {
  version: "3.53.4",
  year: 2026,
  archiveSha3: "628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e",
} as const;

// A stalled download fails the install rather than holding it.
const DOWNLOAD_TIMEOUT_MS = 120_000;

const shellFolder = fileURLToPath(new URL(".", import.meta.url));
const sourceFolder = path.join(shellFolder, "build", "source");
const shellProgram = path.join(
  shellFolder,
  "build",
  "Release",
  process.platform === "win32" ? "sqlite3.exe" : "sqlite3",
);
// Holds the hash of the inputs the shell beside it was built from.
const builtInputsPath = `${shellProgram}.inputs`;

const daemonRequire = createRequire(import.meta.url);
const bindingSourceFolder = path.join(
  path.dirname(daemonRequire.resolve("better-sqlite3/package.json")),
  "deps",
);

async function readIfPresent(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function hashArchive(archive: Uint8Array): string {
  return createHash("sha3-256").update(archive).digest("hex");
}

async function downloadArchive(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
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

// Writes `shell.c` from the kept archive or a fresh download, unless it is there unchanged.
async function placeShellSource(): Promise<void> {
  const [major, minor, patch] = PINNED_RELEASE.version.split(".");
  // sqlite.org names a release's files by its version as XYYZZ00: 3.53.4 is 3530400.
  const archiveName = `sqlite-amalgamation-${String(major)}${String(minor).padStart(2, "0")}${String(patch).padStart(2, "0")}00`;
  const archivePath = path.join(sourceFolder, `${archiveName}.zip`);
  await mkdir(sourceFolder, { recursive: true });
  let archive: Uint8Array | undefined = await readIfPresent(archivePath);
  if (archive === undefined || hashArchive(archive) !== PINNED_RELEASE.archiveSha3) {
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
  const shellSourcePath = path.join(sourceFolder, "shell.c");
  const keptShellSource = await readIfPresent(shellSourcePath);
  if (keptShellSource === undefined || !keptShellSource.equals(shellSource)) {
    await writeFile(shellSourcePath, shellSource);
  }
}

const bindingHeader = await readFile(
  path.join(bindingSourceFolder, "sqlite3", "sqlite3.h"),
  "utf8",
);
const bindingVersion = /^#define SQLITE_VERSION\s+"([^"]+)"/m.exec(bindingHeader)?.[1];
if (bindingVersion !== PINNED_RELEASE.version) {
  throw new Error(
    `better-sqlite3 vendors SQLite ${String(bindingVersion)}, but the shell is pinned to ` +
      `${PINNED_RELEASE.version}: move the pin in sqlite-shell/compile.ts to that release`,
  );
}

const inputsHash = createHash("sha256");
for (const input of [
  path.join(shellFolder, "binding.gyp"),
  path.join(bindingSourceFolder, "defines.gypi"),
  path.join(bindingSourceFolder, "sqlite3", "sqlite3.c"),
]) {
  inputsHash.update(await readFile(input));
}
inputsHash.update(`${PINNED_RELEASE.archiveSha3} ${process.platform} ${process.arch}`);
const builtInputs = inputsHash.digest("hex");

const keptInputs = await readIfPresent(builtInputsPath);
if (!existsSync(shellProgram) || keptInputs?.toString("utf8") !== builtInputs) {
  await placeShellSource();
  const build = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("node-gyp/bin/node-gyp.js")),
      "configure",
      "build",
      "--directory",
      shellFolder,
    ],
    { stdio: "inherit" },
  );
  if (build.error !== undefined) {
    throw build.error;
  }
  if (build.status !== 0) {
    throw new Error(
      `node-gyp could not build the SQLite shell (${build.signal ?? `exit ${String(build.status)}`})`,
    );
  }
  await writeFile(builtInputsPath, builtInputs);
}

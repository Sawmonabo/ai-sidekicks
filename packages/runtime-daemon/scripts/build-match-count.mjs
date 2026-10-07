// Compiles the search's match count, `src/session/search/match-count.c`, into the shared library
// the daemon loads, with the platform's own C compiler: clang on macOS, cc on Linux, and cl on
// Windows from a Visual Studio developer environment. It compiles against the SQLite headers
// better-sqlite3 builds its own SQLite from, so the library fits the SQLite that loads it. A
// missing compiler fails the build, naming what to install.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { MATCH_COUNT_LIBRARY_PATH } from "../src/session/search/match-count.ts";

const SOURCE_PATH = fileURLToPath(new URL("../src/session/search/match-count.c", import.meta.url));
const SQLITE_HEADERS_PATH = path.join(
  path.dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json")),
  "deps",
  "sqlite3",
);
// The oldest macOS the app runs on; a library built for a newer one would not load there.
const MACOS_FLOOR = "13.0";

/** The compiler, its arguments to write the library at `libraryPath`, and how to install it. */
function compilerCommand(libraryPath, scratchPath) {
  switch (process.platform) {
    case "darwin":
      return {
        compiler: "clang",
        args: [
          "-O2",
          "-fPIC",
          "-dynamiclib",
          `-mmacosx-version-min=${MACOS_FLOOR}`,
          "-I",
          SQLITE_HEADERS_PATH,
          "-o",
          libraryPath,
          SOURCE_PATH,
        ],
        install: "Install the Xcode Command Line Tools: xcode-select --install",
      };
    case "win32":
      return {
        compiler: "cl",
        // The object file, import library and export file stay in the scratch folder.
        args: [
          "/nologo",
          "/O2",
          "/LD",
          `/I${SQLITE_HEADERS_PATH}`,
          `/Fo${path.join(scratchPath, "match-count.obj")}`,
          `/Fe${libraryPath}`,
          SOURCE_PATH,
          "/link",
          `/IMPLIB:${path.join(scratchPath, "match-count.lib")}`,
        ],
        install:
          "Install Visual Studio Build Tools with the C++ workload, and build from a Developer " +
          "PowerShell or Developer Command Prompt, which puts cl on the path",
      };
    default:
      return {
        compiler: "cc",
        args: [
          "-O2",
          "-fPIC",
          "-shared",
          "-I",
          SQLITE_HEADERS_PATH,
          "-o",
          libraryPath,
          SOURCE_PATH,
        ],
        install:
          "Install a C compiler, such as gcc from the distribution's build-essential package",
      };
  }
}

const libraryFolder = path.dirname(MATCH_COUNT_LIBRARY_PATH);
mkdirSync(libraryFolder, { recursive: true });
// Built in a scratch folder beside the library, then renamed over it, so a failed build or one
// running alongside another never leaves a partial library where the daemon loads it.
const scratchPath = mkdtempSync(path.join(libraryFolder, ".match-count-"));
try {
  const builtPath = path.join(scratchPath, path.basename(MATCH_COUNT_LIBRARY_PATH));
  const { compiler, args, install } = compilerCommand(builtPath, scratchPath);
  const result = spawnSync(compiler, args, { stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error.code === "ENOENT"
      ? new Error(
          `No C compiler to build the search's match count: ${compiler} is not on the path. ` +
            `${install}.`,
        )
      : result.error;
  }
  if (result.status !== 0) {
    const ending = result.signal ?? `exit code ${String(result.status)}`;
    throw new Error(`${compiler} failed to compile ${SOURCE_PATH} (${ending}).`);
  }
  renameSync(builtPath, MATCH_COUNT_LIBRARY_PATH);
} finally {
  rmSync(scratchPath, { recursive: true, force: true });
}

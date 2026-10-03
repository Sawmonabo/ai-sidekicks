// Downloads the Electron binary at install time. It runs as `apps/desktop`'s `postinstall` and
// from `test:smoke`, so it lives in `scripts/` (invoked by name) rather than `build/` (steps that
// run during `pnpm build`).
//
// Why: since Electron 42 the `electron` package has no `postinstall` and ignores
// `ELECTRON_SKIP_BINARY_DOWNLOAD`; it downloads 120-160 MB on the first `require('electron')`.
// That lands inside a test's clock, or a developer's first `pnpm test`, where a download reads as
// a hang. Downloading at install puts it where it belongs.
//
// The seam: pnpm runs a workspace project's `postinstall` on a full install but not on a scoped
// install that excludes the project (the daemon-only CI legs), and `allowBuilds` gates only
// dependencies' scripts. The root `prepare` script was rejected because it runs on every install.
//
// The skip escape is ours: 41.6.1's `install.js` honored `ELECTRON_SKIP_BINARY_DOWNLOAD` and
// 44.5.1's does not. Honoring it here restores the contract CI recipes and Dockerfiles assume.
//
// The presence check mirrors upstream's `isInstalled()` (same three conditions, same order) as a
// fast path only: `install.js` performs the same check itself and repairs a partial dist.
//
// It reads no `process.argv` and is never imported, so it needs no entry guard, and the symlinked
// path mismatch a hand-written guard can hit cannot occur.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const SKIP_DOWNLOAD_VARIABLE = "ELECTRON_SKIP_BINARY_DOWNLOAD";
const LOG_PREFIX = "[materialize-electron]";

/**
 * Locates the installed `electron` package, or returns null when it is absent. Absent is not an
 * error: a production install links no devDependencies. Every other resolution failure is fatal.
 */
function findElectronPackageRoot(): string | null {
  const requireFromThisScript = createRequire(import.meta.url);
  try {
    return path.dirname(requireFromThisScript.resolve("electron/package.json"));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

/** The read failures that mean a file is not there. */
const MISSING_FILE_CODES: readonly unknown[] = ["ENOENT", "ENOTDIR"];

/**
 * Upstream's `isInstalled()`: the recorded dist version matches the package version, `path.txt`
 * exists, and the executable it names is on disk. A missing file means "not installed"; any other
 * read failure is thrown, since a download would not repair it.
 */
function isBinaryMaterialized(packageRoot: string): boolean {
  try {
    const packageManifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { version?: string };
    const distVersion = readFileSync(path.join(packageRoot, "dist", "version"), "utf8").replace(
      /^v/,
      "",
    );
    if (distVersion !== packageManifest.version) {
      return false;
    }
    const executableRelativePath = readFileSync(path.join(packageRoot, "path.txt"), "utf8");
    return existsSync(path.join(packageRoot, "dist", executableRelativePath));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && MISSING_FILE_CODES.includes(error.code)) {
      return false;
    }
    throw error;
  }
}

function materializeElectron(): void {
  const skipRequest = process.env[SKIP_DOWNLOAD_VARIABLE];
  if (skipRequest !== undefined && skipRequest !== "") {
    // Named, so a later "binary not materialized" refusal is not a mystery to whoever set this in
    // a Dockerfile.
    process.stdout.write(`${LOG_PREFIX} skipped — ${SKIP_DOWNLOAD_VARIABLE} is set.\n`);
    return;
  }

  const packageRoot = findElectronPackageRoot();
  if (packageRoot === null) {
    process.stdout.write(`${LOG_PREFIX} skipped — electron is not installed in this tree.\n`);
    return;
  }

  if (isBinaryMaterialized(packageRoot)) {
    process.stdout.write(`${LOG_PREFIX} already present.\n`);
    return;
  }

  const installEntryPoint = path.join(packageRoot, "install.js");
  if (!existsSync(installEntryPoint)) {
    // Run the vendor's entry point; the download, checksum and rosetta-arch fixup are not
    // reimplemented.
    process.stderr.write(`${LOG_PREFIX} electron ships no install.js at ${installEntryPoint}.\n`);
    process.exit(1);
  }

  process.stdout.write(`${LOG_PREFIX} downloading the Electron binary (this happens once)...\n`);
  const installResult = spawnSync(process.execPath, [installEntryPoint], {
    stdio: "inherit",
    cwd: packageRoot,
  });

  if (installResult.error !== undefined) {
    process.stderr.write(
      `${LOG_PREFIX} could not run install.js: ${installResult.error.message}\n`,
    );
    process.exit(1);
  }
  if (installResult.status !== 0) {
    process.stderr.write(
      `${LOG_PREFIX} install.js exited ${String(installResult.status)}` +
        `${installResult.signal === null ? "" : ` (signal ${installResult.signal})`}.\n`,
    );
    process.exit(1);
  }

  // Fail closed: `install.js` exiting 0 does not prove the binary is on disk.
  if (!isBinaryMaterialized(packageRoot)) {
    process.stderr.write(
      `${LOG_PREFIX} install.js exited 0 but the binary is still absent under ` +
        `${path.join(packageRoot, "dist")}.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`${LOG_PREFIX} done.\n`);
}

materializeElectron();

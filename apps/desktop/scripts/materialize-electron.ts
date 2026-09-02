// Materializes the Electron binary at install time.
//
// WHY IT IS IN `scripts/` AND NOT `build/`
// ----------------------------------------
// `build/` holds executables that run DURING `pnpm build` (`assert-webprefs.ts`);
// `scripts/` holds executables invoked BY NAME from a package script. This one
// is called by `postinstall` and by `test:smoke`, never by `build`, so it lives
// here. It is TypeScript run under `node --experimental-strip-types`, the same
// shape as its `build/` sibling — the package has one script language, not two,
// and no `.mjs` + hand-written `.d.mts` pair anywhere.
//
// WHY IT EXISTS
// -------------
// Electron 44 publishes NO `scripts` field — and the change is 42.0's, which 44
// merely inherits: `docs/breaking-changes.md` §Breaking API Changes (42.0)
// records both that `electron` "no longer downloads itself via `postinstall`
// script" and that `ELECTRON_SKIP_BINARY_DOWNLOAD` "is no longer supported, as
// its primary purpose was to prevent the `postinstall` script from running".
// Every line through 41.6.1 shipped `"postinstall": "node install.js"`; every
// registry manifest from 42 through 45 has no scripts at all, and binary
// acquisition moved to module scope in the package's `index.js`, which
// downloads on the first `require('electron')` if `path.txt` or the executable
// under `dist/` is missing.
//
// Left alone, that pushes a 120-160 MB download into whatever first needs
// Electron. For CI that is a test's clock; for a developer on a cold cache it
// is the first `pnpm test`, inside a vitest timeout, where a download reads as
// a hang and a slow network reads as a broken repo. An install-time download is
// a download in the place a download belongs.
//
// This runs as `apps/desktop`'s `postinstall`. That seam is not a guess:
// measured 2026-09-01 on pnpm 10.33.2, a full `pnpm install` runs a workspace
// project's `postinstall` with cwd set to that project, and a scoped install
// that excludes the project (`--filter "@ai-sidekicks/runtime-daemon..."`, the
// `native-prebuilds` CI job) does not run it at all — so the daemon-only legs
// stay fast without needing an opt-out. The root `prepare` script was rejected
// for exactly that reason: it runs on every install, including those legs.
//
// `pnpm-workspace.yaml`'s `allowBuilds` does not gate this. That setting
// governs DEPENDENCY packages' install scripts; a workspace project's own
// lifecycle scripts always run. (Verified in the same measurement — the probe
// postinstall fired with `better-sqlite3` denied in the same file.)
//
// THE SKIP ESCAPE IS OURS, NOT THE VENDOR'S
// -----------------------------------------
// 41.6.1's `install.js` opened with `if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) process.exit(0)`.
// 44.1.0's does not — the escape went out with the postinstall. Honouring it
// here restores the contract every CI recipe and Dockerfile in the ecosystem
// already assumes, and it is the only reason a caller can opt out at all now.
//
// IDEMPOTENCE
// -----------
// The presence check below mirrors upstream's own `isInstalled()` — the same
// three conditions, in the same order — rather than inventing a definition of
// "installed" that could disagree with the code that does the installing. It is
// a FAST PATH and not the correctness boundary: `install.js` performs the same
// check itself and no-ops, so a partially extracted dist is repaired by running
// it rather than skipped by us.
//
// NO ARGUMENTS, NO ENTRY GUARD, DELIBERATELY
// ------------------------------------------
// This script reads no `process.argv` and is never imported, so it carries no
// "invoked vs imported" discrimination and needs none — which also keeps it out
// of `tools/__tests__/entry-guard.test.mjs`'s derived set by the classifier's
// own definition rather than by an exemption. The bug that file pins requires
// comparing `import.meta.url` against `process.argv[1]`; a script that never
// reads argv cannot have it. Module resolution here goes through
// `createRequire(import.meta.url)`, which is the encoding-correct form by
// construction.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const SKIP_DOWNLOAD_VARIABLE = "ELECTRON_SKIP_BINARY_DOWNLOAD";
const LOG_PREFIX = "[materialize-electron]";

/**
 * Locate the installed `electron` package, or report that it is absent.
 *
 * Absent is NOT an error. A production install (`--prod`, or `NODE_ENV=production`)
 * links no devDependencies, so `electron` legitimately is not there and this
 * script's job — "if Electron is here, make its binary usable" — is vacuously
 * done. Failing the install in that case would be this script inventing a
 * requirement the package.json does not state.
 *
 * Every OTHER resolution failure is fatal, so a genuinely broken tree is not
 * quietly waved through by the same branch.
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

/**
 * Upstream's `isInstalled()`, re-expressed: the recorded dist version matches
 * the package version, `path.txt` exists, and the executable it names is on
 * disk. Any read failure means "not installed", which is also how upstream
 * treats it.
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
  } catch {
    return false;
  }
}

function materializeElectron(): void {
  const skipRequest = process.env[SKIP_DOWNLOAD_VARIABLE];
  if (skipRequest !== undefined && skipRequest !== "") {
    // Named, not silent: a later "Electron binary not materialized" refusal is
    // otherwise a mystery to whoever set this three layers up in a Dockerfile.
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
    // The vendor's own entry point is what we run; we do not reimplement the
    // download, the checksum verification, or the rosetta-arch fixup.
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

  // Fail closed. `install.js` exiting 0 is not evidence the binary is on disk —
  // reporting success here on an absent binary would restore exactly the
  // failure this script exists to remove, one layer further from its cause.
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

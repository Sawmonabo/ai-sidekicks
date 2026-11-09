// Packages the macOS app into `dist/`, signed with the identity `CSC_NAME` names. It builds the
// daemon and the command line in Cargo's release profile into `out/service/bin/`, which the app
// carries in its resources, then runs electron-builder with the app's bundle identifier, which the
// contracts own and `electron-builder.yml` never repeats. electron-builder signs every Mach-O in
// the app on its own, the two programs among them, and logs the name of the identity it signed
// with, so a renewal that changes it shows at build.

import { spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { APP_BUNDLE_IDENTIFIER } from "@ai-sidekicks/contracts/app-identity";
import { build, Platform } from "electron-builder";

/** The desktop package's root, where electron-builder reads its configuration. */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

/** The folder `electron-builder.yml` copies into the app's resources as `service/`. */
const SERVICE_FOLDER = path.join(PACKAGE_ROOT, "out", "service");

/** The Cargo binaries the app carries: the daemon main starts and the command line. */
const SERVICE_PROGRAM_NAMES = ["sidekicks-daemon", "sidekicks"] as const;

/** One line of Cargo's JSON output, as far as this script reads it. */
interface CargoMessage {
  readonly reason?: string;
  readonly target?: { readonly name?: string; readonly kind?: readonly string[] };
  readonly executable?: string | null;
}

/**
 * Builds the service programs in the release profile and copies them into `out/service/bin/`.
 * Throws when Cargo fails or names no executable for one of them.
 */
async function buildServicePrograms(): Promise<void> {
  const cargo = spawn(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--message-format=json-render-diagnostics",
      ...SERVICE_PROGRAM_NAMES.flatMap((name) => ["--bin", name]),
    ],
    { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  const exit = new Promise<number | null>((resolve, reject) => {
    cargo.once("error", reject);
    cargo.once("close", resolve);
  });
  // Cargo writes where each program landed, which the build cache may move out of `target/`.
  const executables = new Map<string, string>();
  for await (const line of createInterface({ input: cargo.stdout })) {
    const message = JSON.parse(line) as CargoMessage;
    const name = message.target?.name;
    if (
      message.reason === "compiler-artifact" &&
      message.target?.kind?.includes("bin") === true &&
      name !== undefined &&
      typeof message.executable === "string"
    ) {
      executables.set(name, message.executable);
    }
  }
  const code = await exit;
  if (code !== 0) {
    throw new Error(`cargo build of the service programs exited with ${String(code)}`);
  }
  const binFolder = path.join(SERVICE_FOLDER, "bin");
  await rm(SERVICE_FOLDER, { recursive: true, force: true });
  await mkdir(binFolder, { recursive: true });
  for (const name of SERVICE_PROGRAM_NAMES) {
    const executable = executables.get(name);
    if (executable === undefined) {
      throw new Error(`cargo build named no executable for ${name}`);
    }
    await copyFile(executable, path.join(binFolder, name));
  }
}

if ((process.env["CSC_NAME"]?.trim() ?? "") === "") {
  throw new Error(
    "CSC_NAME names no signing identity: set it to the name of the identity to sign with, as " +
      "`security find-identity -v -p codesigning` lists it",
  );
}
await buildServicePrograms();
await build({
  projectDir: PACKAGE_ROOT,
  targets: Platform.MAC.createTarget("dir"),
  // A packaged Mac app the daemon cannot admit by its signature never connects, so a name that
  // matches no identity fails the build rather than leaving the app unsigned.
  config: { appId: APP_BUNDLE_IDENTIFIER, forceCodeSigning: true },
});

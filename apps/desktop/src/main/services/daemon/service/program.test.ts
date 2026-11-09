// A wrong program path fails silently: the start succeeds or fails at once, and the app spends its
// five starts on nothing. So the development path is checked against the checkout's own Cargo
// workspace, and the packaged one against the resources folder the build fills.

import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

import { PACKAGE_ROOT } from "#test/helpers/fixture/bundle.js";

import { resolveServiceProgram } from "./program.js";

const DAEMON_PROGRAM_NAME =
  process.platform === "win32" ? "sidekicks-daemon.exe" : "sidekicks-daemon";

it("starts the Cargo workspace's development build of the daemon in a checkout", () => {
  const program = resolveServiceProgram({
    isPackaged: false,
    // Where the build writes main's entry, and where every launch, test or not, runs it from.
    mainBundleFolder: path.join(PACKAGE_ROOT, "out", "main"),
    resourcesPath: "/unused-in-a-checkout",
  });

  expect(program.args).toStrictEqual([]);
  expect(path.basename(program.command)).toBe(DAEMON_PROGRAM_NAME);
  const buildFolder = path.dirname(program.command);
  expect(path.basename(buildFolder)).toBe("debug");
  // `target/` sits beside the manifest that declares the Cargo workspace.
  const repositoryRoot = path.dirname(path.dirname(buildFolder));
  expect(readFileSync(path.join(repositoryRoot, "Cargo.toml"), "utf8")).toContain("[workspace]");
  expect(path.basename(path.dirname(buildFolder))).toBe("target");
});

it("starts the daemon in the installed app's resources", () => {
  const program = resolveServiceProgram({
    isPackaged: true,
    mainBundleFolder: "/unused-when-packaged",
    resourcesPath: "/Applications/AI Sidekicks.app/Contents/Resources",
  });

  expect(program).toStrictEqual({
    command: path.join(
      "/Applications/AI Sidekicks.app/Contents/Resources",
      "service",
      "bin",
      DAEMON_PROGRAM_NAME,
    ),
    args: [],
  });
});

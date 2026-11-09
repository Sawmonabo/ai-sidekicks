// Where the background service's program is. An installed app carries the service's bundle among
// its resources and starts its `sidekicks-daemon`; a development checkout starts the workspace's
// Cargo build of `sidekicks-daemon`.

import path from "node:path";

import type { InstallLocation } from "../../resource-file.js";

/** The command that starts the background service, and its arguments. */
export interface ServiceProgram {
  readonly command: string;
  readonly args: readonly string[];
}

/** The service bundle's folder inside the installed app's resources. */
const SERVICE_BUNDLE_FOLDER = "service";

/** The daemon program's file name on this system. */
const DAEMON_PROGRAM_NAME =
  process.platform === "win32" ? "sidekicks-daemon.exe" : "sidekicks-daemon";

/** The repository root, relative to main's built entry in `apps/desktop/out/main`. */
const REPOSITORY_ROOT_FROM_MAIN_BUNDLE = "../../../..";

/** The folder Cargo writes the workspace's development build to, under the repository root. */
const CARGO_DEVELOPMENT_BUILD_FOLDER = path.join("target", "debug");

/** The program that starts the background service for this app. */
export function resolveServiceProgram(location: InstallLocation): ServiceProgram {
  if (location.isPackaged) {
    return {
      command: path.join(location.resourcesPath, SERVICE_BUNDLE_FOLDER, "bin", DAEMON_PROGRAM_NAME),
      args: [],
    };
  }
  return {
    command: path.resolve(
      location.mainBundleFolder,
      REPOSITORY_ROOT_FROM_MAIN_BUNDLE,
      CARGO_DEVELOPMENT_BUILD_FOLDER,
      DAEMON_PROGRAM_NAME,
    ),
    args: [],
  };
}

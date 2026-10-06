// Where the background service's program is. An installed app carries the service's standalone
// bundle among its resources and starts its `sidekicks-daemon`; a development checkout starts the
// workspace's built daemon with the `node` on the person's path, as the command line does.

import path from "node:path";

import type { InstallLocation } from "../../resource-file.js";

/** The command that starts the background service, and its arguments. */
export interface ServiceProgram {
  readonly command: string;
  readonly args: readonly string[];
}

/** The service bundle's folder inside the installed app's resources. */
const SERVICE_BUNDLE_FOLDER = "service";

/** The program the service bundle starts the daemon with. */
const SERVICE_BUNDLE_PROGRAM = path.join("bin", "sidekicks-daemon");

/** The workspace daemon's built entry, relative to main's built entry. */
const WORKSPACE_DAEMON_ENTRY = "../../../../packages/runtime-daemon/dist/main.js";

/** The program that starts the background service for this app. */
export function resolveServiceProgram(location: InstallLocation): ServiceProgram {
  if (location.isPackaged) {
    return {
      command: path.join(location.resourcesPath, SERVICE_BUNDLE_FOLDER, SERVICE_BUNDLE_PROGRAM),
      args: [],
    };
  }
  return {
    command: "node",
    args: [path.resolve(location.mainBundleFolder, WORKSPACE_DAEMON_ENTRY)],
  };
}

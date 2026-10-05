// Where the background service's program is. An installed app carries the service's standalone
// bundle among its resources and starts its `sidekicks-daemon`; a development checkout starts the
// workspace's built daemon with the `node` on the person's path, as the command line does. The
// Windows start runs through the service's Windows half, not this program.

import path from "node:path";

/** The command that starts the background service, and its arguments. */
export interface ServiceProgram {
  readonly command: string;
  readonly args: readonly string[];
}

/** What the program is resolved from, each read off the running app. */
export interface ServiceProgramFacts {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /**
   * The folder holding main's built entry (`out/main/` in a development checkout). Not
   * `app.getAppPath()`, which is that same folder when Electron is handed the entry file itself,
   * as the test launches do, and the package's folder when it is handed the package.
   */
  readonly mainBundleFolder: string;
  /** `process.resourcesPath`: the installed app's resources folder. */
  readonly resourcesPath: string;
}

/** The service bundle's folder inside the installed app's resources. */
const SERVICE_BUNDLE_FOLDER = "service";

/** The program the service bundle starts the daemon with. */
const SERVICE_BUNDLE_PROGRAM = path.join("bin", "sidekicks-daemon");

/** The workspace daemon's built entry, relative to main's built entry. */
const WORKSPACE_DAEMON_ENTRY = "../../../../packages/runtime-daemon/dist/main.js";

/** The program that starts the background service for this app. */
export function resolveServiceProgram(facts: ServiceProgramFacts): ServiceProgram {
  if (facts.isPackaged) {
    return {
      command: path.join(facts.resourcesPath, SERVICE_BUNDLE_FOLDER, SERVICE_BUNDLE_PROGRAM),
      args: [],
    };
  }
  return { command: "node", args: [path.resolve(facts.mainBundleFolder, WORKSPACE_DAEMON_ENTRY)] };
}

// Where a file from the package's `resources/` folder is at run time. An installed app carries the
// folder's files beside its archive, in `process.resourcesPath`, since a platform dialog cannot
// read inside the archive; a development checkout reads them from the package, two folders above
// main's built entry (`out/main/`).

import path from "node:path";

/** Where the running app's files are, each fact read off the running app. */
export interface InstallLocation {
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

/** The package's `resources/` folder, relative to the folder holding main's built entry. */
const CHECKOUT_RESOURCES_FOLDER = "../../resources";

/** The path of `fileName` from the package's `resources/` folder, in this install. */
export function resolveResourceFile(fileName: string, location: InstallLocation): string {
  return location.isPackaged
    ? path.join(location.resourcesPath, fileName)
    : path.join(location.mainBundleFolder, CHECKOUT_RESOURCES_FOLDER, fileName);
}

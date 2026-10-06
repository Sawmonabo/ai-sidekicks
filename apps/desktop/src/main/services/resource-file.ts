// Where a file from the package's `resources/` folder is at run time. An installed app carries the
// folder's files beside its archive, in `process.resourcesPath`, since a platform dialog cannot read
// inside the archive; a development checkout reads them from the package, two folders above main's
// built entry (`out/main/`).

import path from "node:path";

import { app } from "electron";

/** The package's `resources/` folder, relative to the folder holding main's built entry. */
const CHECKOUT_RESOURCES_FOLDER = "../../resources";

/**
 * The path of `fileName` from the package's `resources/` folder, in this install. `mainBundleFolder`
 * is the folder holding main's built entry: `import.meta.dirname` of a module at the root of main.
 */
export function resourceFilePath(fileName: string, mainBundleFolder: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, fileName)
    : path.join(mainBundleFolder, CHECKOUT_RESOURCES_FOLDER, fileName);
}

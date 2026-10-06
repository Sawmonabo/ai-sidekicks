// Picks this operating system's form of the installed editors.

import type { InstalledEditors } from "./installed.js";
import { MacInstalledEditors } from "./mac.js";
import type { ProgramRunner } from "./program-runner.js";

/**
 * This operating system's form. Throws on a platform whose form is not built: Linux reads desktop
 * entries and Windows its own register, each built with that platform's form.
 */
export function installedEditorsFor(
  platform: NodeJS.Platform,
  runProgram: ProgramRunner,
): InstalledEditors {
  if (platform === "darwin") {
    return new MacInstalledEditors(runProgram);
  }
  throw new Error(`The installed editors cannot be read on ${platform} yet.`);
}

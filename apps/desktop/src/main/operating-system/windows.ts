// What main takes from Windows.

import { SystemLocaleClockReader } from "../bridge/machine-clock/reader.js";
import { ABOUT_IN_HELP_MENU } from "./about-in-help-menu.js";
import type { MainOperatingSystem } from "./contract.js";

/**
 * Windows: the system's own title strip, the app quits with its last window, About sits in a Help
 * menu, the region and clock are the system locale's, and a rename is on disk when it returns, so
 * there is no folder to flush.
 */
export const WINDOWS_MAIN_OPERATING_SYSTEM: MainOperatingSystem = {
  platform: "win32",
  machineClock: new SystemLocaleClockReader(),
  installedEditors: () => {
    throw new Error("The installed editors cannot be read on Windows yet.");
  },
  flushesFolderAfterRename: false,
  titleBar: { titleBarStyle: "default" },
  keepsRunningWithNoWindow: false,
  applicationMenu: ABOUT_IN_HELP_MENU,
  // Electron stops drawing frames for a hidden window here even with throttling off, so the
  // window is shown without activating the app.
  unobtrusiveReveal: "inactive",
  hasMenuBarIcon: false,
};

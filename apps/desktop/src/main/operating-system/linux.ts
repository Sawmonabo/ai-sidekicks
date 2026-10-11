// What main takes from Linux.

import { SystemLocaleClockReader } from "../bridge/machine-clock/reader.js";
import { ABOUT_IN_HELP_MENU } from "./about-in-help-menu.js";
import type { MainOperatingSystem } from "./contract.js";

/**
 * Linux: the system's own title strip, the app quits with its last window, About sits in a Help
 * menu, and the region and clock are the system locale's.
 */
export const LINUX_MAIN_OPERATING_SYSTEM: MainOperatingSystem = {
  platform: "linux",
  machineClock: new SystemLocaleClockReader(),
  installedEditors: () => {
    throw new Error("The installed editors cannot be read on Linux yet.");
  },
  flushesFolderAfterRename: true,
  titleBar: { titleBarStyle: "default" },
  keepsRunningWithNoWindow: false,
  applicationMenu: ABOUT_IN_HELP_MENU,
  // Runs under Xvfb in the test tiers, where an inactive reveal draws.
  unobtrusiveReveal: "inactive",
  hasMenuBarIcon: false,
};

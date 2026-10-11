// What main takes from Linux.

import type { MainOperatingSystem } from "./contract.js";
import { pcMainOperatingSystem } from "./pc.js";

/** Linux: what it shares with Windows, and a rename that needs its folder flushed to reach disk. */
export const LINUX_MAIN_OPERATING_SYSTEM: MainOperatingSystem = {
  ...pcMainOperatingSystem("Linux"),
  platform: "linux",
  flushesFolderAfterRename: true,
  // Runs under Xvfb in the test tiers, where an inactive reveal draws.
  ...(__TEST_TIER_BUILD__ ? { unobtrusiveWindows: { reveal: "inactive" } } : {}),
};

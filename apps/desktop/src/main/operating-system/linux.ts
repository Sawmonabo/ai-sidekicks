// What main takes from Linux.

import { resolveDaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import { createLinuxProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { linuxClipboardHost } from "../bridge/native/clipboard/linux.js";
import type { MainOperatingSystem } from "./contract.js";
import { pcMainOperatingSystem } from "./pc.js";

/** Linux: what it shares with Windows, and a rename that needs its folder flushed to reach disk. */
export const LINUX_MAIN_OPERATING_SYSTEM: MainOperatingSystem = {
  ...pcMainOperatingSystem("Linux"),
  platform: "linux",
  flushesFolderAfterRename: true,
  createProcessIdentityReader: createLinuxProcessIdentityReader,
  resolveDaemonRunFolder,
  clipboardHost: linuxClipboardHost,
  // Linux alone keeps a selection clipboard beside the system one.
  hasPrimarySelection: true,
  // Runs under Xvfb in the test tiers, where an inactive reveal draws.
  ...(__TEST_TIER_BUILD__ ? { unobtrusiveWindows: { reveal: "inactive" } } : {}),
};

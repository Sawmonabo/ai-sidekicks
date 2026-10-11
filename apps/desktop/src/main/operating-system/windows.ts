// What main takes from Windows.

import { refuseWindowsDaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import { createWindowsProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { windowsClipboardHost } from "../bridge/native/clipboard/windows.js";
import type { MainOperatingSystem } from "./contract.js";
import { pcMainOperatingSystem } from "./pc.js";

/**
 * Windows: what it shares with Linux, and a rename that is on disk when it returns, so there is no
 * folder to flush.
 */
export const WINDOWS_MAIN_OPERATING_SYSTEM: MainOperatingSystem = {
  ...pcMainOperatingSystem("Windows"),
  platform: "win32",
  flushesFolderAfterRename: false,
  createProcessIdentityReader: createWindowsProcessIdentityReader,
  resolveDaemonRunFolder: refuseWindowsDaemonRunFolder,
  clipboardHost: windowsClipboardHost,
  hasPrimarySelection: false,
  // With throttling off, Electron still stops drawing frames for a hidden window here
  // (electron/electron#31016), so the window is shown without activating the app.
  ...(__TEST_TIER_BUILD__ ? { unobtrusiveWindows: { reveal: "inactive" } } : {}),
};

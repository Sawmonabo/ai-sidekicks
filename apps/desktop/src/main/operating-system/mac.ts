// What main takes from macOS.

import { resolveDaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import { createMacProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { MacMachineClockReader } from "../bridge/machine-clock/mac.js";
import { MacInstalledEditors } from "../bridge/native/editors/mac.js";
import type { MainOperatingSystem } from "./contract.js";

/**
 * macOS: the console fills the window under the traffic lights, an app keeps running with no
 * window, About sits in the application menu, and the region and clock are read from the person's
 * own settings.
 */
export const MAC_MAIN_OPERATING_SYSTEM: MainOperatingSystem = {
  platform: "darwin",
  machineClock: new MacMachineClockReader(),
  installedEditors: (runProgram) => new MacInstalledEditors(runProgram),
  flushesFolderAfterRename: true,
  // The overlay hands the document the traffic lights' area as `env(titlebar-area-*)`, which is
  // empty in fullscreen, so the rail's width and top inset follow the buttons.
  titleBar: { titleBarStyle: "hiddenInset", titleBarOverlay: true },
  keepsRunningWithNoWindow: true,
  applicationMenu: {
    // Chrome's console keys: Electron's own row sits on Preview's `Inspect`.
    developerToolsAccelerator: "Alt+Command+J",
    // The panel shows `version` in parentheses; unset, a development build would show Electron's.
    aboutPanelOptions: (version) => ({ version }),
    // Spelled out because Electron's own application menu adds Services.
    leadingMenus: [
      {
        role: "appMenu",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
    ],
    trailingMenus: () => [],
  },
  hasMenuBarIcon: true,
  createProcessIdentityReader: createMacProcessIdentityReader,
  resolveDaemonRunFolder,
  // `show()` activates even an accessory app, so the window is never revealed; with throttling
  // off, Electron keeps drawing frames for a hidden window here (electron/electron#31016).
  ...(__TEST_TIER_BUILD__
    ? { unobtrusiveWindows: { reveal: "hidden", activationPolicy: "accessory" } }
    : {}),
};

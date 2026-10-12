// What main takes alike from Windows and Linux: the system's own title strip, an app that quits
// with its last window and keeps no menu-bar icon, the system locale's region and clock, About in a
// Help menu, and no form of the installed editors yet.

import { SystemLocaleClockReader } from "../bridge/machine-clock/reader.js";
import { resolveResourceFile } from "../services/resource-file.js";
import type { MainOperatingSystem } from "./contract.js";

/** What Windows and Linux supply main alike: all but the facts each system answers its own way. */
export type PcMainOperatingSystem = Omit<
  MainOperatingSystem,
  | "platform"
  | "flushesFolderAfterRename"
  | "createProcessIdentityReader"
  | "resolveDaemonRunFolder"
  | "clipboardHost"
  | "hasPrimarySelection"
  | "unobtrusiveWindows"
>;

/** The About panel's icon, which the package's `resources/` folder carries. */
const ABOUT_ICON_FILE = "icon.png";

/**
 * The parts Windows and Linux share, `systemName` naming the system as a person reads it in the
 * installed editors' refusal.
 */
export function pcMainOperatingSystem(systemName: string): PcMainOperatingSystem {
  return {
    machineClock: new SystemLocaleClockReader(),
    installedEditors: () => {
      throw new Error(`The installed editors cannot be read on ${systemName} yet.`);
    },
    titleBar: { titleBarStyle: "default" },
    keepsRunningWithNoWindow: false,
    applicationMenu: {
      // Chrome's console keys, as Ctrl+Shift+I is the inspector's while the terminal has focus.
      developerToolsAccelerator: "Control+Shift+J",
      aboutPanelOptions: (_version, location) => ({
        iconPath: resolveResourceFile(ABOUT_ICON_FILE, location),
      }),
      leadingMenus: [],
      // The row names the app, since Electron's own reads a bare "About" on Linux.
      trailingMenus: (appName) => [
        { role: "help", submenu: [{ role: "about", label: `About ${appName}` }] },
      ],
    },
    hasMenuBarIcon: false,
  };
}
